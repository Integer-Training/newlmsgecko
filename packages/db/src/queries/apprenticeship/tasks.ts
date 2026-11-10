import * as schema from '@db/schema';

import {
  and,
  asc,
  db,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lt,
  ne,
  sql,
  type DbOrTxClient,
  type SQL
} from '@db/drizzle';
import { tutorReachSql, tutorsDisplaySql } from './tutors';
import { profileDisplayName } from './names';

// Gecko Apprenticeships — task plans, plan items and learner tasks. No access control here: services resolve the actor
// and the org/enrolment first. Writes take the transaction client so a task status change lands with the evidence write.

export type ApprTaskPlanRow = typeof schema.apprTaskPlan.$inferSelect;
export type ApprTaskPlanItemRow = typeof schema.apprTaskPlanItem.$inferSelect;
export type ApprTaskRow = typeof schema.apprTask.$inferSelect;
export type ApprTaskFile = ApprTaskRow['files'][number];

const t = schema.apprTask;
const plan = schema.apprTaskPlan;
const item = schema.apprTaskPlanItem;

// ── Plans ──

export async function getTaskPlan(planId: string, client: DbOrTxClient = db) {
  const [row] = await client.select().from(plan).where(eq(plan.id, planId)).limit(1);
  return row ?? null;
}

/** The plans list: item count + number of learners holding at least one task from the plan. */
export async function listTaskPlans(
  organizationId: string,
  filter: { programmeId?: string; status?: string },
  client: DbOrTxClient = db
) {
  const conditions: (SQL | undefined)[] = [eq(plan.organizationId, organizationId)];
  if (filter.programmeId) conditions.push(eq(plan.programmeId, filter.programmeId));
  if (filter.status) conditions.push(eq(plan.status, filter.status));
  return client
    .select({
      id: plan.id,
      programmeId: plan.programmeId,
      programmeTitle: schema.apprProgramme.title,
      title: plan.title,
      validFrom: plan.validFrom,
      validTo: plan.validTo,
      status: plan.status,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      itemCount: sql<number>`(select count(*) from appr_task_plan_item i where i.plan_id = ${sql.raw('"appr_task_plan"."id"')})::int`,
      assignedCount: sql<number>`(select count(distinct x.enrolment_id) from appr_task x where x.plan_id = ${sql.raw('"appr_task_plan"."id"')})::int`
    })
    .from(plan)
    .innerJoin(schema.apprProgramme, eq(schema.apprProgramme.id, plan.programmeId))
    .where(and(...conditions))
    .orderBy(desc(plan.createdAt));
}

export async function insertTaskPlan(tx: DbOrTxClient, values: typeof plan.$inferInsert) {
  const [row] = await tx.insert(plan).values(values).returning();
  return row;
}

export async function updateTaskPlan(
  tx: DbOrTxClient,
  planId: string,
  patch: Partial<Pick<ApprTaskPlanRow, 'title' | 'validFrom' | 'validTo' | 'files' | 'status'>>
) {
  const [row] = await tx
    .update(plan)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(plan.id, planId))
    .returning();
  return row ?? null;
}

export async function deleteTaskPlan(tx: DbOrTxClient, planId: string) {
  await tx.delete(plan).where(eq(plan.id, planId));
}

/** How many tasks of this plan already have evidence linked (a plan with any cannot be deleted). */
export async function countPlanTasksWithEvidence(planId: string, client: DbOrTxClient = db): Promise<number> {
  const [row] = await client
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .where(
      and(
        eq(t.planId, planId),
        sql`exists (select 1 from appr_evidence e where e.task_id = ${sql.raw('"appr_task"."id"')})`
      )
    );
  return row?.n ?? 0;
}

