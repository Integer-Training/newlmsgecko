import { AppError, ErrorCodes } from '@api/utils/errors';
import {
  assertStaff,
  canAccessLearner,
  getEnrolmentForActor,
  isStaff,
  requireAuthed
} from '@api/services/apprenticeship/access';
import { ensureFirstReview } from '@cio/core/services/apprenticeship/maintenance';
import { toProgressSummary } from '@api/services/apprenticeship/enrolment';
import { notifyReviewReadyToSign, notifySafely } from '@api/services/apprenticeship/notifications';
import { buildEnrolmentProgress, todayIso } from '@api/services/apprenticeship/progress';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import { runInTransaction } from '@cio/db/drizzle';
import {
  countOpenReviews,
  getApprEnrolment,
  getApprProgramme,
  getApprReview,
  insertApprReview,
  listReviewsForEnrolment,
  updateApprReviewIfUnchanged,
  type ApprReviewRow
} from '@cio/db/queries/apprenticeship';
import { APPR_REVIEW_STATUS_LABELS, type ApprReviewStatus } from '@cio/utils/constants/apprenticeship';
import { firstReviewDate, isReviewOverdue, reviewFullySigned } from '@cio/utils/functions/apprenticeship-progress';
import type { ReviewCreateInput, ReviewSignInput, ReviewUpdateInput } from '@cio/utils/validation/apprenticeship';

// Gecko Apprenticeships — progress reviews (every programme.reviewIntervalWeeks). Lifecycle:
//   SCHEDULED → DRAFT → AWAITING_SIGNATURES → COMPLETE (automatic on the last of the three signatures), or CANCELLED.
// Locking: once ANY signature exists the review's fields are frozen for staff; the only write left is the learner's own
// comment, before they sign. COMPLETE / CANCELLED are final. Every write is conditional on the updatedAt that was read
// (and signatures on the signature still being empty), so concurrent edits / signs surface as 409, never overwrite.
// The employer's signature is recorded by staff "on behalf" (name + who recorded it) until employer access exists.

const notFound = () => new AppError('Review not found', ErrorCodes.NOT_FOUND, 404);
const badRequest = (message: string, field?: string) => new AppError(message, ErrorCodes.VALIDATION_ERROR, 400, field);
const conflict = (message: string) => new AppError(message, ErrorCodes.CONFLICT, 409);
const forbidden = (message = 'You do not have access to this action') =>
  new AppError(message, ErrorCodes.FORBIDDEN, 403);

const FINAL: readonly string[] = ['COMPLETE', 'CANCELLED'];
const hasAnySignature = (r: Pick<ApprReviewRow, 'tutorSignedAt' | 'learnerSignedAt' | 'employerSignedAt'>) =>
  Boolean(r.tutorSignedAt || r.learnerSignedAt || r.employerSignedAt);

const audit = (actor: Actor, action: string, entityId: string, metadata: Record<string, unknown> = {}) =>
  recordAudit({ actor, action, entityType: 'appr_review', entityId, metadata });

async function loadReview(actor: Actor, reviewId: string) {
  requireAuthed(actor);
  const review = await getApprReview(reviewId);
  const enrolment = review ? await getApprEnrolment(review.enrolmentId) : null;
  if (!review || !enrolment || !(await canAccessLearner(actor, enrolment.organizationId, enrolment.learnerId))) {
    throw notFound();
  }
  return { review, enrolment };
}

function shapeReview(review: ApprReviewRow, today: string) {
  const status = review.status as ApprReviewStatus;
  return {
    ...review,
    status,
    statusLabel: APPR_REVIEW_STATUS_LABELS[status] ?? review.status,
    overdue: isReviewOverdue(review, today),
    locked: FINAL.includes(review.status) || hasAnySignature(review),
    signatures: {
      tutor: Boolean(review.tutorSignedAt),
      learner: Boolean(review.learnerSignedAt),
      employer: Boolean(review.employerSignedAt)
    }
  };
}

// ── Reads ──

export async function listReviews(actor: Actor, enrolmentId: string, now: Date = new Date()) {
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  const today = todayIso(now);
  // Staff viewing an enrolment with no review yet get its first one created (idempotent; never triggered by a learner).
  if (isStaff(actor)) {
    const programme = await getApprProgramme(enrolment.programmeId);
    await ensureFirstReview(enrolment, programme?.reviewIntervalWeeks ?? 12, {
      today,
      createdBy: requireAuthed(actor).userId
    });
  }
  const rows = await listReviewsForEnrolment(enrolment.id);
  const items = rows.map((r) => shapeReview(r, today));
  return { items, counts: { total: items.length, overdue: items.filter((r) => r.overdue).length } };
}

