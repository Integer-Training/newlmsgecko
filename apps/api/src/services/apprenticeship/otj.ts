import { AppError, ErrorCodes } from '@api/utils/errors';
import {
  assertEnrolmentWritable,
  assertStaff,
  getEnrolmentForActor,
  isStaff,
  requireAuthed
} from '@api/services/apprenticeship/access';
import { resolveApprenticeship } from '@api/services/apprenticeship/enrolment';
import {
  notifyGatewayReadyOrRelease,
  notifyOtjReviewed,
  notifyOtjSubmitted,
  notifySafely
} from '@api/services/apprenticeship/notifications';
import { lockApprenticeshipPair } from '@api/services/apprenticeship/pair-lock';
import { recomputeEnrolment, todayIso } from '@api/services/apprenticeship/progress';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import { runInTransaction } from '@cio/db/drizzle';
import {
  deleteOtjLog,
  getApprSettings,
  getOtjLog,
  insertOtjLog,
  listOtjEvidenceRows,
  listOtjLogQueue,
  listOtjLogs,
  lockOtjLog,
  updateOtjLog,
  type ApprEnrolmentRow
} from '@cio/db/queries/apprenticeship';
import {
  otjCompletionPct,
  otjExpectedMinutes,
  otjTargetMinutes,
  progressStatus
} from '@cio/utils/functions/apprenticeship-progress';
import type { ZOtjListQuery, ZOtjLogCreate, ZOtjLogReview, ZOtjLogUpdate } from '@cio/utils/validation/apprenticeship';
import type * as z from 'zod';

type OtjListQueryInput = z.infer<typeof ZOtjListQuery>;
type OtjLogCreateInput = z.output<typeof ZOtjLogCreate>;
type OtjLogUpdateInput = z.infer<typeof ZOtjLogUpdate>;
type OtjLogReviewInput = z.infer<typeof ZOtjLogReview>;

// Gecko Apprenticeships Deploy 3 — the off-the-job training log. Logs are ALWAYS stored on the CARRIER enrolment of the
// apprenticeship (either half of a Diploma + Standard pair may be passed in the URL). Every write recomputes the carrier's
// cache (appr_enrolment.otj_minutes) inside the same transaction through recomputeEnrolment; the cache = OTJ evidence
// (both homes) + VALIDATED is_otj log minutes (sumValidatedOtjLogMinutes, added in progress.ts → buildEnrolmentProgress).

export type OtjRowStatus = 'SUBMITTED' | 'VALIDATED' | 'REJECTED';

export interface OtjRow {
  kind: 'LOG' | 'EVIDENCE';
  id: string;
  title: string;
  minutes: number;
  isOtj: boolean;
  /** YYYY-MM-DD. Logs: log_date. Evidence: reviewed_at, falling back to created_at. */
  date: string;
  status: OtjRowStatus;
  byName: string | null;
  homeEnrolmentId: string;
  details?: string;
  reviewNote?: string | null;
  /** The date falls outside the carrier's start / planned-end window (allowed, but flagged). */
  outsideWindow: boolean;
}

type Tx = Parameters<Parameters<typeof runInTransaction>[0]>[0];

const notFound = () => new AppError('Off-the-job log not found', ErrorCodes.NOT_FOUND, 404);
const forbidden = (message: string) => new AppError(message, ErrorCodes.FORBIDDEN, 403);
const badRequest = (message: string, field?: string) => new AppError(message, ErrorCodes.VALIDATION_ERROR, 400, field);
const staleReview = () =>
  new AppError('This log was changed by someone else, reload and try again', ErrorCodes.CONFLICT, 409);

const EVIDENCE_STATUS_TO_ROW: Record<string, OtjRowStatus> = {
  SUBMITTED: 'SUBMITTED',
  ACCEPTED: 'VALIDATED',
  REFERRED: 'REJECTED'
};

function isOutsideWindow(date: string, carrier: Pick<ApprEnrolmentRow, 'startDate' | 'plannedEndDate'>): boolean {
  if (carrier.startDate && date < carrier.startDate) return true;
  if (carrier.plannedEndDate && date > carrier.plannedEndDate) return true;
  return false;
}

/** Once the gateway is confirmed the apprentice is at end-point assessment: they can no longer add or change logs. */
function assertLearnerMayWrite(actor: Actor, carrier: { gatewayPassedAt?: string | null } | null | undefined) {
  if (!isStaff(actor) && carrier?.gatewayPassedAt) {
    throw forbidden('Your apprenticeship is at end-point assessment');
  }
}

function assertNotFuture(logDate: string) {
  if (logDate > todayIso()) throw badRequest('The log date cannot be in the future', 'logDate');
}

/** Resolve the apprenticeship the caller may see from either half's id (404 when not visible). */
async function resolveForActor(actor: Actor, enrolmentId: string) {
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  return resolveApprenticeship(enrolment.id);
}