/** Learners holding tasks from the plan, with progress through them. */
export async function listPlanAssignees(planId: string, client: DbOrTxClient = db) {
  return client
    .select({
      enrolmentId: t.enrolmentId,
      learnerId: t.learnerId,
      learnerName: profileDisplayName,
      startDate: schema.apprEnrolment.startDate,
      taskCount: sql<number>`count(*)::int`,
      completeCount: sql<number>`count(*) filter (where ${t.status} = 'COMPLETE')::int`,
      overdueCount: sql<number>`count(*) filter (where ${t.dueDate} < current_date and ${t.status} <> 'COMPLETE')::int`,
      tutors: tutorsDisplaySql(
        '"appr_task"."learner_id"',
        '"appr_task"."programme_id"',
        '"appr_task"."organization_id"'
      )
    })
    .from(t)
    .innerJoin(schema.apprEnrolment, eq(schema.apprEnrolment.id, t.enrolmentId))
    .innerJoin(schema.profile, eq(schema.profile.id, t.learnerId))
    .where(eq(t.planId, planId))
    .groupBy(
      t.enrolmentId,
      t.learnerId,
      t.programmeId,
      t.organizationId,
      schema.apprEnrolment.startDate,
      schema.profile.id
    )
    .orderBy(asc(profileDisplayName));
}

// ── Plan items ──

export async function listPlanItems(planId: string, client: DbOrTxClient = db) {
  return client.select().from(item).where(eq(item.planId, planId)).orderBy(asc(item.sequence), asc(item.id));
}

export async function getPlanItem(itemId: string, client: DbOrTxClient = db) {
  const [row] = await client.select().from(item).where(eq(item.id, itemId)).limit(1);
  return row ?? null;
}

export async function nextPlanItemSequence(planId: string, client: DbOrTxClient = db): Promise<number> {
  const [row] = await client
    .select({ max: sql<number | null>`max(${item.sequence})` })
    .from(item)
    .where(eq(item.planId, planId));
  return (row?.max ?? -1) + 1;
}

export async function insertPlanItem(tx: DbOrTxClient, values: typeof item.$inferInsert) {
  const [row] = await tx.insert(item).values(values).returning();
  return row;
}

export async function updatePlanItem(
  tx: DbOrTxClient,
  itemId: string,
  patch: Partial<
    Pick<
      ApprTaskPlanItemRow,
      'title' | 'details' | 'typeKey' | 'sequence' | 'monthOffset' | 'expectedMinutes' | 'files'
    >
  >
) {
  const [row] = await tx
    .update(item)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(item.id, itemId))
    .returning();
  return row ?? null;
}

export async function deletePlanItem(tx: DbOrTxClient, itemId: string) {
  await tx.delete(item).where(eq(item.id, itemId));
}

export async function setPlanItemSequences(tx: DbOrTxClient, orderedIds: string[]) {
  for (let i = 0; i < orderedIds.length; i += 1) {
    await tx.update(item).set({ sequence: i }).where(eq(item.id, orderedIds[i]));
  }
}

export async function listPlanItemCriteria(itemIds: string[], client: DbOrTxClient = db) {
  if (itemIds.length === 0) return [];
  return client
    .select({
      itemId: schema.apprTaskPlanItemCriterion.itemId,
      criterionId: schema.apprTaskPlanItemCriterion.criterionId,
      code: schema.apprCriterion.code
    })
    .from(schema.apprTaskPlanItemCriterion)
    .innerJoin(schema.apprCriterion, eq(schema.apprCriterion.id, schema.apprTaskPlanItemCriterion.criterionId))
    .where(inArray(schema.apprTaskPlanItemCriterion.itemId, itemIds))
    .orderBy(asc(schema.apprCriterion.sort), asc(schema.apprCriterion.code));
}

export async function replacePlanItemCriteria(tx: DbOrTxClient, itemId: string, criterionIds: string[]) {
  await tx.delete(schema.apprTaskPlanItemCriterion).where(eq(schema.apprTaskPlanItemCriterion.itemId, itemId));
  if (criterionIds.length === 0) return;
  await tx
    .insert(schema.apprTaskPlanItemCriterion)
    .values(criterionIds.map((criterionId) => ({ itemId, criterionId })));
}

// ── Tasks ──

