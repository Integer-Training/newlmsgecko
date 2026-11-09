import { listTutorsForLearnerInOrg } from '@cio/db/queries/allocation';
import {
  claimDueReviews,
  claimGatewayReadyNow,
  claimOverdueTasks,
  deleteUploadRows,
  getEnrolmentLearnerIds,
  insertFirstReviewIfNone,
  listGatewayReadyCandidates,
  listOrgAdminIds,
  listEnrolmentsNeedingFirstReview,
  listReferencedUploadKeys,
  listUploadsForCleanup,
  markUploadsAttached
} from '@cio/db/queries/apprenticeship';
import { insertNotification } from '@cio/db/queries/comms';
import {
  APPR_DEFAULT_GATEWAY_CHECKLIST,
  APPR_DEFAULT_SETTINGS,
  APPR_REVIEW_DUE_NOTICE_DAYS,
  APPR_UPLOAD_GRACE_HOURS
} from '@cio/utils/constants/apprenticeship';
import { addDays, firstReviewDate, gatewayState, otjTargetMinutes } from '@cio/utils/functions/apprenticeship-progress';

import { getStorageConfig } from '../../config/storage';
import { deleteFromS3 } from '../../utils/s3';

// Gecko Apprenticeships — the daily maintenance jobs (run from apps/jobs/src/workers/maintenance.ts). Every function
// is idempotent and returns counts only (nothing identifying is logged). Notifications are written straight to the
// notification table (in-app only — the same rows emitNotification writes; there is no email leg for these).

const todayIso = (now: Date = new Date()) => now.toISOString().slice(0, 10);

export interface UploadCleanupResult {
  /** Rows picked up across all batches. */
  selected: number;
  /** Storage objects deleted AND their tracking rows removed. */
  deleted: number;
  /** Rows whose key is still listed on a live record — kept (and re-marked attached). */
  keptReferenced: number;
  /** Rows whose storage delete failed — kept, retried on the next run. */
  failed: number;
}

/**
 * Delete abandoned / dropped evidence and brief files from the documents bucket: rows never attached and older than
 * APPR_UPLOAD_GRACE_HOURS, or removed from a record longer ago than that. A tracking row is deleted ONLY after its
 * object was deleted successfully (S3 reports success for an already-missing object, so reruns are harmless), and a
 * key still referenced by any live record is never deleted.
 */
export async function runApprUploadCleanup(
  opts: { now?: Date; batchSize?: number; maxBatches?: number } = {}
): Promise<UploadCleanupResult> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? 200;
  const maxBatches = opts.maxBatches ?? 25;
  const cutoff = new Date(now.getTime() - APPR_UPLOAD_GRACE_HOURS * 3_600_000).toISOString();
  const bucket = getStorageConfig().bucketDocuments;

  const result: UploadCleanupResult = { selected: 0, deleted: 0, keptReferenced: 0, failed: 0 };
  const skipIds: string[] = [];

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await listUploadsForCleanup(cutoff, batchSize, skipIds);
    if (rows.length === 0) break;
    result.selected += rows.length;

    const referenced = await listReferencedUploadKeys(rows.map((r) => r.key));
    const stillUsed = rows.filter((r) => referenced.has(r.key));
    if (stillUsed.length > 0) {
      await markUploadsAttached(stillUsed.map((r) => r.key));
      result.keptReferenced += stillUsed.length;
    }

    const deletedIds: string[] = [];
    for (const row of rows) {
      if (referenced.has(row.key)) continue;
      // Re-check right before the delete: a record may have claimed the key since the batch check.
      if ((await listReferencedUploadKeys([row.key])).has(row.key)) {
        await markUploadsAttached([row.key]);
        result.keptReferenced += 1;
        continue;
      }
      const res = await deleteFromS3({ Bucket: bucket, Key: row.key });
      if (res.success) deletedIds.push(row.id);
      else {
        result.failed += 1;
        skipIds.push(row.id);
      }
    }
    await deleteUploadRows(deletedIds);
    result.deleted += deletedIds.length;

    if (rows.length < batchSize) break;
  }
  return result;
}

async function notifyAll(
  userIds: string[],
  type: 'appr.task.overdue' | 'appr.review.due' | 'appr.gateway.ready',
  entityType: string,
  entityId: string
) {
  let sent = 0;
  for (const userId of new Set(userIds)) {
    try {
      await insertNotification({ userId, type, entityType, entityId });
      sent += 1;
    } catch (error) {
      console.error(`[apprenticeship] ${type} notification failed (non-fatal):`, error);
    }
  }
  return sent;
}

/**
 * Tasks whose due date has passed and are not complete: tell the apprentice and their allocated tutor(s) ONCE. The
 * claim (overdue_notified_at) happens before sending, so a rerun or a concurrent run cannot notify twice.
 */
export async function runApprTaskOverdueScan(opts: { today?: string; batchSize?: number; maxBatches?: number } = {}) {
  const today = opts.today ?? todayIso();
  const batchSize = opts.batchSize ?? 200;
  let claimedTotal = 0;
  let notifications = 0;
  for (let batch = 0; batch < (opts.maxBatches ?? 25); batch += 1) {
    const claimed = await claimOverdueTasks(today, batchSize);
    for (const task of claimed) {
      const tutors = await listTutorsForLearnerInOrg(task.learnerId, task.organizationId);
      notifications += await notifyAll(
        [task.learnerId, ...tutors.map((tu) => tu.tutorId)],
        'appr.task.overdue',
        'appr_task',
        task.id
      );
    }
    claimedTotal += claimed.length;
    if (claimed.length < batchSize) break;
  }
  return { tasks: claimedTotal, notifications };
}

