import { randomUUID } from 'node:crypto';

import { AppError, ErrorCodes } from '@api/utils/errors';
import {
  assertEnrolmentWritable,
  assertStaff,
  isEnrolmentWritable,
  getEnrolmentForActor,
  getProgrammeForActor,
  requireAuthed
} from '@api/services/apprenticeship/access';
import { assertActiveType, assertAllowedFile, assertCriteriaInProgramme } from '@api/services/apprenticeship/checks';
import { notifySafely, notifyTasksAssigned } from '@api/services/apprenticeship/notifications';
import { todayIso } from '@api/services/apprenticeship/progress';
import { assertBriefFiles, toBriefFiles } from '@api/services/apprenticeship/tasks';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import { runInTransaction, type DbOrTxClient } from '@cio/db/drizzle';
import {
  countPlanTasksWithEvidence,
  isProgrammeTutor,
  isTutorAllocatedToPlanLearner,
  markUploadsRemoved,
  deleteAllPlannedPlanTasks,
  deletePlanItem,
  deletePlannedItemTasks,
  deletePlannedPlanItemTasks,
  deletePlannedPlanTasks,
  deleteTaskPlan,
  getPlanItem,
  getTaskPlan,
  insertApprTasksSkippingExisting,
  insertApprUploads,
  insertPlanItem,
  insertTaskCriteria,
  insertTaskPlan,
  listApprEnrolmentsByIds,
  listPlanAssignees,
  listPlanItemCriteria,
  listPlanItems,
  listPlanTaskCells,
  listPlannedPlanTasks,
  listTaskCriteria,
  listTaskPlans,
  listTasksForEnrolment,
  lockTaskPlan,
  markUploadsAttached,
  nextPlanItemSequence,
  replacePlanItemCriteria,
  replaceTaskCriteriaForTasks,
  setPlanItemSequences,
  updateApprTasksBulk,
  updatePlanItem,
  updateTaskPlan,
  type ApprTaskPlanItemRow,
  type ApprTaskPlanRow
} from '@cio/db/queries/apprenticeship';
import {
  apprenticeshipPlanKeyPrefix,
  apprenticeshipTaskKeyPrefix,
  generateApprenticeshipPlanFileKey
} from '@cio/core/utils/upload';
import { generateDocumentDownloadPresignedUrls, generateDocumentUploadPresignedUrl } from '@cio/core/utils/s3';
import { isWithinWindow, taskDueDate, toDayNumber } from '@cio/utils/functions/apprenticeship-progress';
import type {
  TaskFromPlanInput,
  TaskPlanAssignInput,
  TaskPlanCreateInput,
  TaskPlanItemCreateInput,
  TaskPlanItemUpdateInput,
  TaskPlanPresignInput,
  TaskPlanSyncInput,
  TaskPlanUnassignInput,
  TaskPlanUpdateInput
} from '@cio/utils/validation/apprenticeship';

// Gecko Apprenticeships — task plans (templates). Creating / editing / deleting / assigning plans is ADMIN only; the
// plan's items become per-learner tasks when assigned (due = learner start + month offset). A tutor can only give ONE
// learner they reach chosen items of an active plan ("Add from plan" — createTasksFromPlan); plan pages stay admin-only.
//
// Assignment model: a learner "holds" a plan item when an appr_task row exists with (enrolment, plan_item_id); there is no
// separate assignment table. "Whole plan" is derived (the learner holds a task for every current item). Assigning is
// idempotent (unique enrolment + plan item); unassigning removes only PLANNED tasks that have no evidence; "sync" pushes
// later item edits to tasks still PLANNED.
//
// Concurrency: every plan-level write locks the plan row FIRST (lockTaskPlan) and then re-reads the plan, its items and
// the held tasks inside the same transaction, so assign / unassign / sync / item changes on one plan run one after the
// other; the unique constraint stays the final guard.
//
// Due dates: rule = start + month offset (no start → no due date). An optional per-batch override gives every NEW task of
// the batch that exact date and marks it due_manual, which protects it from sync and from a start-date change. Staff
// editing a plan task's due date also sets due_manual; staff CLEARING it sets due_manual false so the rule date can return
// on the next sync / rebase (clearing means "back to the plan's rule", not "no date forever").
//
// Brief files live under apprenticeship/plans/{planId}/ and are shared by the plan, its items and the tasks copied from
// them, so removing a file from a plan/item never releases it for storage clean-up (tasks may still reference it);
// orphaned uploads are still collected by the daily job.

/** Keys that were on a record and are no longer in its new file list. */
const droppedKeys = (before: { key: string }[], after: { key: string }[]) => {
  const kept = new Set(after.map((f) => f.key));
  return before.map((f) => f.key).filter((k) => !kept.has(k));
};

const notFound = (what = 'Task plan') => new AppError(`${what} not found`, ErrorCodes.NOT_FOUND, 404);
const badRequest = (message: string, field?: string) => new AppError(message, ErrorCodes.VALIDATION_ERROR, 400, field);

function assertAdmin(actor: Actor) {
  const a = requireAuthed(actor);
  if (a.role !== 'ADMIN') throw new AppError('You do not have access to this action', ErrorCodes.FORBIDDEN, 403);
  return a;
}

/** A plan in the admin's org, or 404 (other orgs' ids cannot be probed). */
async function loadPlan(actor: Actor, planId: string): Promise<ApprTaskPlanRow> {
  const a = assertAdmin(actor);
  const plan = await getTaskPlan(planId);
  if (!plan || plan.organizationId !== a.orgId) throw notFound();
  return plan;
}