export async function getApprTask(taskId: string, client: DbOrTxClient = db) {
  const [row] = await client.select().from(t).where(eq(t.id, taskId)).limit(1);
  return row ?? null;
}

export async function listTasksForEnrolment(enrolmentId: string, client: DbOrTxClient = db) {
  return client
    .select({ ...getTableColumns(t), planTitle: plan.title })
    .from(t)
    .leftJoin(plan, eq(plan.id, t.planId))
    .where(eq(t.enrolmentId, enrolmentId))
    .orderBy(sql`${t.dueDate} asc nulls last`, asc(t.createdAt), asc(t.id));
}

export async function listTaskCriteria(taskIds: string[], client: DbOrTxClient = db) {
  if (taskIds.length === 0) return [];
  return client
    .select({
      taskId: schema.apprTaskCriterion.taskId,
      criterionId: schema.apprTaskCriterion.criterionId,
      code: schema.apprCriterion.code
    })
    .from(schema.apprTaskCriterion)
    .innerJoin(schema.apprCriterion, eq(schema.apprCriterion.id, schema.apprTaskCriterion.criterionId))
    .where(inArray(schema.apprTaskCriterion.taskId, taskIds))
    .orderBy(asc(schema.apprCriterion.sort), asc(schema.apprCriterion.code));
}

export async function replaceTaskCriteria(tx: DbOrTxClient, taskId: string, criterionIds: string[]) {
  await tx.delete(schema.apprTaskCriterion).where(eq(schema.apprTaskCriterion.taskId, taskId));
  if (criterionIds.length === 0) return;
  await tx.insert(schema.apprTaskCriterion).values(criterionIds.map((criterionId) => ({ taskId, criterionId })));
}

export async function insertTaskCriteria(
  tx: DbOrTxClient,
  rows: { taskId: string; criterionId: string }[]
): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(schema.apprTaskCriterion).values(rows).onConflictDoNothing();
}

/** Evidence linked to these tasks (newest activity first) — for the Tasks tab summary. */
export async function listEvidenceForTasks(taskIds: string[], client: DbOrTxClient = db) {
  if (taskIds.length === 0) return [];
  const ev = schema.apprEvidence;
  return client
    .select({ taskId: ev.taskId, id: ev.id, title: ev.title, status: ev.status, updatedAt: ev.updatedAt })
    .from(ev)
    .where(inArray(ev.taskId, taskIds))
    .orderBy(desc(ev.updatedAt), desc(ev.id));
}

/** Insert tasks; (enrolment, plan item) pairs that already exist are skipped. Returns only the rows actually created. */
export async function insertApprTasksSkippingExisting(tx: DbOrTxClient, rows: (typeof t.$inferInsert)[]) {
  if (rows.length === 0) return [];
  return tx
    .insert(t)
    .values(rows)
    .onConflictDoNothing({ target: [t.enrolmentId, t.planItemId] })
    .returning();
}

export async function insertApprTask(tx: DbOrTxClient, values: typeof t.$inferInsert) {
  const [row] = await tx.insert(t).values(values).returning();
  return row;
}

export async function updateApprTask(
  tx: DbOrTxClient,
  taskId: string,
  patch: Partial<
    Pick<
      ApprTaskRow,
      'title' | 'details' | 'typeKey' | 'dueDate' | 'expectedMinutes' | 'files' | 'status' | 'overdueNotifiedAt'
    >
  >,
  expectedStatus?: string
) {
  const [row] = await tx
    .update(t)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(expectedStatus ? and(eq(t.id, taskId), eq(t.status, expectedStatus)) : eq(t.id, taskId))
    .returning();
  return row ?? null;
}

/** Detach evidence from a task that is being deleted (appr_evidence.task_id has no FK). Returns the evidence ids. */
export async function clearEvidenceTaskId(tx: DbOrTxClient, taskId: string): Promise<string[]> {
  const rows = await tx
    .update(schema.apprEvidence)
    .set({ taskId: null })
    .where(eq(schema.apprEvidence.taskId, taskId))
    .returning({ id: schema.apprEvidence.id });
  return rows.map((r) => r.id);
}

