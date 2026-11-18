import * as schema from '@db/schema';

import { and, asc, db, eq, lt, ne, sql, type DbOrTxClient, type SQL } from '@db/drizzle';
import { tutorReachSql } from './tutors';
import { profileDisplayName } from './names';

// Gecko Apprenticeships — summary dashboard aggregates. No access control here: the service passes the scope in
// (ADMIN → org, TUTOR → restrictToTutorId). Learner/OTJ/review/gateway numbers are NOT here: the service derives them
// from the learners-table rows so the dashboard can never disagree with the lists. Everything below is GROUP BY counts.

export interface SummaryScope {
  organizationId: string;
  programmeId?: string;
  /** Programme type of the row's OWN programme (evidence / task belong to one half of a pair). */
  type?: 'DIPLOMA' | 'STANDARD';
  /** TUTOR actor: only rows this tutor reaches (named tutor or programme tutor). */
  restrictToTutorId?: string;
}

function typeSql(programmeIdCol: string, type: string): SQL {
  return sql`exists (select 1 from appr_programme tp where tp.id = ${sql.raw(programmeIdCol)} and tp.type = ${type})`;
}

/** Evidence rows per status (SUBMITTED = the To mark queue, same rule), scoped like the To mark list. */
export async function countEvidenceByStatus(scope: SummaryScope, client: DbOrTxClient = db) {
  const ev = schema.apprEvidence;
  const conditions: (SQL | undefined)[] = [eq(ev.organizationId, scope.organizationId)];
  if (scope.programmeId) conditions.push(eq(ev.programmeId, scope.programmeId));
  if (scope.type) conditions.push(typeSql('"appr_evidence"."programme_id"', scope.type));
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
  if (scope.type) conditions.push(typeSql('"appr_task"."programme_id"', scope.type));
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
  scope: { organizationId: string; programmeId?: string; type?: 'DIPLOMA' | 'STANDARD'; assessorId?: string },
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
  if (scope.type) {
    conditions.push(
      sql`exists (select 1 from appr_enrolment ie join appr_programme ip on ip.id = ie.programme_id where ie.id = ${sql.raw('"appr_iqa_sample"."enrolment_id"')} and ip.type = ${scope.type})`
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

/**
 * Units complete / total of the linked COMPONENT of each given carrier (a pair's gateway counts units across both
 * qualifications). Carriers without a component are absent from the map. One statement.
 */
export async function listLinkedUnitCounts(carrierIds: string[], client: DbOrTxClient = db) {
  if (carrierIds.length === 0) return new Map<string, { total: number; complete: number }>();
  const ids = sql.join(
    carrierIds.map((id) => sql`${id}::uuid`),
    sql`, `
  );
  const res = await client.execute<{ carrier_id: string; total: number; complete: number }>(
    sql`select c.primary_enrolment_id as carrier_id, count(eu.unit_id)::int as total,
      (count(eu.unit_id) filter (where eu.completed_at is not null))::int as complete
      from appr_enrolment c left join appr_enrolment_unit eu on eu.enrolment_id = c.id
      where c.primary_enrolment_id in (${ids}) group by c.primary_enrolment_id`
  );
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as {
    carrier_id: string;
    total: number;
    complete: number;
  }[];
  return new Map(rows.map((r) => [r.carrier_id, { total: Number(r.total), complete: Number(r.complete) }]));
}

/**
 * Overdue tasks like listOverdueTasks (tasks.ts) but also scoped by the task's programme TYPE. The summary uses this
 * only when its type filter is set; same columns, order and window total.
 */
export async function listOverdueTasksByType(
  scope: SummaryScope,
  today: string,
  page: { limit: number; offset: number },
  client: DbOrTxClient = db
) {
  const t = schema.apprTask;
  const conditions: (SQL | undefined)[] = [
    eq(t.organizationId, scope.organizationId),
    lt(t.dueDate, today),
    ne(t.status, 'COMPLETE')
  ];
  if (scope.programmeId) conditions.push(eq(t.programmeId, scope.programmeId));
  if (scope.type) conditions.push(eq(schema.apprProgramme.type, scope.type));
  if (scope.restrictToTutorId) {
    conditions.push(tutorReachSql('"appr_task"."learner_id"', '"appr_task"."programme_id"', scope.restrictToTutorId));
  }
  return client
    .select({
      id: t.id,
      title: t.title,
      dueDate: t.dueDate,
      enrolmentId: t.enrolmentId,
      learnerId: t.learnerId,
      learnerName: profileDisplayName,
      programmeId: t.programmeId,
      programmeTitle: schema.apprProgramme.title,
      total: sql<number>`count(*) over()::int`
    })
    .from(t)
    .innerJoin(schema.profile, eq(schema.profile.id, t.learnerId))
    .innerJoin(schema.apprProgramme, eq(schema.apprProgramme.id, t.programmeId))
    .where(and(...conditions))
    .orderBy(asc(t.dueDate), asc(t.id))
    .limit(page.limit)
    .offset(page.offset);
}