/** Lock the plan row and re-read it in the transaction (404 when it was deleted meanwhile or is not in the org). */
async function lockAndReloadPlan(tx: DbOrTxClient, planId: string, organizationId: string): Promise<ApprTaskPlanRow> {
  if (!(await lockTaskPlan(tx, planId))) throw notFound();
  const fresh = await getTaskPlan(planId, tx);
  if (!fresh || fresh.organizationId !== organizationId) throw notFound();
  return fresh;
}

const audit = (actor: Actor, action: string, entityId: string, metadata: Record<string, unknown> = {}) =>
  recordAudit({ actor, action, entityType: 'appr_task_plan', entityId, metadata });

function assertWindow(validFrom: string | null, validTo: string | null) {
  if (validFrom && validTo && toDayNumber(validTo)! < toDayNumber(validFrom)!) {
    throw badRequest('Valid to must be on or after valid from', 'validTo');
  }
}

// ── Reads ──

export async function listPlans(actor: Actor, query: { programmeId?: string; status?: string }) {
  const a = assertAdmin(actor);
  return listTaskPlans(a.orgId, query);
}

/**
 * The plan with its items (each with how many learners hold it) and its assignees (each with the items they hold and
 * whether they hold the whole plan, i.e. a task for every CURRENT item).
 */
export async function getPlanDetail(actor: Actor, planId: string) {
  const plan = await loadPlan(actor, planId);
  const [items, assignees, cells] = await Promise.all([
    listPlanItems(plan.id),
    listPlanAssignees(plan.id),
    listPlanTaskCells(plan.id)
  ]);
  const criteria = await listPlanItemCriteria(items.map((i) => i.id));

  const itemIds = new Set(items.map((i) => i.id));
  const heldByEnrolment = new Map<string, typeof cells>();
  const assignedByItem = new Map<string, number>();
  for (const cell of cells) {
    if (!cell.itemId || !itemIds.has(cell.itemId)) continue;
    heldByEnrolment.set(cell.enrolmentId, [...(heldByEnrolment.get(cell.enrolmentId) ?? []), cell]);
    assignedByItem.set(cell.itemId, (assignedByItem.get(cell.itemId) ?? 0) + 1);
  }

  const shapedAssignees = assignees.map((assignee) => {
    const held = heldByEnrolment.get(assignee.enrolmentId) ?? [];
    return {
      ...assignee,
      /** Per current plan item the learner holds. */
      items: held.map((c) => ({
        itemId: c.itemId as string,
        taskId: c.taskId,
        status: c.status,
        dueDate: c.dueDate,
        dueManual: c.dueManual
      })),
      heldCount: held.length,
      wholePlan: items.length > 0 && held.length === items.length
    };
  });

  return {
    plan,
    items: items.map((i) => ({
      ...i,
      criteria: criteria.filter((c) => c.itemId === i.id).map((c) => ({ id: c.criterionId, code: c.code })),
      /** Learners holding a task for this item. */
      assignedCount: assignedByItem.get(i.id) ?? 0
    })),
    assignees: shapedAssignees,
    wholePlanCount: shapedAssignees.filter((a) => a.wholePlan).length
  };
}

// ── Uploads ──

export async function presignPlanUploads(actor: Actor, input: TaskPlanPresignInput) {
  const a = assertAdmin(actor);
  let planId = input.planId;
  if (planId) {
    const plan = await getTaskPlan(planId);
    // An id that is not a plan yet is fine (a new plan being drafted) as long as it is not another org's plan.
    if (plan && plan.organizationId !== a.orgId) throw notFound();
  } else {
    planId = randomUUID();
  }

  for (const f of input.files) assertAllowedFile(f);
  const files = await Promise.all(
    input.files.map(async (f) => {
      let key: string;
      try {
        key = generateApprenticeshipPlanFileKey(planId!, f.name);
      } catch {
        throw badRequest(`"${f.name}" needs a file extension`, 'files');
      }
      return { name: f.name, key, uploadUrl: await generateDocumentUploadPresignedUrl(key, f.type) };
    })
  );
  await insertApprUploads(
    files.map((f) => ({ organizationId: a.orgId, learnerId: null, ownerId: a.userId, key: f.key }))
  );
  return { planId, files };
}

/** Signed download URLs for a plan's brief files (the plan's own or any of its items'). Admin, or an allocated tutor. */
export async function signPlanDownloads(actor: Actor, planId: string, keys: string[]) {
  const a = requireAuthed(actor);
  if (a.role !== 'ADMIN' && a.role !== 'TUTOR') {
    throw new AppError('You do not have access to this action', ErrorCodes.FORBIDDEN, 403);
  }
  const plan = await getTaskPlan(planId);
  if (!plan || plan.organizationId !== a.orgId) throw notFound();
  // A tutor sees a plan brief as a tutor of the plan's programme, or through a learner they reach who holds a task from it.
  if (
    a.role === 'TUTOR' &&
    !(await isProgrammeTutor(plan.programmeId, a.userId)) &&
    !(await isTutorAllocatedToPlanLearner(plan.id, a.userId))
  ) {
    throw notFound();
  }
  const items = await listPlanItems(plan.id);
  const owned = new Set([...plan.files, ...items.flatMap((i) => i.files)].map((f) => f.key));
  if (!keys.every((k) => owned.has(k))) {
    throw new AppError('You do not have access to these files', ErrorCodes.FORBIDDEN, 403);
  }
  return generateDocumentDownloadPresignedUrls(keys);
}

// ── Plan writes ──

