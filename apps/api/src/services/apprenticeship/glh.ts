import { AppError, ErrorCodes } from '@api/utils/errors';
import { assertStaff, getEnrolmentForActor } from '@api/services/apprenticeship/access';
import { recomputeEnrolment } from '@api/services/apprenticeship/progress';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import { runInTransaction } from '@cio/db/drizzle';
import { deleteGlhLog, insertGlhLog, listGlhLogs } from '@cio/db/queries/apprenticeship';
import type { GlhLogCreateInput } from '@cio/utils/validation/apprenticeship';

// Gecko Apprenticeships — staff-logged guided learning hours. Reads follow the enrolment access rule (ADMIN org, TUTOR
// allocated, LEARNER own); writes are staff only (a tutor only for an allocated learner — anything else 404s). Every
// write recomputes the learner's cache (glh_minutes) in the SAME transaction.

const audit = (actor: Actor, action: string, entityId: string, metadata: Record<string, unknown> = {}) =>
  recordAudit({ actor, action, entityType: 'appr_enrolment', entityId, metadata });

export async function listEnrolmentGlhLogs(actor: Actor, enrolmentId: string) {
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  const items = await listGlhLogs(enrolment.id);
  return { items, totalMinutes: items.reduce((sum, l) => sum + l.minutes, 0) };
}

export async function addGlhLog(actor: Actor, enrolmentId: string, input: GlhLogCreateInput) {
  const a = assertStaff(actor);
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  const result = await runInTransaction(async (tx) => {
    const log = await insertGlhLog(tx, {
      organizationId: enrolment.organizationId,
      enrolmentId: enrolment.id,
      minutes: input.minutes,
      logDate: input.logDate,
      note: input.note ?? null,
      createdBy: a.userId
    });
    const detail = await recomputeEnrolment(tx, enrolment.id);
    return { log, glh: detail?.glh ?? null };
  });
  await audit(actor, 'appr.glh.logged', enrolment.id, { logId: result.log.id, minutes: input.minutes });
  return result;
}

export async function removeGlhLog(actor: Actor, enrolmentId: string, logId: string) {
  assertStaff(actor);
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  const result = await runInTransaction(async (tx) => {
    // Bound to THIS enrolment: a log id of another learner is simply not found.
    const removed = await deleteGlhLog(tx, logId, enrolment.id);
    if (!removed) throw new AppError('GLH entry not found', ErrorCodes.NOT_FOUND, 404);
    const detail = await recomputeEnrolment(tx, enrolment.id);
    return { glh: detail?.glh ?? null };
  });
  await audit(actor, 'appr.glh.removed', enrolment.id, { logId });
  return { deleted: true, ...result };
}