/** Load a log + its apprenticeship, both scoped to what the caller may see (404 otherwise). */
async function loadLogForActor(actor: Actor, logId: string) {
  const row = await getOtjLog(logId);
  if (!row) throw notFound();
  try {
    return { row, ...(await resolveForActor(actor, row.enrolmentId)) };
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 404) throw notFound();
    throw error;
  }
}

function audit(actor: Actor, action: string, logId: string, metadata: Record<string, unknown> = {}) {
  return recordAudit({ actor, action, entityType: 'appr_otj_log', entityId: logId, metadata });
}

/** Recompute the carrier's cache in the caller's transaction; claims the gateway-ready flag like evidence writes do. */
function recomputeCarrier(tx: Tx, carrierId: string) {
  return recomputeEnrolment(tx, carrierId, { claimGatewayReady: true });
}

async function notifyReady(
  detail: { gatewayReadyClaimed?: boolean } | null | undefined,
  carrier: Pick<ApprEnrolmentRow, 'id' | 'learnerId' | 'organizationId'>
) {
  if (!detail?.gatewayReadyClaimed) return;
  await notifyGatewayReadyOrRelease({
    enrolmentId: carrier.id,
    learnerId: carrier.learnerId,
    organizationId: carrier.organizationId
  });
}

// ── Read ──

export async function getOtj(actor: Actor, enrolmentId: string, query: OtjListQueryInput = {}) {
  const { carrier, component } = await resolveForActor(actor, enrolmentId);
  const programmeIds = [carrier.programmeId, ...(component ? [component.programmeId] : [])];
  const [logs, evidence, settings] = await Promise.all([
    listOtjLogs(carrier.id),
    listOtjEvidenceRows(programmeIds, carrier.learnerId),
    getApprSettings(carrier.organizationId)
  ]);

  const homeByProgramme = new Map<string, string>([[carrier.programmeId, carrier.id]]);
  if (component) homeByProgramme.set(component.programmeId, component.id);

  const rows: OtjRow[] = [
    ...logs.map<OtjRow>((l) => ({
      kind: 'LOG',
      id: l.id,
      title: l.title,
      minutes: l.minutes,
      isOtj: l.isOtj,
      date: l.logDate,
      status: l.status as OtjRowStatus,
      byName: l.byName,
      homeEnrolmentId: carrier.id,
      details: l.details,
      reviewNote: l.reviewNote,
      outsideWindow: isOutsideWindow(l.logDate, carrier)
    })),
    ...evidence.map<OtjRow>((e) => {
      const date = (e.reviewedAt ?? e.createdAt).slice(0, 10);
      return {
        kind: 'EVIDENCE',
        id: e.id,
        title: e.title,
        minutes: e.minutes,
        isOtj: true,
        date,
        status: EVIDENCE_STATUS_TO_ROW[e.status] ?? 'SUBMITTED',
        byName: e.byName,
        homeEnrolmentId: homeByProgramme.get(e.programmeId) ?? carrier.id,
        details: e.details,
        outsideWindow: isOutsideWindow(date, carrier)
      };
    })
  ].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));

  // Only validated time counts: accepted OTJ evidence + VALIDATED is_otj logs. Submitted OTJ time is "waiting".
  let doneMinutes = 0;
  let pendingMinutes = 0;
  for (const r of rows) {
    if (!r.isOtj) continue;
    if (r.status === 'VALIDATED') doneMinutes += r.minutes;
    else if (r.status === 'SUBMITTED') pendingMinutes += r.minutes;
  }
  const targetMinutes = otjTargetMinutes({
    start: carrier.startDate,
    end: carrier.plannedEndDate,
    contractedHoursWeek: carrier.contractedHoursWeek,
    overrideMinutes: carrier.otjTargetMinutesOverride,
    settings
  });
  const expectedMinutes = otjExpectedMinutes(targetMinutes, carrier.startDate, carrier.plannedEndDate, todayIso());
  const donePct = targetMinutes ? Math.floor((doneMinutes / targetMinutes) * 100) : null;
  const expectedPct =
    targetMinutes && expectedMinutes !== null ? Math.round((expectedMinutes / targetMinutes) * 100) : null;
  const source =
    carrier.otjTargetMinutesOverride !== null && carrier.otjTargetMinutesOverride !== undefined
      ? ('OVERRIDE' as const)
      : targetMinutes !== null
        ? ('CALCULATED' as const)
        : ('NOT_SET' as const);

  return {
    carrierEnrolmentId: carrier.id,
    summary: {
      doneMinutes,
      expectedMinutes,
      targetMinutes,
      completionPct: otjCompletionPct(doneMinutes, targetMinutes),
      status: progressStatus(donePct, expectedPct, settings),
      source,
      contractedHoursWeek: carrier.contractedHoursWeek,
      pendingMinutes,
      // What the normal calculation (contracted hours × org OTJ settings) would give, shown to staff beside an override.
      calculatedMinutes: otjTargetMinutes({
        start: carrier.startDate,
        end: carrier.plannedEndDate,
        contractedHoursWeek: carrier.contractedHoursWeek,
        settings
      })
    },
    rows: query.status ? rows.filter((r) => r.status === query.status) : rows
  };
}