/**
 * Reviews (SCHEDULED / DRAFT) falling due within APPR_REVIEW_DUE_NOTICE_DAYS — or already past due — tell the learner's
 * allocated tutor(s) ONCE (due_notified_at is claimed first; rescheduling a review clears it).
 */
export async function runApprReviewDueScan(opts: { today?: string; batchSize?: number; maxBatches?: number } = {}) {
  const today = opts.today ?? todayIso();
  // First make sure every eligible enrolment has a review to be reminded about (idempotent back-fill).
  const firstReviewsCreated = await runApprFirstReviewBackfill({ today });
  // And any "ready for gateway" alert that a non-claiming recompute left unsent.
  const gatewayReady = await runApprGatewayReadyScan();
  const horizon = addDays(today, APPR_REVIEW_DUE_NOTICE_DAYS) ?? today;
  const batchSize = opts.batchSize ?? 200;
  let claimedTotal = 0;
  let notifications = 0;
  for (let batch = 0; batch < (opts.maxBatches ?? 25); batch += 1) {
    const claimed = await claimDueReviews(horizon, batchSize);
    const learners = await getEnrolmentLearnerIds(claimed.map((c) => c.enrolmentId));
    for (const review of claimed) {
      const learnerId = learners.get(review.enrolmentId);
      if (!learnerId) continue;
      const tutors = await listTutorsForLearnerInOrg(learnerId, review.organizationId);
      notifications += await notifyAll(
        tutors.map((tu) => tu.tutorId),
        'appr.review.due',
        'appr_review',
        review.id
      );
    }
    claimedTotal += claimed.length;
    if (claimed.length < batchSize) break;
  }
  return { reviews: claimedTotal, notifications, firstReviewsCreated, gatewayReadyNotified: gatewayReady.flagged };
}

/**
 * Create an enrolment's first SCHEDULED review when it has none (needs a start date; not for achieved learners).
 * Idempotent: the insert is a single "only if no review exists" statement. Returns true when it created one.
 */
export async function ensureFirstReview(
  enrolment: { id: string; organizationId: string; startDate: string | null; achievedAt?: string | null },
  intervalWeeks: number,
  opts: { today?: string; createdBy?: string | null } = {}
): Promise<boolean> {
  if (!enrolment.startDate || enrolment.achievedAt) return false;
  const scheduledDate = firstReviewDate(enrolment.startDate, intervalWeeks, opts.today ?? todayIso());
  if (!scheduledDate) return false;
  return insertFirstReviewIfNone({
    organizationId: enrolment.organizationId,
    enrolmentId: enrolment.id,
    scheduledDate,
    createdBy: opts.createdBy ?? null
  });
}

/** Daily back-fill: first review for every enrolment that has a start date but no review yet. */
export async function runApprFirstReviewBackfill(opts: { today?: string; batchSize?: number } = {}) {
  const rows = await listEnrolmentsNeedingFirstReview(opts.batchSize ?? 500);
  let created = 0;
  for (const r of rows) {
    if (await ensureFirstReview(r, r.reviewIntervalWeeks, { today: opts.today })) created += 1;
  }
  return created;
}

/**
 * Safety net for "ready for gateway": readiness first reached by a recompute that does not claim (a programme-level one)
 * leaves the learner ready but unflagged. For each such enrolment the flag is claimed FIRST (so a rerun or a concurrent
 * evidence-triggered claim cannot double-send), then the allocated tutors (this org) and the org admins are told.
 * Readiness uses the progress cache (the same values the last recompute wrote) with the shared gateway rule.
 */
export async function runApprGatewayReadyScan(opts: { batchSize?: number } = {}) {
  const candidates = await listGatewayReadyCandidates(opts.batchSize ?? 500);
  let flagged = 0;
  let notifications = 0;
  for (const c of candidates) {
    const checklist =
      c.gatewayChecklist && c.gatewayChecklist.length > 0 ? c.gatewayChecklist : APPR_DEFAULT_GATEWAY_CHECKLIST;
    const target = otjTargetMinutes({
      start: c.startDate,
      end: c.plannedEndDate,
      contractedHoursWeek: c.contractedHoursWeek,
      overrideMinutes: c.otjTargetMinutesOverride,
      settings: {
        otjFactor: c.otjFactor ?? APPR_DEFAULT_SETTINGS.otjFactor,
        otjWeeklyCapHours: c.otjWeeklyCapHours ?? APPR_DEFAULT_SETTINGS.otjWeeklyCapHours
      }
    });
    const { ready } = gatewayState({
      checklist,
      manual: c.gatewayItems ?? {},
      unitsTotal: c.unitsTotal,
      unitsComplete: c.unitsComplete,
      otjMinutes: c.otjMinutes,
      otjTargetMinutes: target
    });
    if (!ready || !(await claimGatewayReadyNow(c.id))) continue;
    flagged += 1;
    const [tutors, admins] = await Promise.all([
      listTutorsForLearnerInOrg(c.learnerId, c.organizationId),
      listOrgAdminIds(c.organizationId)
    ]);
    notifications += await notifyAll(
      [...tutors.map((t) => t.tutorId), ...admins],
      'appr.gateway.ready',
      'appr_enrolment',
      c.id
    );
  }
  return { candidates: candidates.length, flagged, notifications };
}
