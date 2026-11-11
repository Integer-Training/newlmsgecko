import * as schema from '@db/schema';

import { and, db, eq, sql, type DbOrTxClient, type SQL } from '@db/drizzle';
import { tutorReachSql } from './tutors';

// Gecko Apprenticeships — summary dashboard aggregates. No access control here: the service passes the scope in
// (ADMIN → org, TUTOR → restrictToTutorId). Learner/OTJ/review/gateway numbers are NOT here: the service derives them
// from the learners-table rows so the dashboard can never disagree with the lists. Everything below is GROUP BY counts.

export interface SummaryScope {
  organizationId: string;
  programmeId?: string;
  /** TUTOR actor: only rows this tutor reaches (named tutor or programme tutor). */
  restrictToTutorId?: string;
}

/** Evidence rows per status (SUBMITTED = the To mark queue, same rule), scoped like the To mark list. */
export async function countEvidenceByStatus(scope: SummaryScope, client: DbOrTxClient = db) {
  const ev = schema.apprEvidence;
  const conditions: (SQL | undefined)[] = [eq(ev.organizationId, scope.organizationId)];
  if (scope.programmeId) conditions.push(eq(ev.programmeId, scope.programmeId));
  if (scope.restrictToTutorId) {
    conditions.push(
      tutorReachSql('"appr_evidence"."learner_id"', '"appr_evidence"."programme_id"', scope.restrictToTutorId)
    );
  }
  const rows = await client
    .select({ status: ev.status, n: sql<number>`count(*)::int` })
    .from(ev)
    .where(and(...conditions))
    .groupBy(ev.status);
  return new Map(rows.map((r) => [r.status, r.n]));
}

/** Tasks per status, scoped like the overdue list. */
export async function countTasksByStatus(scope: SummaryScope, client: DbOrTxClient = db) {
  const t = schema.apprTask;
  const conditions: (SQL | undefined)[] = [eq(t.organizationId, scope.organizationId)];
  if (scope.programmeId) conditions.push(eq(t.programmeId, scope.programmeId));
  if (scope.restrictToTutorId) {
    conditions.push(tutorReachSql('"appr_task"."learner_id"', '"appr_task"."programme_id"', scope.restrictToTutorId));
  }
  const rows = await client
    .select({ status: t.status, n: sql<number>`count(*)::int` })
    .from(t)
    .where(and(...conditions))
    .groupBy(t.status);
  return new Map(rows.map((r) => [r.status, r.n]));
}

/**
 * IQA samples waiting on someone: PENDING = not decided yet; awaitingAck = decided (AGREE or DISAGREE) but the assessor
 * has not acknowledged. For a tutor (`assessorId`) only samples on evidence they accepted; admin → the whole org.
 */
export async function countIqaOpen(
  scope: { organizationId: string; programmeId?: string; assessorId?: string },
  client: DbOrTxClient = db
) {
  const s = schema.apprIqaSample;
  const conditions: (SQL | undefined)[] = [eq(s.organizationId, scope.organizationId)];
  if (scope.assessorId) conditions.push(eq(s.assessorId, scope.assessorId));
  if (scope.programmeId) {
    conditions.push(
      sql`exists (select 1 from appr_enrolment ie where ie.id = ${sql.raw('"appr_iqa_sample"."enrolment_id"')} and ie.programme_id = ${scope.programmeId})`
    );
  }
  const [row] = await client
    .select({
      pending: sql<number>`count(*) filter (where ${s.outcome} = 'PENDING')::int`,
      awaitingAck: sql<number>`count(*) filter (where ${s.outcome} <> 'PENDING' and ${s.acknowledgedAt} is null)::int`
    })
    .from(s)
    .where(and(...conditions));
  return { pending: row?.pending ?? 0, awaitingAck: row?.awaitingAck ?? 0 };
}