export async function createPlan(actor: Actor, input: TaskPlanCreateInput) {
  const a = assertAdmin(actor);
  const programme = await getProgrammeForActor(a, input.programmeId);
  if (programme.status !== 'ACTIVE') throw badRequest('This programme is archived', 'programmeId');

  if (input.files.length > 0 && !input.id) throw badRequest('Upload the files before saving', 'files');
  const planId = input.id ?? randomUUID();
  if (input.id && (await getTaskPlan(input.id))) {
    throw new AppError('This plan has already been saved', ErrorCodes.CONFLICT, 409);
  }
  await assertBriefFiles(a.orgId, input.files, apprenticeshipPlanKeyPrefix(planId));

  const plan = await runInTransaction(async (tx) => {
    const row = await insertTaskPlan(tx, {
      id: planId,
      organizationId: a.orgId,
      programmeId: programme.id,
      title: input.title,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      files: toBriefFiles(input.files, [], a.userId),
      createdBy: a.userId
    });
    await markUploadsAttached(
      input.files.map((f) => f.key),
      tx
    );
    return row;
  });
  await audit(actor, 'appr.task_plan.created', planId, { programmeId: programme.id });
  return plan;
}

export async function updatePlan(actor: Actor, planId: string, input: TaskPlanUpdateInput) {
  const a = assertAdmin(actor);
  const plan = await loadPlan(actor, planId);
  assertWindow(
    input.validFrom !== undefined ? input.validFrom : plan.validFrom,
    input.validTo !== undefined ? input.validTo : plan.validTo
  );
  if (input.files) {
    await assertBriefFiles(plan.organizationId, input.files, apprenticeshipPlanKeyPrefix(plan.id), plan.files);
  }
  const { files, ...fields } = input;
  const updated = await runInTransaction(async (tx) => {
    // Serialises with assign: the window / archive state an assign checks cannot change under it.
    await lockTaskPlan(tx, plan.id);
    const row = await updateTaskPlan(tx, plan.id, {
      ...fields,
      ...(files ? { files: toBriefFiles(files, plan.files, a.userId) } : {})
    });
    if (!row) throw notFound();
    if (files) {
      await markUploadsAttached(
        files.map((f) => f.key),
        tx
      );
      await markUploadsRemoved(droppedKeys(plan.files, files), tx);
    }
    return row;
  });
  await audit(actor, 'appr.task_plan.updated', plan.id, { fields: Object.keys(input) });
  return updated;
}

export async function setPlanArchived(actor: Actor, planId: string, archived: boolean) {
  const plan = await loadPlan(actor, planId);
  const updated = await runInTransaction(async (tx) => {
    await lockTaskPlan(tx, plan.id);
    return updateTaskPlan(tx, plan.id, { status: archived ? 'ARCHIVED' : 'ACTIVE' });
  });
  await audit(actor, archived ? 'appr.task_plan.archived' : 'appr.task_plan.unarchived', plan.id);
  return updated;
}

/** Delete a plan. Refused (409) once any task from it has evidence; otherwise its still-PLANNED tasks go with it. */
export async function deletePlan(actor: Actor, planId: string) {
  const plan = await loadPlan(actor, planId);
  if ((await countPlanTasksWithEvidence(plan.id)) > 0) {
    throw new AppError(
      'Learners have already answered tasks from this plan, so it cannot be deleted. Archive it instead.',
      ErrorCodes.CONFLICT,
      409
    );
  }
  const items = await listPlanItems(plan.id);
  await runInTransaction(async (tx) => {
    await lockTaskPlan(tx, plan.id);
    await deleteAllPlannedPlanTasks(tx, plan.id);
    await deleteTaskPlan(tx, plan.id);
    await markUploadsRemoved(
      [...plan.files, ...items.flatMap((i) => i.files)].map((f) => f.key),
      tx
    );
  });
  await audit(actor, 'appr.task_plan.deleted', plan.id);
  return { deleted: true };
}

// ── Items ──

async function loadItem(plan: ApprTaskPlanRow, itemId: string) {
  const item = await getPlanItem(itemId);
  if (!item || item.planId !== plan.id) throw notFound('Task');
  return item;
}

async function withCriteria<T extends { id: string }>(item: T) {
  const criteria = await listPlanItemCriteria([item.id]);
  return { ...item, criteria: criteria.map((c) => ({ id: c.criterionId, code: c.code })) };
}

/** Enrolments that hold a task for EVERY one of these items (the learners "on the whole plan"). Empty items → nobody. */
function wholePlanHolders(itemIds: string[], cells: { enrolmentId: string; itemId: string | null }[]): string[] {
  if (itemIds.length === 0) return [];
  const wanted = new Set(itemIds);
  const heldBy = new Map<string, Set<string>>();
  for (const cell of cells) {
    if (!cell.itemId || !wanted.has(cell.itemId)) continue;
    const held = heldBy.get(cell.enrolmentId) ?? new Set<string>();
    held.add(cell.itemId);
    heldBy.set(cell.enrolmentId, held);
  }
  return [...heldBy].filter(([, held]) => held.size === wanted.size).map(([enrolmentId]) => enrolmentId);
}

/**
 * Add a task to a plan. assignTo WHOLE_PLAN also creates it for the learners who hold EVERY item of the plan as it was
 * BEFORE this insert (decided inside the locked transaction, so a concurrent assign / unassign cannot slip in between).
 * An archived plan or one outside its valid window still gets the item; the auto-assign is skipped with a reason.
 */