// ── Writes ──

/** Schedule a review (staff). The first one is scheduled automatically when a learner is enrolled. */
export async function createReview(actor: Actor, enrolmentId: string, input: ReviewCreateInput) {
  const a = assertStaff(actor);
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  const review = await runInTransaction((tx) =>
    insertApprReview(tx, {
      organizationId: enrolment.organizationId,
      enrolmentId: enrolment.id,
      scheduledDate: input.scheduledDate,
      createdBy: a.userId
    })
  );
  await audit(actor, 'appr.review.scheduled', review.id, { enrolmentId: enrolment.id });
  return shapeReview(review, todayIso());
}

const CONTENT_FIELDS = ['heldDate', 'progressSummary', 'targets', 'tutorComment', 'employerComment'] as const;

function assertTransition(from: string, to: string) {
  const ok =
    from === to ||
    (from === 'SCHEDULED' && to === 'DRAFT') ||
    (from === 'DRAFT' && to === 'AWAITING_SIGNATURES') ||
    (from === 'AWAITING_SIGNATURES' && to === 'DRAFT');
  if (!ok) throw badRequest(`A review cannot move from ${from} to ${to}`, 'status');
}

export async function updateReview(actor: Actor, reviewId: string, input: ReviewUpdateInput) {
  const a = requireAuthed(actor);
  const { review, enrolment } = await loadReview(actor, reviewId);
  if (FINAL.includes(review.status)) throw conflict('This review is closed and can no longer be edited');
  if (input.expectedUpdatedAt && Date.parse(input.expectedUpdatedAt) !== Date.parse(review.updatedAt)) {
    throw conflict('This review was just changed by someone else — reload and try again');
  }

  const { expectedUpdatedAt: _expected, ...fields } = input;
  const keys = Object.keys(fields);

  // The apprentice: only their own comment, before they sign, while the review is being finalised.
  if (a.role === 'LEARNER') {
    if (keys.some((k) => k !== 'learnerComment')) throw forbidden();
    if (!['DRAFT', 'AWAITING_SIGNATURES'].includes(review.status) || review.learnerSignedAt) {
      throw conflict('You can no longer add a comment to this review');
    }
    const updated = await runInTransaction((tx) =>
      updateApprReviewIfUnchanged(tx, review.id, review.updatedAt, { learnerComment: fields.learnerComment ?? null })
    );
    if (!updated) throw conflict('This review was just changed by someone else — reload and try again');
    await audit(actor, 'appr.review.learner_comment', review.id);
    return shapeReview(updated, todayIso());
  }

  assertStaff(actor);
  if (fields.learnerComment !== undefined) throw forbidden('Only the apprentice can write their own comment');
  if (hasAnySignature(review)) throw conflict('This review has been signed and is locked');

  const touchesContent = CONTENT_FIELDS.some((k) => fields[k] !== undefined);
  const to = fields.status ?? (review.status === 'SCHEDULED' && touchesContent ? 'DRAFT' : review.status);
  assertTransition(review.status, to);
  const heldDate = fields.heldDate !== undefined ? fields.heldDate : review.heldDate;
  if (to === 'AWAITING_SIGNATURES' && !heldDate) {
    throw badRequest('Record the date the review took place before asking for signatures', 'heldDate');
  }

  const rescheduled = fields.scheduledDate !== undefined && fields.scheduledDate !== review.scheduledDate;
  const patch = {
    ...(fields.scheduledDate !== undefined ? { scheduledDate: fields.scheduledDate } : {}),
    ...(fields.heldDate !== undefined ? { heldDate: fields.heldDate } : {}),
    ...(fields.progressSummary !== undefined ? { progressSummary: fields.progressSummary } : {}),
    ...(fields.targets !== undefined ? { targets: fields.targets } : {}),
    ...(fields.tutorComment !== undefined ? { tutorComment: fields.tutorComment } : {}),
    ...(fields.employerComment !== undefined ? { employerComment: fields.employerComment } : {}),
    status: to,
    // A moved review date re-arms the "review due" reminder.
    ...(rescheduled ? { dueNotifiedAt: null } : {})
  };
  const updated = await runInTransaction((tx) => updateApprReviewIfUnchanged(tx, review.id, review.updatedAt, patch));
  if (!updated) throw conflict('This review was just changed by someone else — reload and try again');

  await audit(actor, 'appr.review.updated', review.id, { fields: keys, status: to });
  if (to === 'AWAITING_SIGNATURES' && review.status !== 'AWAITING_SIGNATURES') {
    await notifySafely('review ready to sign', () =>
      notifyReviewReadyToSign({ reviewId: review.id, learnerId: enrolment.learnerId })
    );
  }
  return shapeReview(updated, todayIso());
}

