import { AppError, ErrorCodes } from '@api/utils/errors';
import { getEnrolmentForActor, requireAuthed } from '@api/services/apprenticeship/access';
import { createTutorAllocation, removeTutorAllocation } from '@api/services/organization/allocation';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import { runInTransaction } from '@cio/db/drizzle';
import { getOrgMemberRoleId } from '@cio/db/queries/allocation';
import {
  filterProgrammeIdsInOrg,
  getAllocationIdForPair,
  getEnrolmentOverview,
  listProgrammeIdsForTutor,
  listProgrammeOptions,
  listTutorsForProgramme,
  setProgrammesForTutor
} from '@cio/db/queries/apprenticeship';
import { ROLE } from '@cio/utils/constants';

// Gecko Apprenticeships — who tutors an apprentice. Two links (see queries/apprenticeship/tutors.ts):
//   PROGRAMME tutors — set per tutor from Tutor Management, like a tutor's courses. They see and mark every apprentice
//                      on the programme but get no alerts.
//   NAMED tutors     — the apprentice's tutor of record (a tutor_allocation pair, set at enrolment, changeable on the
//                      portfolio). They get the alerts and sign reviews as "the tutor". The pair is provider-wide, so it
//                      is the same allocation the diploma flow uses for this learner.
// Every write is ADMIN only.

function assertAdmin(actor: Actor) {
  const a = requireAuthed(actor);
  if (a.role !== 'ADMIN') throw new AppError('Only an admin can change tutors', ErrorCodes.FORBIDDEN, 403);
  return a;
}

async function assertTutorInOrg(orgId: string, tutorId: string) {
  if ((await getOrgMemberRoleId(orgId, tutorId)) !== ROLE.TUTOR) {
    throw new AppError('Tutor not found in this organization', ErrorCodes.NOT_FOUND, 404);
  }
}

// ── Programme tutors (Tutor Management › Apprenticeships) ──

export async function getTutorProgrammes(actor: Actor, tutorId: string) {
  const a = assertAdmin(actor);
  await assertTutorInOrg(a.orgId, tutorId);
  const [assignedProgrammeIds, programmes] = await Promise.all([
    listProgrammeIdsForTutor(a.orgId, tutorId),
    listProgrammeOptions(a.orgId)
  ]);
  return { assignedProgrammeIds, programmes };
}

export async function setTutorProgrammes(actor: Actor, tutorId: string, programmeIds: string[]) {
  const a = assertAdmin(actor);
  await assertTutorInOrg(a.orgId, tutorId);
  const valid = await filterProgrammeIdsInOrg(a.orgId, programmeIds);
  if (valid.length !== programmeIds.length) {
    throw new AppError('One or more programmes were not found', ErrorCodes.VALIDATION_ERROR, 400, 'programmeIds');
  }
  await runInTransaction((tx) => setProgrammesForTutor(a.orgId, tutorId, valid, a.userId, tx));
  await recordAudit({
    actor: a,
    action: 'appr.programme_tutors.set',
    entityType: 'user',
    entityId: tutorId,
    metadata: { programmes: valid.length }
  });
  return getTutorProgrammes(a, tutorId);
}

// ── An apprentice's tutors (portfolio) ──

/** Named + programme tutors of one enrolment. Anyone who can see the portfolio may read the names. */
export async function getEnrolmentTutors(actor: Actor, enrolmentId: string) {
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  const [overview, programmeTutors] = await Promise.all([
    getEnrolmentOverview(enrolment.id),
    listTutorsForProgramme(enrolment.programmeId)
  ]);
  // overview.tutors falls back to programme tutors for display; this dialog manages NAMED tutors only.
  const named = (overview?.tutors ?? []).filter((t) => t.kind !== 'PROGRAMME');
  return { named, programme: programmeTutors };
}

export async function addNamedTutor(actor: Actor, enrolmentId: string, tutorId: string) {
  const a = assertAdmin(actor);
  const enrolment = await getEnrolmentForActor(a, enrolmentId);
  await assertTutorInOrg(a.orgId, tutorId);
  try {
    await createTutorAllocation(a.orgId, a, { tutorId, learnerId: enrolment.learnerId });
  } catch (error) {
    // Already the named tutor is exactly the state we want.
    if (!(error instanceof AppError && error.statusCode === 409)) throw error;
  }
  return getEnrolmentTutors(a, enrolment.id);
}

export async function removeNamedTutor(actor: Actor, enrolmentId: string, tutorId: string) {
  const a = assertAdmin(actor);
  const enrolment = await getEnrolmentForActor(a, enrolmentId);
  const allocationId = await getAllocationIdForPair(a.orgId, tutorId, enrolment.learnerId);
  if (!allocationId) throw new AppError('This tutor is not a named tutor of this learner', ErrorCodes.NOT_FOUND, 404);
  await removeTutorAllocation(a.orgId, a, allocationId);
  return getEnrolmentTutors(a, enrolment.id);
}