export async function createPlanItem(
  actor: Actor,
  planId: string,
  input: TaskPlanItemCreateInput,
  now: Date = new Date()
) {
  const a = assertAdmin(actor);
  const plan = await loadPlan(actor, planId);
  await assertActiveType(plan.organizationId, input.typeKey);
  const criterionIds = await assertCriteriaInProgramme(plan.programmeId, input.criterionIds);
  await assertBriefFiles(plan.organizationId, input.files, apprenticeshipPlanKeyPrefix(plan.id));

  const outcome = await runInTransaction(async (tx) => {
    const fresh = await lockAndReloadPlan(tx, plan.id, a.orgId);
    const sequence = input.sequence ?? (await nextPlanItemSequence(plan.id, tx));

    // Holders are computed BEFORE the new item exists, under the lock.
    let holderIds: string[] = [];
    let skippedReason: AssignBlockReason | undefined;
    if (input.assignTo === 'WHOLE_PLAN') {
      skippedReason = assignBlockReason(fresh, now) ?? undefined;
      if (!skippedReason) {
        const [existingItems, cells] = await Promise.all([listPlanItems(plan.id, tx), listPlanTaskCells(plan.id, tx)]);
        holderIds = wholePlanHolders(
          existingItems.map((i) => i.id),
          cells
        );
      }
    }

    const row = await insertPlanItem(tx, {
      planId: plan.id,
      title: input.title,
      details: input.details,
      typeKey: input.typeKey,
      sequence,
      monthOffset: input.monthOffset,
      expectedMinutes: input.expectedMinutes,
      files: toBriefFiles(input.files, [], a.userId)
    });
    await replacePlanItemCriteria(tx, row.id, criterionIds);
    await markUploadsAttached(
      input.files.map((f) => f.key),
      tx
    );

    let created: CreatedTask[] = [];
    if (holderIds.length > 0) {
      const holders = (await splitWritable(await listApprEnrolmentsByIds(holderIds, tx))).writable;
      const result = await insertPlanTasks(tx, fresh, holders, [row], a.userId, null);
      created = result.created;
    }
    return { row, created, skippedReason };
  });

  await notifyAssigned(outcome.created);
  const learners = new Set(outcome.created.map((t) => t.learnerId)).size;
  await audit(actor, 'appr.task_plan.item_created', plan.id, {
    itemId: outcome.row.id,
    autoAssigned: outcome.created.length,
    learners
  });
  return {
    ...(await withCriteria(outcome.row)),
    assigned: {
      created: outcome.created.length,
      learners,
      ...(outcome.skippedReason ? { skippedReason: outcome.skippedReason } : {})
    }
  };
}

export async function updatePlanItemById(actor: Actor, planId: string, itemId: string, input: TaskPlanItemUpdateInput) {
  const a = assertAdmin(actor);
  const plan = await loadPlan(actor, planId);
  const item = await loadItem(plan, itemId);
  if (input.typeKey !== undefined && input.typeKey !== item.typeKey) {
    await assertActiveType(plan.organizationId, input.typeKey);
  }
  const criterionIds = input.criterionIds
    ? await assertCriteriaInProgramme(plan.programmeId, input.criterionIds)
    : undefined;
  if (input.files) {
    await assertBriefFiles(plan.organizationId, input.files, apprenticeshipPlanKeyPrefix(plan.id), item.files);
  }
  const { criterionIds: _ids, files, ...fields } = input;
  const updated = await runInTransaction(async (tx) => {
    const row = await updatePlanItem(tx, item.id, {
      ...fields,
      ...(files ? { files: toBriefFiles(files, item.files, a.userId) } : {})
    });
    if (!row) throw notFound('Task');
    if (criterionIds) await replacePlanItemCriteria(tx, item.id, criterionIds);
    if (files) {
      await markUploadsAttached(
        files.map((f) => f.key),
        tx
      );
      await markUploadsRemoved(droppedKeys(item.files, files), tx);
    }
    return row;
  });
  await audit(actor, 'appr.task_plan.item_updated', plan.id, { itemId: item.id, fields: Object.keys(input) });
  return withCriteria(updated);
}

/** Delete an item. Learners' still-PLANNED tasks from it go too; tasks with evidence stay (detached from the plan). */
export async function deletePlanItemById(actor: Actor, planId: string, itemId: string) {
  const a = assertAdmin(actor);
  const plan = await loadPlan(actor, planId);
  const item = await loadItem(plan, itemId);
  const removedTasks = await runInTransaction(async (tx) => {
    // Locked first: an assign running at the same time cannot insert tasks for an item that is going away (FK error).
    await lockAndReloadPlan(tx, plan.id, a.orgId);
    const stillThere = await getPlanItem(item.id, tx);
    if (!stillThere || stillThere.planId !== plan.id) throw notFound('Task');
    const removed = await deletePlannedItemTasks(tx, item.id);
    await deletePlanItem(tx, item.id);
    await markUploadsRemoved(
      item.files.map((f) => f.key),
      tx
    );
    return removed;
  });
  await audit(actor, 'appr.task_plan.item_deleted', plan.id, { itemId: item.id, removedTasks });
  return { deleted: true, removedTasks };
}

export async function reorderPlanItems(actor: Actor, planId: string, orderedIds: string[]) {
  const plan = await loadPlan(actor, planId);
  const items = await listPlanItems(plan.id);
  const have = new Set(items.map((i) => i.id));
  if (
    orderedIds.length !== have.size ||
    new Set(orderedIds).size !== have.size ||
    !orderedIds.every((id) => have.has(id))
  ) {
    throw badRequest('Send every task of this plan exactly once', 'orderedIds');
  }
  await runInTransaction((tx) => setPlanItemSequences(tx, orderedIds));
  await audit(actor, 'appr.task_plan.reordered', plan.id);
  return { ordered: orderedIds.length };
}

// ── Assign / unassign / sync ──

type CreatedTask = Awaited<ReturnType<typeof insertApprTasksSkippingExisting>>[number];
type AssignBlockReason = 'ARCHIVED' | 'OUTSIDE_WINDOW';