export async function deleteApprTask(tx: DbOrTxClient, taskId: string) {
  await tx.delete(t).where(eq(t.id, taskId));
}

const noEvidence = sql`not exists (select 1 from appr_evidence e where e.task_id = ${sql.raw('"appr_task"."id"')})`;

/** Remove PLANNED tasks (no evidence) of one plan for some enrolments; returns the removed count. */
export async function deletePlannedPlanTasks(tx: DbOrTxClient, planId: string, enrolmentIds: string[]) {
  if (enrolmentIds.length === 0) return 0;
  const rows = await tx
    .delete(t)
    .where(and(eq(t.planId, planId), inArray(t.enrolmentId, enrolmentIds), eq(t.status, 'PLANNED'), noEvidence))
    .returning({ id: t.id });
  return rows.length;
}

/** Remove PLANNED tasks (no evidence) built from one plan item (the item is being deleted). */
export async function deletePlannedItemTasks(tx: DbOrTxClient, planItemId: string) {
  const rows = await tx
    .delete(t)
    .where(and(eq(t.planItemId, planItemId), eq(t.status, 'PLANNED'), noEvidence))
    .returning({ id: t.id });
  return rows.length;
}

/** Remove every PLANNED task of a plan (the plan is being deleted; callers checked nothing has evidence). */
export async function deleteAllPlannedPlanTasks(tx: DbOrTxClient, planId: string) {
  await tx.delete(t).where(and(eq(t.planId, planId), eq(t.status, 'PLANNED'), noEvidence));
}

/** Still-PLANNED tasks of a plan with the learner's start date (the due date is recomputed from it on sync). */
export async function listPlannedPlanTasks(planId: string, client: DbOrTxClient = db) {
  return client
    .select({ task: t, startDate: schema.apprEnrolment.startDate })
    .from(t)
    .innerJoin(schema.apprEnrolment, eq(schema.apprEnrolment.id, t.enrolmentId))
    .where(and(eq(t.planId, planId), eq(t.status, 'PLANNED')));
}

/** Take a row lock on the task so concurrent evidence writes recompute its status one after the other. */
export async function lockApprTask(tx: DbOrTxClient, taskId: string) {
  await tx.select({ id: t.id }).from(t).where(eq(t.id, taskId)).for('update');
}

/** Does this tutor reach (named or programme tutor) any learner holding a task from the plan? (plan-brief download) */
export async function isTutorAllocatedToPlanLearner(planId: string, tutorId: string, client: DbOrTxClient = db) {
  const [row] = await client
    .select({ n: sql<number>`1` })
    .from(t)
    .where(and(eq(t.planId, planId), tutorReachSql('"appr_task"."learner_id"', '"appr_task"."programme_id"', tutorId)))
    .limit(1);
  return Boolean(row);
}

/** Newest-activity-first evidence statuses of one task (input of taskStatusFromEvidence). */
export async function listTaskEvidenceStatuses(taskId: string, client: DbOrTxClient = db) {
  const ev = schema.apprEvidence;
  return client
    .select({ id: ev.id, status: ev.status })
    .from(ev)
    .where(eq(ev.taskId, taskId))
    .orderBy(desc(ev.updatedAt), desc(ev.id));
}

/** Set the cached status; returns true when it changed. */
export async function setApprTaskStatus(tx: DbOrTxClient, taskId: string, status: string): Promise<boolean> {
  const rows = await tx
    .update(t)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(and(eq(t.id, taskId), ne(t.status, status)))
    .returning({ id: t.id });
  return rows.length > 0;
}

export interface OverdueTaskScope {
  organizationId: string;
  programmeId?: string;
  /** TUTOR actor: only rows this tutor reaches (named tutor or programme tutor). */
  restrictToTutorId?: string;
}