export async function cancelReview(actor: Actor, reviewId: string) {
  assertStaff(actor);
  const { review } = await loadReview(actor, reviewId);
  if (FINAL.includes(review.status)) throw conflict('This review is already closed');
  const updated = await runInTransaction((tx) =>
    updateApprReviewIfUnchanged(tx, review.id, review.updatedAt, { status: 'CANCELLED' })
  );
  if (!updated) throw conflict('This review was just changed by someone else — reload and try again');
  await audit(actor, 'appr.review.cancelled', review.id, { signed: hasAnySignature(review) });
  return shapeReview(updated, todayIso());
}

const SIGNATURE_FIELD = {
  TUTOR: 'tutorSignedAt',
  LEARNER: 'learnerSignedAt',
  EMPLOYER: 'employerSignedAt'
} as const;

/**
 * Sign a review. TUTOR → staff (the signer's id is stored); LEARNER → only the apprentice themself; EMPLOYER → recorded by
 * staff on the employer's behalf (name + who recorded it). The last signature completes the review in the same
 * transaction: progress snapshot stored, and the next review scheduled unless an open one already lies ahead.
 */
export async function signReview(actor: Actor, reviewId: string, input: ReviewSignInput, now: Date = new Date()) {
  const a = requireAuthed(actor);
  const { review, enrolment } = await loadReview(actor, reviewId);

  if (input.role === 'LEARNER') {
    if (a.role !== 'LEARNER' || a.userId !== enrolment.learnerId) {
      throw forbidden('Only the apprentice can sign as the apprentice');
    }
  } else {
    assertStaff(actor);
  }
  if (review.status !== 'AWAITING_SIGNATURES') {
    throw conflict('This review is not waiting for signatures');
  }
  const already =
    (input.role === 'TUTOR' && review.tutorSignedAt) ||
    (input.role === 'LEARNER' && review.learnerSignedAt) ||
    (input.role === 'EMPLOYER' && review.employerSignedAt);
  if (already) throw conflict('This signature has already been recorded');

  const signedAt = now.toISOString();
  const today = todayIso(now);
  const signPatch =
    input.role === 'TUTOR'
      ? { tutorSignedName: input.name, tutorSignedAt: signedAt, tutorSignedBy: a.userId }
      : input.role === 'LEARNER'
        ? { learnerSignedName: input.name, learnerSignedAt: signedAt }
        : { employerSignedName: input.name, employerSignedAt: signedAt, employerRecordedBy: a.userId };
  const complete = reviewFullySigned({ ...review, ...signPatch });
  const programme = complete ? await getApprProgramme(enrolment.programmeId) : null;

  const result = await runInTransaction(async (tx) => {
    let completion = {};
    let next: string | null = null;
    if (complete) {
      const detail = await buildEnrolmentProgress(enrolment.id, tx);
      next = firstReviewDate(review.heldDate ?? today, programme?.reviewIntervalWeeks ?? 12, today);
      completion = {
        status: 'COMPLETE',
        snapshot: detail
          ? {
              ...toProgressSummary(detail),
              units: {
                total: detail.units.length,
                complete: detail.units.filter((u) => u.status === 'COMPLETE').length
              },
              capturedAt: signedAt
            }
          : null,
        nextReviewDate: next
      };
    }
    const updated = await updateApprReviewIfUnchanged(
      tx,
      review.id,
      review.updatedAt,
      { ...signPatch, ...completion },
      // This signature must still be empty (two people signing the same slot at once → the second is a 409).
      SIGNATURE_FIELD[input.role]
    );
    if (!updated) return null;
    let scheduledNext = false;
    if (complete && next && (await countOpenReviews(tx, enrolment.id, review.id)) === 0) {
      await insertApprReview(tx, {
        organizationId: enrolment.organizationId,
        enrolmentId: enrolment.id,
        scheduledDate: next,
        createdBy: a.userId
      });
      scheduledNext = true;
    }
    return { updated, scheduledNext };
  });
  if (!result) throw conflict('This review was just changed by someone else — reload and try again');

  await audit(actor, 'appr.review.signed', review.id, { role: input.role, completed: complete });
  return { ...shapeReview(result.updated, today), scheduledNext: result.scheduledNext };
}