/** Why a plan cannot be assigned right now (null = it can). */
function assignBlockReason(plan: ApprTaskPlanRow, now: Date): AssignBlockReason | null {
  if (plan.status !== 'ACTIVE') return 'ARCHIVED';
  if (!isWithinWindow(plan.validFrom, plan.validTo, todayIso(now))) return 'OUTSIDE_WINDOW';
  return null;
}

function assertAssignable(plan: ApprTaskPlanRow, now: Date) {
  const reason = assignBlockReason(plan, now);
  if (reason === 'ARCHIVED') throw badRequest('This plan is archived');
  if (reason === 'OUTSIDE_WINDOW') {
    throw badRequest('This plan can only be assigned between its valid from and valid to dates');
  }
}

/**
 * The plan items an operation is limited to. Omitted → every item. Every id must belong to THIS plan (a foreign / deleted
 * id is a 404 and nothing happens). Returned in plan order, de-duplicated.
 */
function pickItems(items: ApprTaskPlanItemRow[], itemIds?: string[]): ApprTaskPlanItemRow[] {
  if (!itemIds) return items;
  const wanted = new Set(itemIds);
  if (wanted.size === 0) throw badRequest('Choose at least one task', 'itemIds');
  const known = new Set(items.map((i) => i.id));
  if ([...wanted].some((id) => !known.has(id))) throw notFound('Task');
  return items.filter((i) => wanted.has(i.id));
}

/** Every id must be an enrolment of THIS plan's programme and org (a foreign id is a 400, never silently dropped). */
async function loadPlanEnrolments(plan: ApprTaskPlanRow, enrolmentIds: string[], client?: DbOrTxClient) {
  const unique = [...new Set(enrolmentIds)];
  const rows = client ? await listApprEnrolmentsByIds(unique, client) : await listApprEnrolmentsByIds(unique);
  if (
    rows.length !== unique.length ||
    rows.some((e) => e.organizationId !== plan.organizationId || e.programmeId !== plan.programmeId)
  ) {
    throw badRequest('One or more learners are not enrolled on this plan’s programme', 'enrolmentIds');
  }
  return rows;
}

/**
 * A withdrawn / closed apprenticeship is read-only: bulk assign, unassign and sync leave it out (no error, so one withdrawn
 * learner never blocks a batch). `skipped` is how many were left out.
 */
async function splitWritable<E extends { id: string; withdrawnAt?: string | null; primaryEnrolmentId?: string | null }>(
  rows: E[]
): Promise<{ writable: E[]; skipped: number }> {
  const writable: E[] = [];
  for (const row of rows) if (await isEnrolmentWritable(row)) writable.push(row);
  return { writable, skipped: rows.length - writable.length };
}

const MAX_OVERRIDE_DAYS_AHEAD = 3660; // ~10 years: catches typos like 2062 without blocking any real programme

/**
 * The optional per-batch due date. Must be a real date, within ~10 years of today, and not before the start date of any
 * learner in the batch (a task due before the learner began is a wrong flow — drop that learner or pick a later date).
 * A date in the past is allowed (back-filling a late learner) and is flagged in the response.
 */
function resolveDueOverride(
  dueDate: string | null | undefined,
  enrolments: { startDate: string | null }[],
  now: Date
): { date: string | null; inPast: boolean } {
  if (dueDate === null || dueDate === undefined || dueDate === '') return { date: null, inPast: false };
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? toDayNumber(dueDate) : null;
  if (day === null) throw badRequest('Use a valid date (YYYY-MM-DD)', 'dueDate');
  const today = toDayNumber(todayIso(now))!;
  if (day > today + MAX_OVERRIDE_DAYS_AHEAD) throw badRequest('That due date is too far in the future', 'dueDate');
  const beforeStart = enrolments.filter((e) => {
    const start = toDayNumber(e.startDate);
    return start !== null && day < start;
  }).length;
  if (beforeStart > 0) {
    throw badRequest(
      `That due date is before the start date of ${beforeStart} selected learner${beforeStart === 1 ? '' : 's'}. ` +
        'Nothing was created: choose a later date or remove them from the selection.',
      'dueDate'
    );
  }
  return { date: dueDate, inPast: day < today };
}

/**
 * The learners of a batch that would actually get a NEW task (they do not already hold every target item). Only those are
 * checked against a batch due date: a learner who already holds everything is skipped and must not block the batch.
 */
async function learnersMissingTasks<E extends { id: string }>(
  tx: DbOrTxClient,
  planId: string,
  enrolments: E[],
  targets: ApprTaskPlanItemRow[]
): Promise<E[]> {
  const cells = await listPlanTaskCells(planId, tx);
  const held = new Set(cells.map((c) => `${c.enrolmentId}:${c.itemId}`));
  return enrolments.filter((e) => targets.some((item) => !held.has(`${e.id}:${item.id}`)));
}

/**
 * One task row per (enrolment, item). Due = start + month offset (no start → no due date), or the batch override, which
 * also sets due_manual so later syncs / start-date changes never move it.
 */
export function buildTaskRows(
  plan: Pick<ApprTaskPlanRow, 'id' | 'organizationId' | 'programmeId'>,
  enrolments: { id: string; learnerId: string; startDate: string | null }[],
  items: ApprTaskPlanItemRow[],
  createdBy: string,
  dueOverride: string | null = null
) {
  return enrolments.flatMap((e) =>
    items.map((item) => ({
      organizationId: plan.organizationId,
      programmeId: plan.programmeId,
      enrolmentId: e.id,
      learnerId: e.learnerId,
      planId: plan.id,
      planItemId: item.id,
      title: item.title,
      details: item.details,
      typeKey: item.typeKey,
      dueDate: dueOverride ?? taskDueDate(e.startDate, item.monthOffset),
      dueManual: dueOverride !== null,
      expectedMinutes: item.expectedMinutes,
      files: item.files,
      createdBy
    }))
  );
}

