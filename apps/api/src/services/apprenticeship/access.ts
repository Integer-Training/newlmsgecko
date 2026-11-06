import { AppError, ErrorCodes } from '@api/utils/errors';
import { isAllocatedTutor } from '@api/middlewares/guards/ownership';
import type { Actor } from '@cio/db/actor';
import { getApprEnrolment, getApprProgramme } from '@cio/db/queries/apprenticeship';

// Gecko Apprenticeships — THE access rule, in one place, so the admin (Phase A), tutor (B) and learner (C) screens only
// open routes and never re-implement scoping:
//   ADMIN  → everything in their org.
//   TUTOR  → only enrolments of learners ALLOCATED to them (tutor_allocation, same rule as the diploma flow).
//   LEARNER→ only their own enrolment (read; their own evidence is handled by the evidence service).
// Anything not visible is reported as 404, so ids of other orgs/learners cannot be probed.

type AuthedActor = Extract<Actor, { authenticated: true }>;

export function requireAuthed(actor: Actor): AuthedActor {
  if (!actor.authenticated) throw new AppError('Unauthorized', ErrorCodes.UNAUTHORIZED, 401);
  return actor;
}

/** A programme in the caller's org (any staff role may read structure; writes are gated at the route). */
export async function getProgrammeForActor(actor: Actor, programmeId: string) {
  const a = requireAuthed(actor);
  const programme = await getApprProgramme(programmeId);
  if (!programme || programme.organizationId !== a.orgId) {
    throw new AppError('Programme not found', ErrorCodes.NOT_FOUND, 404);
  }
  return programme;
}

/** Can this actor see this learner's apprenticeship data? (No DB read for admin/self.) */
export async function canAccessLearner(actor: Actor, organizationId: string, learnerId: string): Promise<boolean> {
  if (!actor.authenticated || actor.orgId !== organizationId) return false;
  if (actor.role === 'ADMIN') return true;
  if (actor.role === 'TUTOR') return isAllocatedTutor(actor, learnerId);
  if (actor.role === 'LEARNER') return actor.userId === learnerId;
  return false;
}

/** Load an enrolment the actor may see, or 404. */
export async function getEnrolmentForActor(actor: Actor, enrolmentId: string) {
  requireAuthed(actor);
  const enrolment = await getApprEnrolment(enrolmentId);
  if (!enrolment || !(await canAccessLearner(actor, enrolment.organizationId, enrolment.learnerId))) {
    throw new AppError('Learner portfolio not found', ErrorCodes.NOT_FOUND, 404);
  }
  return enrolment;
}