// ── Writes ──

export async function createOtjLog(actor: Actor, enrolmentId: string, input: OtjLogCreateInput) {
  const a = requireAuthed(actor);
  const { carrier, component } = await resolveForActor(a, enrolmentId);
  await assertEnrolmentWritable(carrier);
  assertLearnerMayWrite(a, carrier);
  assertNotFuture(input.logDate);

  const status: OtjRowStatus = isStaff(a) && input.status === 'VALIDATED' ? 'VALIDATED' : 'SUBMITTED';
  const now = new Date().toISOString();

  const result = await runInTransaction(async (tx) => {
    // Re-check the end-point-assessment lock under the pair lock: a gateway confirmed meanwhile wins.
    assertLearnerMayWrite(a, (await lockApprenticeshipPair(tx, carrier.id)).carrier);
    const row = await insertOtjLog(tx, {
      organizationId: carrier.organizationId,
      enrolmentId: carrier.id,
      learnerId: carrier.learnerId,
      title: input.title,
      details: input.details ?? '',
      logDate: input.logDate,
      minutes: input.minutes,
      isOtj: input.isOtj,
      status,
      reviewedBy: status === 'VALIDATED' ? a.userId : null,
      reviewedAt: status === 'VALIDATED' ? now : null,
      createdBy: a.userId
    });
    return { row, detail: await recomputeCarrier(tx, carrier.id) };
  });

  await notifyReady(result.detail, carrier);
  await audit(a, 'appr.otj.created', result.row.id, { minutes: input.minutes, isOtj: input.isOtj, status });
  if (status === 'SUBMITTED') {
    await notifySafely('otj submitted', () =>
      notifyOtjSubmitted({
        carrierEnrolmentId: carrier.id,
        componentEnrolmentId: component?.id,
        learnerId: carrier.learnerId,
        exceptUserId: a.userId
      })
    );
  }
  return result.row;
}

export async function updateOtjLogEntry(actor: Actor, logId: string, input: OtjLogUpdateInput) {
  const a = requireAuthed(actor);
  const { row, carrier, component } = await loadLogForActor(a, logId);
  await assertEnrolmentWritable(carrier);
  const staff = isStaff(a);

  if (!staff) {
    if (row.learnerId !== a.userId) throw notFound();
    assertLearnerMayWrite(a, carrier);
    if (row.status === 'VALIDATED') throw forbidden('A validated log can no longer be edited');
  }
  if (input.logDate) assertNotFuture(input.logDate);

  // A learner editing a REJECTED log resubmits it.
  const resubmit = !staff && row.status === 'REJECTED';
  const patch = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.details !== undefined ? { details: input.details } : {}),
    ...(input.logDate !== undefined ? { logDate: input.logDate } : {}),
    ...(input.minutes !== undefined ? { minutes: input.minutes } : {}),
    ...(input.isOtj !== undefined ? { isOtj: input.isOtj } : {}),
    ...(resubmit ? { status: 'SUBMITTED', reviewNote: null, reviewedBy: null, reviewedAt: null } : {})
  };

  const result = await runInTransaction(async (tx) => {
    // Lock order everywhere: the pair's enrolments (by id) FIRST, then the log row.
    assertLearnerMayWrite(a, (await lockApprenticeshipPair(tx, carrier.id)).carrier);
    const locked = await lockOtjLog(tx, logId);
    if (!locked) throw notFound();
    // A tutor may have validated it since we read it: the learner rule is re-applied under the lock.
    if (!staff && locked.status === 'VALIDATED') throw staleReview();
    const updated = await updateOtjLog(tx, logId, patch);
    if (!updated) throw notFound();
    return { row: updated, detail: await recomputeCarrier(tx, carrier.id) };
  });

  await notifyReady(result.detail, carrier);
  await audit(a, 'appr.otj.updated', logId, { fields: Object.keys(input), resubmitted: resubmit });
  if (resubmit) {
    await notifySafely('otj resubmitted', () =>
      notifyOtjSubmitted({
        carrierEnrolmentId: carrier.id,
        componentEnrolmentId: component?.id,
        learnerId: carrier.learnerId,
        exceptUserId: a.userId
      })
    );
  }
  return result.row;
}