/** Insert the tasks (pairs that already exist are skipped) and copy each item's criteria onto the new tasks. In the caller's tx. */
async function insertPlanTasks(
  tx: DbOrTxClient,
  plan: Pick<ApprTaskPlanRow, 'id' | 'organizationId' | 'programmeId'>,
  enrolments: { id: string; learnerId: string; startDate: string | null }[],
  items: ApprTaskPlanItemRow[],
  createdBy: string,
  dueOverride: string | null
) {
  const rows = buildTaskRows(plan, enrolments, items, createdBy, dueOverride);
  const created = await insertApprTasksSkippingExisting(tx, rows);
  if (created.length > 0) {
    const itemCriteria = await listPlanItemCriteria(
      items.map((i) => i.id),
      tx
    );
    const criteriaByItem = new Map<string, string[]>();
    for (const c of itemCriteria)
      criteriaByItem.set(c.itemId, [...(criteriaByItem.get(c.itemId) ?? []), c.criterionId]);
    await insertTaskCriteria(
      tx,
      created.flatMap((task) =>
        (criteriaByItem.get(task.planItemId ?? '') ?? []).map((criterionId) => ({ taskId: task.id, criterionId }))
      )
    );
  }
  return { created, total: rows.length };
}

/** After commit, never fatal: ONE notification per learner per call (entity = their first newly created task). */
async function notifyAssigned(created: { id: string; learnerId: string }[]) {
  const firstTaskByLearner = new Map<string, string>();
  for (const task of created)
    if (!firstTaskByLearner.has(task.learnerId)) firstTaskByLearner.set(task.learnerId, task.id);
  for (const [learnerId, taskId] of firstTaskByLearner) {
    await notifySafely('task assigned', () => notifyTasksAssigned({ taskId, learnerId }));
  }
}

/** The counts every create path reports (so the UI can warn about tasks that are already overdue / have no date). */
function summariseCreated(created: CreatedTask[], total: number, today: string) {
  return {
    created: created.length,
    skipped: total - created.length,
    learners: new Set(created.map((t) => t.learnerId)).size,
    /** New tasks whose due date is already in the past. */
    pastDue: created.filter((t) => t.dueDate !== null && t.dueDate < today).length,
    /** New tasks with no due date (the learner has no start date and no batch date was given). */
    undated: created.filter((t) => t.dueDate === null).length
  };
}

/**
 * Give learners the whole plan (itemIds omitted) or only some of its tasks. Existing (learner, task) pairs are skipped,
 * so re-running is safe. Optional dueDate = a batch due date for every NEW task (protected from sync / start changes).
 */
export async function assignPlan(actor: Actor, planId: string, input: TaskPlanAssignInput, now: Date = new Date()) {
  const a = assertAdmin(actor);
  const plan = await loadPlan(actor, planId);

  const outcome = await runInTransaction(async (tx) => {
    const fresh = await lockAndReloadPlan(tx, plan.id, a.orgId);
    assertAssignable(fresh, now);
    const { writable: enrolments, skipped: withdrawnSkipped } = await splitWritable(
      await loadPlanEnrolments(fresh, input.enrolmentIds, tx)
    );
    const items = await listPlanItems(fresh.id, tx);
    if (items.length === 0) throw badRequest('Add at least one task to this plan before assigning it');
    const targets = pickItems(items, input.itemIds);
    const checked = input.dueDate ? await learnersMissingTasks(tx, fresh.id, enrolments, targets) : enrolments;
    const override = resolveDueOverride(input.dueDate, checked, now);
    const result = await insertPlanTasks(tx, fresh, enrolments, targets, a.userId, override.date);
    return { ...result, enrolments: enrolments.length, withdrawnSkipped, targets, override };
  });

  await notifyAssigned(outcome.created);
  const summary = summariseCreated(outcome.created, outcome.total, todayIso(now));
  await audit(actor, 'appr.task_plan.assigned', plan.id, {
    enrolments: outcome.enrolments,
    created: summary.created,
    skipped: summary.skipped,
    withdrawnSkipped: outcome.withdrawnSkipped,
    mode: input.itemIds ? 'ITEMS' : 'ALL',
    itemIds: input.itemIds ? outcome.targets.map((i) => i.id) : null,
    dueOverride: outcome.override.date
  });
  return {
    ...summary,
    /** Learners left out because their apprenticeship is withdrawn (read-only). */
    withdrawnSkipped: outcome.withdrawnSkipped,
    dueOverride: outcome.override.date,
    overrideInPast: outcome.override.inPast
  };
}

/**
 * Remove PLANNED tasks with no evidence, for these learners: the whole plan, or only the chosen items. Tasks that were
 * answered or started are left alone and counted in `kept`.
 */
export async function unassignPlan(actor: Actor, planId: string, input: TaskPlanUnassignInput) {
  const a = assertAdmin(actor);
  const plan = await loadPlan(actor, planId);

  const outcome = await runInTransaction(async (tx) => {
    const fresh = await lockAndReloadPlan(tx, plan.id, a.orgId);
    const { writable: enrolments } = await splitWritable(await loadPlanEnrolments(fresh, input.enrolmentIds, tx));
    const enrolmentIds = enrolments.map((e) => e.id);
    const items = input.itemIds ? await listPlanItems(fresh.id, tx) : [];
    const targets = input.itemIds ? pickItems(items, input.itemIds) : null;
    const targetIds = targets ? new Set(targets.map((i) => i.id)) : null;

    const cells = await listPlanTaskCells(fresh.id, tx);
    const enrolmentSet = new Set(enrolmentIds);
    const heldBefore = cells.filter(
      (c) => enrolmentSet.has(c.enrolmentId) && (!targetIds || (c.itemId !== null && targetIds.has(c.itemId)))
    ).length;

    const removed = targets
      ? (
          await deletePlannedPlanItemTasks(
            tx,
            fresh.id,
            enrolmentIds,
            targets.map((i) => i.id)
          )
        ).length
      : await deletePlannedPlanTasks(tx, fresh.id, enrolmentIds);
    return { removed, kept: Math.max(0, heldBefore - removed), enrolments: enrolmentIds.length, targets };
  });

  await audit(actor, 'appr.task_plan.unassigned', plan.id, {
    enrolments: outcome.enrolments,
    removed: outcome.removed,
    kept: outcome.kept,
    itemIds: outcome.targets ? outcome.targets.map((i) => i.id) : null
  });
  return { removed: outcome.removed, kept: outcome.kept };
}

