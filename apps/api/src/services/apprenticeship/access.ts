import { AppError, ErrorCodes } from '@api/utils/errors';
import { isAllocatedTutor } from '@api/middlewares/guards/ownership';
import type { Actor } from '@cio/db/actor';
import { getApprEnrolment, getApprProgramme, isProgrammeTutor } from '@cio/db/queries/apprenticeship';

// Gecko Apprenticeships — THE access rule, in one place, so the admin (Phase A), tutor (B) and learner (C) screens only
// open routes and never re-implement scoping:
//   ADMIN  → everything in their org.
//   TUTOR  → enrolments of learners ALLOCATED to them (tutor_allocation = the NAMED tutor, same rule as the diploma
//            flow) OR of a programme they are assigned to (appr_programme_tutor, like a course's tutors).
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

/**
 * Can this actor see this learner's apprenticeship data on this programme? (No DB read for admin/self.) The programme
 * matters for programme tutors: assignment to programme A never opens the same learner's programme B.
 */
export async function canAccessLearner(
  actor: Actor,
  organizationId: string,
  learnerId: string,
  programmeId: string
): Promise<boolean> {
  if (!actor.authenticated || actor.orgId !== organizationId) return false;
  if (actor.role === 'ADMIN') return true;
  if (actor.role === 'TUTOR') {
    return (await isAllocatedTutor(actor, learnerId)) || isProgrammeTutor(programmeId, actor.userId);
  }
  if (actor.role === 'LEARNER') return actor.userId === learnerId;
  return false;
}

/** Load an enrolment the actor may see, or 404. */
export async function getEnrolmentForActor(actor: Actor, enrolmentId: string) {
  requireAuthed(actor);
  const enrolment = await getApprEnrolment(enrolmentId);
  if (
    !enrolment ||
    !(await canAccessLearner(actor, enrolment.organizationId, enrolment.learnerId, enrolment.programmeId))
  ) {
    throw new AppError('Learner portfolio not found', ErrorCodes.NOT_FOUND, 404);
  }
  return enrolment;
}

/** Staff for apprenticeship purposes: ADMIN or TUTOR (a tutor's reach is still limited by canAccessLearner). */
export function isStaff(actor: Actor): boolean {
  return actor.authenticated && (actor.role === 'ADMIN' || actor.role === 'TUTOR');
}

/** Learners (and anyone else) may read their own portfolio but never change staff-owned data. */
export function assertStaff(actor: Actor): AuthedActor {
  const a = requireAuthed(actor);
  if (!isStaff(a)) throw new AppError('You do not have access to this action', ErrorCodes.FORBIDDEN, 403);
  return a;
}
