import { listTutorsForLearner } from '@cio/db/queries/allocation';
import { markNotificationsReadForEntity } from '@cio/db/queries/comms';
import { emitNotification } from '@api/services/comms/notify';

// Gecko Apprenticeships — in-app notifications for the evidence loop, on the ONE notification pipeline
// (emitNotification: the in-app row always; no email template → never an email, email is off on Gecko anyway).
// Content-light: the subject + deep link are built when the bell is read (services/comms/notification-centre.ts).
// Fire-and-forget: callers wrap these so a failure never undoes the evidence write.

export const EVIDENCE_ENTITY = 'appr_evidence';

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

/** Run a notification without ever failing the caller (the evidence change has already committed). */
export async function notifySafely(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(`[apprenticeship] ${label} notification failed (non-fatal):`, error);
  }
}