/** key → its criterion ids, sorted (so two lists compare equal when they hold the same criteria). */
function groupCriteria(rows: { key: string; criterionId: string }[]): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const row of rows) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row.criterionId]);
  for (const ids of byKey.values()) ids.sort();
  return byKey;
}

/**
 * Push the plan items' current title / details / type / minutes / files / criteria / due date to still-PLANNED tasks:
 * every item (itemIds omitted) or only the chosen ones. Never creates tasks. A task with a hand-set (due_manual) due date
 * keeps it; the rest follow start + offset.
 */
export async function syncPlan(actor: Actor, planId: string, input: TaskPlanSyncInput = {}) {
  const a = assertAdmin(actor);
  const plan = await loadPlan(actor, planId);

  const outcome = await runInTransaction(async (tx) => {
    const fresh = await lockAndReloadPlan(tx, plan.id, a.orgId);
    const items = await listPlanItems(fresh.id, tx);
    const targets = pickItems(items, input.itemIds);
    const itemById = new Map(items.map((i) => [i.id, i]));
    const itemCriteria = await listPlanItemCriteria(
      items.map((i) => i.id),
      tx
    );
    const plannedAll = await listPlannedPlanTasks(fresh.id, tx, input.itemIds ? targets.map((i) => i.id) : undefined);
    // Tasks of a withdrawn / closed apprenticeship are frozen: sync leaves them alone.
    const plannedEnrolmentIds = [...new Set(plannedAll.map((p) => p.task.enrolmentId))];
    const enrolmentRows = plannedEnrolmentIds.length > 0 ? await listApprEnrolmentsByIds(plannedEnrolmentIds, tx) : [];
    const frozen = new Set<string>();
    for (const row of enrolmentRows) if (row.withdrawnAt && !(await isEnrolmentWritable(row))) frozen.add(row.id);
    const planned = plannedAll.filter((p) => !frozen.has(p.task.enrolmentId));
    const taskCriteria = await listTaskCriteria(
      planned.map((p) => p.task.id),
      tx
    );

    // Index once instead of filtering the whole criteria lists per task.
    const wantByItem = groupCriteria(itemCriteria.map((c) => ({ key: c.itemId, criterionId: c.criterionId })));
    const haveByTask = groupCriteria(taskCriteria.map((c) => ({ key: c.taskId, criterionId: c.criterionId })));

    // Tasks that need the SAME new values go in ONE UPDATE … WHERE id IN (…) (and one criteria replacement per item),
    // not a round trip each: a plan with hundreds of learners would otherwise hold the plan lock for thousands of
    // statements. A group = same item, same files, same due-date action.
    interface SyncGroup {
      item: ApprTaskPlanItemRow;
      files: ApprTaskPlanItemRow['files'];
      /** The new due date to write, or undefined to leave the column alone (hand-set / batch dates). */
      dueDate: string | null | undefined;
      resetOverdue: boolean;
      taskIds: string[];
    }
    const groups = new Map<string, SyncGroup>();
    const criteriaChanged = new Set<string>();
    let manualDueKept = 0;
    for (const { task, startDate } of planned) {
      const item = task.planItemId ? itemById.get(task.planItemId) : undefined;
      if (!item) continue; // its item was deleted: the task is now standalone
      const ruleDue = taskDueDate(startDate, item.monthOffset);
      // A hand-set / batch-override date is the task's own: sync never overwrites it.
      const dueDate = task.dueManual ? task.dueDate : ruleDue;
      if (task.dueManual && ruleDue !== task.dueDate) manualDueKept += 1;
      const wantCriteria = wantByItem.get(item.id) ?? [];
      const haveCriteria = haveByTask.get(task.id) ?? [];
      const sameCriteria = JSON.stringify(wantCriteria) === JSON.stringify(haveCriteria);
      // The task's own brief files (uploaded for this task alone) survive a sync; only the plan briefs are replaced.
      const ownPrefix = apprenticeshipTaskKeyPrefix(task.programmeId, task.learnerId, task.id);
      const files = [...item.files, ...task.files.filter((f) => f.key.startsWith(ownPrefix))];
      const same =
        task.title === item.title &&
        task.details === item.details &&
        task.typeKey === item.typeKey &&
        task.expectedMinutes === item.expectedMinutes &&
        task.dueDate === dueDate &&
        JSON.stringify(task.files) === JSON.stringify(files) &&
        sameCriteria;
      if (same) continue;
      if (!sameCriteria) criteriaChanged.add(task.id);
      const writeDue = task.dueManual ? undefined : dueDate;
      const resetOverdue = dueDate !== task.dueDate;
      const groupKey = JSON.stringify([item.id, files, writeDue === undefined ? '__keep' : writeDue, resetOverdue]);
      const group = groups.get(groupKey);
      if (group) group.taskIds.push(task.id);
      else groups.set(groupKey, { item, files, dueDate: writeDue, resetOverdue, taskIds: [task.id] });
    }

    let updated = 0;
    for (const group of groups.values()) {
      // Conditional on PLANNED: a task answered meanwhile is left alone (and not counted).
      const updatedIds = await updateApprTasksBulk(
        tx,
        group.taskIds,
        {
          title: group.item.title,
          details: group.item.details,
          typeKey: group.item.typeKey,
          expectedMinutes: group.item.expectedMinutes,
          files: group.files,
          ...(group.dueDate !== undefined ? { dueDate: group.dueDate } : {}),
          ...(group.resetOverdue ? { overdueNotifiedAt: null } : {})
        },
        'PLANNED'
      );
      updated += updatedIds.length;
      // Criteria are rewritten only for tasks that really changed (and were not lost to a race).
      const needCriteria = updatedIds.filter((id) => criteriaChanged.has(id));
      if (needCriteria.length > 0) {
        await replaceTaskCriteriaForTasks(tx, needCriteria, wantByItem.get(group.item.id) ?? []);
      }
    }
    return {
      updated,
      manualDueKept,
      withdrawnSkipped: plannedAll.length - planned.length,
      itemIds: input.itemIds ? targets.map((i) => i.id) : null
    };
  });

  await audit(actor, 'appr.task_plan.synced', plan.id, {
    updated: outcome.updated,
    itemIds: outcome.itemIds,
    manualDueKept: outcome.manualDueKept,
    withdrawnSkipped: outcome.withdrawnSkipped
  });
  return { updated: outcome.updated, manualDueKept: outcome.manualDueKept };
}