/** What a review decision moves a log to, or the error explaining why it is not allowed. Pure. */
export function otjReviewTransition(
  current: OtjRowStatus,
  decision: OtjLogReviewInput['decision'],
  isAdmin: boolean
): OtjRowStatus {
  if (decision === 'VALIDATE') {
    if (current === 'VALIDATED') throw badRequest('This log is already validated');
    return 'VALIDATED';
  }
  if (decision === 'REJECT') {
    if (current === 'REJECTED') throw badRequest('This log is already rejected');
    if (current === 'VALIDATED' && !isAdmin) throw forbidden('Only an admin can reverse a validated log');
    return 'REJECTED';
  }
  // REOPEN: back to SUBMITTED.
  if (current === 'SUBMITTED') throw badRequest('This log is already awaiting validation');
  if (current === 'VALIDATED' && !isAdmin) throw forbidden('Only an admin can reopen a validated log');
  return 'SUBMITTED';
}

export async function reviewOtjLog(actor: Actor, logId: string, input: OtjLogReviewInput) {
  const a = assertStaff(actor);
  const { row, carrier } = await loadLogForActor(a, logId);
  await assertEnrolmentWritable(carrier);
  const isAdmin = a.role === 'ADMIN';
  // Fail fast on a stale view; re-checked under the row lock below.
  if (row.status !== input.expectedStatus) throw staleReview();

  const result = await runInTransaction(async (tx) => {
    // Same order as every other writer: the pair's enrolments first, then the log row.
    await lockApprenticeshipPair(tx, carrier.id);
    const locked = await lockOtjLog(tx, logId);
    if (!locked) throw notFound();
    if (locked.status !== input.expectedStatus) throw staleReview();
    const next = otjReviewTransition(locked.status as OtjRowStatus, input.decision, isAdmin);
    const reviewed = next !== 'SUBMITTED';
    const updated = await updateOtjLog(tx, logId, {
      status: next,
      reviewNote: reviewed ? (input.note ?? null) : null,
      reviewedBy: reviewed ? a.userId : null,
      reviewedAt: reviewed ? new Date().toISOString() : null
    });
    if (!updated) throw notFound();
    return { row: updated, from: locked.status, detail: await recomputeCarrier(tx, carrier.id) };
  });

  await notifyReady(result.detail, carrier);
  await audit(a, 'appr.otj.reviewed', logId, { decision: input.decision, from: result.from, to: result.row.status });
  if (result.row.status === 'VALIDATED' || result.row.status === 'REJECTED') {
    const outcome = result.row.status;
    await notifySafely('otj reviewed', async () => {
      const stillSubmitted = await listOtjLogs(carrier.id, 'SUBMITTED');
      await notifyOtjReviewed({
        carrierEnrolmentId: carrier.id,
        learnerId: carrier.learnerId,
        outcome,
        remainingSubmitted: stillSubmitted.length
      });
    });
  }
  return result.row;
}

export async function deleteOtjLogEntry(actor: Actor, logId: string) {
  const a = requireAuthed(actor);
  const { row, carrier } = await loadLogForActor(a, logId);
  await assertEnrolmentWritable(carrier);
  const staff = isStaff(a);

  // Learner: own, while SUBMITTED. Staff in reach: not VALIDATED (an admin may remove those).
  const mayDelete = (status: string) => (staff ? status !== 'VALIDATED' || a.role === 'ADMIN' : status === 'SUBMITTED');
  if (!staff) {
    if (row.learnerId !== a.userId) throw notFound();
    assertLearnerMayWrite(a, carrier);
  }
  if (!mayDelete(row.status)) {
    throw forbidden(
      staff ? 'Only an admin can delete a validated log' : 'Only a log that is still awaiting validation can be deleted'
    );
  }

  const detail = await runInTransaction(async (tx) => {
    assertLearnerMayWrite(a, (await lockApprenticeshipPair(tx, carrier.id)).carrier);
    const locked = await lockOtjLog(tx, logId);
    if (!locked) throw notFound();
    if (!mayDelete(locked.status)) throw staleReview();
    await deleteOtjLog(tx, logId);
    return recomputeCarrier(tx, carrier.id);
  });

  await notifyReady(detail, carrier);
  await audit(a, 'appr.otj.deleted', logId, { minutes: row.minutes, status: row.status });
  return { id: logId };
}

// ── Cross-learner queue (To mark → "OTJ logs") ──

/** Log entries awaiting action across learners, oldest first (cap 500). Admin = org; tutor = learners in reach. */
export async function listOtjQueue(actor: Actor, query: { status?: OtjRowStatus }) {
  const a = assertStaff(actor);
  return listOtjLogQueue({
    organizationId: a.orgId,
    status: query.status ?? 'SUBMITTED',
    restrictToTutorId: a.role === 'TUTOR' ? a.userId : undefined
  });
}
