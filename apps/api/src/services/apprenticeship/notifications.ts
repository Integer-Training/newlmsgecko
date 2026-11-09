import { listTutorsForLearner, listTutorsForLearnerInOrg } from '@cio/db/queries/allocation';
import { listOrgAdminIds, releaseGatewayReady } from '@cio/db/queries/apprenticeship';
import { markNotificationsReadForEntity } from '@cio/db/queries/comms';
import { emitNotification } from '@api/services/comms/notify';

// Gecko Apprenticeships — in-app notifications for the evidence loop, on the ONE notification pipeline
// (emitNotification: the in-app row always; no email template → never an email, email is off on Gecko anyway).
// Content-light: the subject + deep link are built when the bell is read (services/comms/notification-centre.ts).
// Fire-and-forget: callers wrap these so a failure never undoes the evidence write.

export const EVIDENCE_ENTITY = 'appr_evidence';
export const TASK_ENTITY = 'appr_task';
export const REVIEW_ENTITY = 'appr_review';
export const ENROLMENT_ENTITY = 'appr_enrolment';

/** Evidence submitted or resubmitted by the apprentice → their ALLOCATED tutor(s). No tutor → nothing sent. */
export async function notifyEvidenceSubmitted(ctx: { evidenceId: string; learnerId: string }): Promise<void> {
  const tutors = await listTutorsForLearner(ctx.learnerId);
  if (tutors.length === 0) return;
  await emitNotification({
    type: 'appr.evidence.submitted',
    recipients: tutors.map((t) => ({ userId: t.tutorId })),
    entityType: EVIDENCE_ENTITY,
    entityId: ctx.evidenceId
  });
}

/** Evidence accepted or referred → the apprentice. Marking also clears every tutor's "to mark" alert for it. */
export async function notifyEvidenceReviewed(ctx: {
  evidenceId: string;
  learnerId: string;
  outcome: 'ACCEPTED' | 'REFERRED';
}): Promise<void> {
  await markNotificationsReadForEntity(EVIDENCE_ENTITY, ctx.evidenceId, ['appr.evidence.submitted']);
  await emitNotification({
    type: ctx.outcome === 'ACCEPTED' ? 'appr.evidence.accepted' : 'appr.evidence.referred',
    recipients: [{ userId: ctx.learnerId }],
    entityType: EVIDENCE_ENTITY,
    entityId: ctx.evidenceId
  });
}

/** Tasks assigned from a plan → the apprentice. ONE per assign call per learner (entity = their first new task). */
export async function notifyTasksAssigned(ctx: { taskId: string; learnerId: string }): Promise<void> {
  await emitNotification({
    type: 'appr.task.assigned',
    recipients: [{ userId: ctx.learnerId }],
    entityType: TASK_ENTITY,
    entityId: ctx.taskId
  });
}

/** A review moved to "awaiting signatures" → the apprentice, who signs it in their own view. */
export async function notifyReviewReadyToSign(ctx: { reviewId: string; learnerId: string }): Promise<void> {
  await emitNotification({
    type: 'appr.review.sign',
    recipients: [{ userId: ctx.learnerId }],
    entityType: REVIEW_ENTITY,
    entityId: ctx.reviewId
  });
}

/** A learner became ready for the gateway -> their allocated tutors (this org) and the org's admins, once. */
export async function notifyGatewayReady(ctx: {
  enrolmentId: string;
  learnerId: string;
  organizationId: string;
}): Promise<void> {
  const [tutors, admins] = await Promise.all([
    listTutorsForLearnerInOrg(ctx.learnerId, ctx.organizationId),
    listOrgAdminIds(ctx.organizationId)
  ]);
  const recipients = [...new Set([...tutors.map((t) => t.tutorId), ...admins])];
  if (recipients.length === 0) return;
  await emitNotification({
    type: 'appr.gateway.ready',
    recipients: recipients.map((userId) => ({ userId })),
    entityType: ENROLMENT_ENTITY,
    entityId: ctx.enrolmentId
  });
}

/**
 * Send the gateway-ready alert after the flag was claimed. If the send fails, release the claim (best-effort) so the
 * daily scan retries instead of the alert being lost. Never throws.
 */
export async function notifyGatewayReadyOrRelease(ctx: {
  enrolmentId: string;
  learnerId: string;
  organizationId: string;
}): Promise<void> {
  try {
    await notifyGatewayReady(ctx);
  } catch (error) {
    console.error('[apprenticeship] gateway ready notification failed (released for retry):', error);
    await releaseGatewayReady(ctx.enrolmentId).catch(() => undefined);
  }
}

/** Run a notification without ever failing the caller (the evidence change has already committed). */
export async function notifySafely(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(`[apprenticeship] ${label} notification failed (non-fatal):`, error);
  }
}
