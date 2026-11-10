import * as schema from '@db/schema';

import { and, asc, db, eq, inArray, notInArray, sql, type DbOrTxClient } from '@db/drizzle';

// Gecko Apprenticeships — who may act as a tutor for an enrolment. Two links, both org-scoped:
//   NAMED tutor     = a tutor_allocation pair (tutor ↔ learner, shared with the diploma flow). Gets the alerts and is
//                     the learner's tutor of record.
//   PROGRAMME tutor = an appr_programme_tutor row (like a course's tutors). Sees and marks every enrolment of the
//                     programme, but is not alerted.
// A tutor reaches an enrolment when EITHER link exists. No access control here: services pass the ids in.

const pt = schema.apprProgrammeTutor;
const ROLE_TUTOR_ID = 2;

/**
 * SQL condition "this tutor reaches the row": named (allocation) OR assigned to the row's programme. Pass the outer
 * table's learner_id / programme_id columns as fully-qualified raw names (`"appr_task"."learner_id"`), otherwise a
 * correlated subquery would silently match its own table.
 */
export function tutorReachSql(learnerCol: string, programmeCol: string, tutorId: string) {
  return sql`(exists (select 1 from tutor_allocation ta where ta.learner_id = ${sql.raw(learnerCol)} and ta.tutor_id = ${tutorId})
    or exists (select 1 from appr_programme_tutor apt where apt.programme_id = ${sql.raw(programmeCol)} and apt.tutor_id = ${tutorId}))`;
}

export interface ApprTutorDisplay {
  id: string;
  name: string;
  kind: 'NAMED' | 'PROGRAMME';
}

/**
 * The tutors to SHOW for a row, as one JSON array (correlated subquery, so a list stays ONE statement): the learner's
 * NAMED tutors (allocation) when there are any, else the programme's tutors (still role-2 members of the org), else
 * `[]` (the UI shows "No tutor"). Same outer-column rule as tutorReachSql: fully-qualified raw names.
 */
export function tutorsDisplaySql(learnerCol: string, programmeCol: string, orgCol: string) {
  const l = sql.raw(learnerCol);
  const p = sql.raw(programmeCol);
  const o = sql.raw(orgCol);
  return sql<ApprTutorDisplay[]>`coalesce(
    (select json_agg(json_build_object('id', x.id, 'name', x.name, 'kind', 'NAMED') order by x.name) from (
      select tp.id, coalesce(nullif(tu.name, ''), tp.fullname) as name
      from tutor_allocation ta join profile tp on tp.id = ta.tutor_id left join "user" tu on tu.id = tp.id
      where ta.learner_id = ${l} and ta.organization_id = ${o}) x
     having count(*) > 0),
    (select json_agg(json_build_object('id', y.id, 'name', y.name, 'kind', 'PROGRAMME') order by y.name) from (
      select pp.id, coalesce(nullif(pu.name, ''), pp.fullname, pp.email) as name
      from appr_programme_tutor apt join profile pp on pp.id = apt.tutor_id left join "user" pu on pu.id = pp.id
      join organizationmember pom on pom.organization_id = apt.organization_id and pom.profile_id = apt.tutor_id and pom.role_id = ${ROLE_TUTOR_ID}
      where apt.programme_id = ${p} and apt.organization_id = ${o}) y
     having count(*) > 0),
    '[]'::json)`;
}

/** SQL condition "no named tutor AND no programme tutor" for the row (the learners "no tutor" filter). */
export function noTutorSql(learnerCol: string, programmeCol: string, orgCol: string) {
  const l = sql.raw(learnerCol);
  const p = sql.raw(programmeCol);
  const o = sql.raw(orgCol);
  return sql`(not exists (select 1 from tutor_allocation nta where nta.learner_id = ${l} and nta.organization_id = ${o})
    and not exists (select 1 from appr_programme_tutor npt
      join organizationmember nom on nom.organization_id = npt.organization_id and nom.profile_id = npt.tutor_id and nom.role_id = ${ROLE_TUTOR_ID}
      where npt.programme_id = ${p} and npt.organization_id = ${o}))`;
}