// ── Add from plan (staff, one learner) ──

/**
 * The active, in-window plans of a learner's programme with their items and which ones this learner already holds —
 * what a tutor / admin picks from on the learner's Tasks tab. Staff who reach the learner (404 otherwise); the plan
 * pages themselves stay admin-only.
 */
export async function listPlanItemsForEnrolment(actor: Actor, enrolmentId: string, now: Date = new Date()) {
  assertStaff(actor);
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  const today = todayIso(now);

  const plans = await listTaskPlans(enrolment.organizationId, { programmeId: enrolment.programmeId, status: 'ACTIVE' });
  const open = plans.filter((p) => p.itemCount > 0 && isWithinWindow(p.validFrom, p.validTo, today));
  const [held, itemLists] = await Promise.all([
    listTasksForEnrolment(enrolment.id),
    Promise.all(open.map((p) => listPlanItems(p.id)))
  ]);
  const heldByItem = new Map(held.filter((t) => t.planItemId).map((t) => [t.planItemId as string, t]));

  return {
    startDate: enrolment.startDate,
    plans: open.map((p, index) => ({
      id: p.id,
      title: p.title,
      validFrom: p.validFrom,
      validTo: p.validTo,
      items: itemLists[index].map((item) => {
        const heldTask = heldByItem.get(item.id);
        return {
          id: item.id,
          title: item.title,
          typeKey: item.typeKey,
          sequence: item.sequence,
          monthOffset: item.monthOffset,
          expectedMinutes: item.expectedMinutes,
          /** What the rule would give this learner (start + offset); null when they have no start date. */
          dueDate: taskDueDate(enrolment.startDate, item.monthOffset),
          held: Boolean(heldTask),
          taskId: heldTask?.id ?? null,
          status: heldTask?.status ?? null
        };
      })
    }))
  };
}

/**
 * Create the chosen items of an active plan for ONE learner the actor reaches (tutor or admin). Same rules as assign:
 * existing pairs skipped, archived / out-of-window refused, optional batch due date, one notification when anything was
 * created. A plan of another programme / org is a 404.
 */
export async function createTasksFromPlan(
  actor: Actor,
  enrolmentId: string,
  input: TaskFromPlanInput,
  now: Date = new Date()
) {
  const a = assertStaff(actor);
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  await assertEnrolmentWritable(enrolment);
  const planRow = await getTaskPlan(input.planId);
  if (
    !planRow ||
    planRow.organizationId !== enrolment.organizationId ||
    planRow.programmeId !== enrolment.programmeId
  ) {
    throw notFound();
  }

  const outcome = await runInTransaction(async (tx) => {
    const fresh = await lockAndReloadPlan(tx, planRow.id, enrolment.organizationId);
    assertAssignable(fresh, now);
    const enrolments = await listApprEnrolmentsByIds([enrolment.id], tx);
    if (enrolments.length !== 1) throw notFound('Learner portfolio');
    const items = await listPlanItems(fresh.id, tx);
    const targets = pickItems(items, input.itemIds);
    const checked = input.dueDate ? await learnersMissingTasks(tx, fresh.id, enrolments, targets) : enrolments;
    const override = resolveDueOverride(input.dueDate, checked, now);
    const result = await insertPlanTasks(tx, fresh, enrolments, targets, a.userId, override.date);
    return { ...result, override };
  });

  await notifyAssigned(outcome.created);
  const summary = summariseCreated(outcome.created, outcome.total, todayIso(now));
  if (outcome.created.length > 0) {
    await recordAudit({
      actor,
      action: 'appr.task.created',
      entityType: 'appr_task',
      entityId: outcome.created[0].id,
      metadata: {
        enrolmentId: enrolment.id,
        planId: planRow.id,
        itemIds: outcome.created.map((t) => t.planItemId),
        created: summary.created,
        fromPlan: true,
        dueOverride: outcome.override.date
      }
    });
  }
  return {
    ...summary,
    taskIds: outcome.created.map((t) => t.id),
    dueOverride: outcome.override.date,
    overrideInPast: outcome.override.inPast
  };
}