/** Overdue tasks (due date passed, not COMPLETE), most overdue first, one page (+ total via a window count). */
export async function listOverdueTasks(
  scope: OverdueTaskScope,
  today: string,
  page: { limit: number; offset: number },
  client: DbOrTxClient = db
) {
  const conditions: (SQL | undefined)[] = [
    eq(t.organizationId, scope.organizationId),
    lt(t.dueDate, today),
    ne(t.status, 'COMPLETE')
  ];
  if (scope.programmeId) conditions.push(eq(t.programmeId, scope.programmeId));
  if (scope.restrictToTutorId) {
    conditions.push(tutorReachSql('"appr_task"."learner_id"', '"appr_task"."programme_id"', scope.restrictToTutorId));
  }
  return client
    .select({
      id: t.id,
      title: t.title,
      dueDate: t.dueDate,
      status: t.status,
      planTitle: plan.title,
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
    .leftJoin(plan, eq(plan.id, t.planId))
    .where(and(...conditions))
    .orderBy(asc(t.dueDate), asc(t.id))
    .limit(page.limit)
    .offset(page.offset);
}

/**
 * Daily overdue scan: claim up to `limit` newly overdue tasks by stamping overdue_notified_at (so a second run — or a
 * concurrent one — can never pick the same task), and return what was claimed.
 */
export async function claimOverdueTasks(today: string, limit: number, client: DbOrTxClient = db) {
  const candidates = await client
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        lt(t.dueDate, today),
        ne(t.status, 'COMPLETE'),
        isNull(t.overdueNotifiedAt),
        // Learners at gateway / end-point assessment or achieved are no longer chased for tasks.
        sql`exists (select 1 from appr_enrolment en where en.id = ${sql.raw('"appr_task"."enrolment_id"')} and en.gateway_passed_at is null and en.achieved_at is null)`
      )
    )
    .orderBy(asc(t.dueDate), asc(t.id))
    .limit(limit);
  if (candidates.length === 0) return [];
  return client
    .update(t)
    .set({ overdueNotifiedAt: sql`now()` })
    .where(
      and(
        inArray(
          t.id,
          candidates.map((c) => c.id)
        ),
        lt(t.dueDate, today),
        ne(t.status, 'COMPLETE'),
        isNull(t.overdueNotifiedAt)
      )
    )
    .returning({ id: t.id, learnerId: t.learnerId, organizationId: t.organizationId, title: t.title });
}

/** Notification deep links: task id → its enrolment, title and the learner's display name. */
export async function getTaskLinkTargets(taskIds: string[], client: DbOrTxClient = db) {
  const out = new Map<string, { enrolmentId: string; title: string; learnerName: string | null }>();
  if (taskIds.length === 0) return out;
  const rows = await client
    .select({ id: t.id, title: t.title, enrolmentId: t.enrolmentId, learnerName: profileDisplayName })
    .from(t)
    .leftJoin(schema.profile, eq(schema.profile.id, t.learnerId))
    .where(inArray(t.id, taskIds));
  for (const r of rows) out.set(r.id, { enrolmentId: r.enrolmentId, title: r.title, learnerName: r.learnerName });
  return out;
}

/** Enrolments by id (assign / unassign validate every id belongs to the plan's programme + org). */
export async function listApprEnrolmentsByIds(enrolmentIds: string[], client: DbOrTxClient = db) {
  if (enrolmentIds.length === 0) return [];
  return client.select().from(schema.apprEnrolment).where(inArray(schema.apprEnrolment.id, enrolmentIds));
}

/** Still-PLANNED plan tasks of one enrolment with their plan item's month offset (start-date change re-dates them). */
export async function listPlannedPlanTasksForEnrolment(enrolmentId: string, client: DbOrTxClient = db) {
  return client
    .select({ id: t.id, dueDate: t.dueDate, monthOffset: item.monthOffset })
    .from(t)
    .innerJoin(item, eq(item.id, t.planItemId))
    .where(and(eq(t.enrolmentId, enrolmentId), eq(t.status, 'PLANNED')));
}