/** Is this tutor assigned to this programme? */
export async function isProgrammeTutor(programmeId: string, tutorId: string, client: DbOrTxClient = db) {
  const [row] = await client
    .select({ id: pt.id })
    .from(pt)
    .where(and(eq(pt.programmeId, programmeId), eq(pt.tutorId, tutorId)))
    .limit(1);
  return Boolean(row);
}

/** Programme ids a tutor is assigned to, in this org. */
export async function listProgrammeIdsForTutor(organizationId: string, tutorId: string, client: DbOrTxClient = db) {
  const rows = await client
    .select({ programmeId: pt.programmeId })
    .from(pt)
    .where(and(eq(pt.organizationId, organizationId), eq(pt.tutorId, tutorId)));
  return rows.map((r) => r.programmeId);
}

/** Every programme of the org (for the assign dialog; archived ones are flagged so the UI can label them). */
export async function listProgrammeOptions(organizationId: string, client: DbOrTxClient = db) {
  const p = schema.apprProgramme;
  return client
    .select({ id: p.id, title: p.title, status: p.status })
    .from(p)
    .where(eq(p.organizationId, organizationId))
    .orderBy(asc(p.title));
}

/**
 * Set a tutor's programmes to exactly `programmeIds` (already validated to belong to the org). One transaction:
 * removes the others, inserts the missing ones (unique (programme, tutor) makes a race harmless).
 */
export async function setProgrammesForTutor(
  organizationId: string,
  tutorId: string,
  programmeIds: string[],
  createdBy: string,
  tx: DbOrTxClient
) {
  const del = and(eq(pt.organizationId, organizationId), eq(pt.tutorId, tutorId));
  await tx.delete(pt).where(programmeIds.length ? and(del, notInArray(pt.programmeId, programmeIds)) : del);
  if (programmeIds.length) {
    await tx
      .insert(pt)
      .values(programmeIds.map((programmeId) => ({ organizationId, programmeId, tutorId, createdBy })))
      .onConflictDoNothing({ target: [pt.programmeId, pt.tutorId] });
  }
}

export interface ApprProgrammeTutorRef {
  id: string;
  name: string;
}

/** Tutors assigned to a programme who are STILL tutors of the org (a role change silently drops them). */
export async function listTutorsForProgramme(programmeId: string, client: DbOrTxClient = db) {
  const om = schema.organizationmember;
  return client
    .select({
      id: pt.tutorId,
      name: sql<string>`coalesce(nullif((select u.name from "user" u where u.id = ${pt.tutorId}), ''), ${schema.profile.fullname}, ${schema.profile.email})`
    })
    .from(pt)
    .innerJoin(schema.profile, eq(schema.profile.id, pt.tutorId))
    .innerJoin(
      om,
      and(eq(om.organizationId, pt.organizationId), eq(om.profileId, pt.tutorId), eq(om.roleId, ROLE_TUTOR_ID))
    )
    .where(eq(pt.programmeId, programmeId))
    .orderBy(asc(schema.profile.fullname));
}

/** Programme ids among `programmeIds` that belong to the org (validation for the reconcile). */
export async function filterProgrammeIdsInOrg(organizationId: string, programmeIds: string[]) {
  if (programmeIds.length === 0) return [];
  const p = schema.apprProgramme;
  const rows = await db
    .select({ id: p.id })
    .from(p)
    .where(and(eq(p.organizationId, organizationId), inArray(p.id, programmeIds)));
  return rows.map((r) => r.id);
}

/** The allocation row pairing this tutor with this learner in the org, if any (to remove a named tutor). */
export async function getAllocationIdForPair(organizationId: string, tutorId: string, learnerId: string) {
  const ta = schema.tutorAllocation;
  const [row] = await db
    .select({ id: ta.id })
    .from(ta)
    .where(and(eq(ta.organizationId, organizationId), eq(ta.tutorId, tutorId), eq(ta.learnerId, learnerId)))
    .limit(1);
  return row?.id ?? null;
}
