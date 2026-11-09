import { randomUUID } from 'node:crypto';

import { AppError, ErrorCodes } from '@api/utils/errors';
import { getProgrammeForActor, requireAuthed } from '@api/services/apprenticeship/access';
import { assertActiveType, assertAllowedFile, assertCriteriaInProgramme } from '@api/services/apprenticeship/checks';
import { notifySafely, notifyTasksAssigned } from '@api/services/apprenticeship/notifications';
import { todayIso } from '@api/services/apprenticeship/progress';
import { assertBriefFiles, toBriefFiles } from '@api/services/apprenticeship/tasks';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import { runInTransaction } from '@cio/db/drizzle';
import {
  countPlanTasksWithEvidence,
  deleteAllPlannedPlanTasks,
  deletePlanItem,
  deletePlannedItemTasks,
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
  listPlannedPlanTasks,
  listTaskCriteria,
  listTaskPlans,
  markUploadsAttached,
  nextPlanItemSequence,
  replacePlanItemCriteria,
  replaceTaskCriteria,
  setPlanItemSequences,
  updateApprTask,
  updatePlanItem,
  updateTaskPlan,
  type ApprTaskPlanRow
} from '@cio/db/queries/apprenticeship';
import { apprenticeshipPlanKeyPrefix, generateApprenticeshipPlanFileKey } from '@cio/core/utils/upload';
import { generateDocumentDownloadPresignedUrls, generateDocumentUploadPresignedUrl } from '@cio/core/utils/s3';
import { isWithinWindow, taskDueDate, toDayNumber } from '@cio/utils/functions/apprenticeship-progress';
import type {
  TaskPlanAssignInput,
  TaskPlanCreateInput,
  TaskPlanItemCreateInput,
  TaskPlanItemUpdateInput,
  TaskPlanPresignInput,
  TaskPlanUpdateInput
} from '@cio/utils/validation/apprenticeship';

// Gecko Apprenticeships — task plans (templates). Creating / editing / deleting / assigning plans is ADMIN only; the
// plan's items become per-learner tasks when assigned (due = learner start + month offset). Assigning is idempotent
// (unique enrolment + plan item); unassigning removes only PLANNED tasks that have no evidence; "sync" pushes later item
// edits to tasks still PLANNED. Brief files live under apprenticeship/plans/{planId}/ and are shared by the plan, its
// items and the tasks copied from them, so removing a file from a plan/item never releases it for storage clean-up
// (tasks may still reference it); orphaned uploads are still collected by the daily job.

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

export async function getPlanDetail(actor: Actor, planId: string) {
  const plan = await loadPlan(actor, planId);
  const [items, assignees] = await Promise.all([listPlanItems(plan.id), listPlanAssignees(plan.id)]);
  const criteria = await listPlanItemCriteria(items.map((i) => i.id));
  return {
    plan,
    items: items.map((i) => ({
      ...i,
      criteria: criteria.filter((c) => c.itemId === i.id).map((c) => ({ id: c.criterionId, code: c.code }))
    })),
    assignees
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

/** Signed download URLs for a plan's brief files (the plan's own or any of its items'). Admin / any staff of the org. */
export async function signPlanDownloads(actor: Actor, planId: string, keys: string[]) {
  const a = requireAuthed(actor);
  if (a.role !== 'ADMIN' && a.role !== 'TUTOR') {
    throw new AppError('You do not have access to this action', ErrorCodes.FORBIDDEN, 403);
  }
  const plan = await getTaskPlan(planId);
  if (!plan || plan.organizationId !== a.orgId) throw notFound();
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
    const row = await updateTaskPlan(tx, plan.id, {
      ...fields,
      ...(files ? { files: toBriefFiles(files, plan.files, a.userId) } : {})
    });
    if (!row) throw notFound();
    if (files)
      await markUploadsAttached(
        files.map((f) => f.key),
        tx
      );
    return row;
  });
  await audit(actor, 'appr.task_plan.updated', plan.id, { fields: Object.keys(input) });
  return updated;
}

export async function setPlanArchived(actor: Actor, planId: string, archived: boolean) {
  const plan = await loadPlan(actor, planId);
  const updated = await runInTransaction((tx) =>
    updateTaskPlan(tx, plan.id, { status: archived ? 'ARCHIVED' : 'ACTIVE' })
  );
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
  await runInTransaction(async (tx) => {
    await deleteAllPlannedPlanTasks(tx, plan.id);
    await deleteTaskPlan(tx, plan.id);
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

export async function createPlanItem(actor: Actor, planId: string, input: TaskPlanItemCreateInput) {
  const a = assertAdmin(actor);
  const plan = await loadPlan(actor, planId);
  await assertActiveType(plan.organizationId, input.typeKey);
  const criterionIds = await assertCriteriaInProgramme(plan.programmeId, input.criterionIds);
  await assertBriefFiles(plan.organizationId, input.files, apprenticeshipPlanKeyPrefix(plan.id));
  const sequence = input.sequence ?? (await nextPlanItemSequence(plan.id));

  const item = await runInTransaction(async (tx) => {
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
    return row;
  });
  await audit(actor, 'appr.task_plan.item_created', plan.id, { itemId: item.id });
  return withCriteria(item);
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
    if (files)
      await markUploadsAttached(
        files.map((f) => f.key),
        tx
      );
    return row;
  });
  await audit(actor, 'appr.task_plan.item_updated', plan.id, { itemId: item.id, fields: Object.keys(input) });
  return withCriteria(updated);
}

/** Delete an item. Learners' still-PLANNED tasks from it go too; tasks with evidence stay (detached from the plan). */
export async function deletePlanItemById(actor: Actor, planId: string, itemId: string) {
  const plan = await loadPlan(actor, planId);
  const item = await loadItem(plan, itemId);
  const removedTasks = await runInTransaction(async (tx) => {
    const removed = await deletePlannedItemTasks(tx, item.id);
    await deletePlanItem(tx, item.id);
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

/** Every id must be an enrolment of THIS plan's programme and org (a foreign id is a 400, never silently dropped). */
async function loadPlanEnrolments(plan: ApprTaskPlanRow, enrolmentIds: string[]) {
  const unique = [...new Set(enrolmentIds)];
  const rows = await listApprEnrolmentsByIds(unique);
  if (
    rows.length !== unique.length ||
    rows.some((e) => e.organizationId !== plan.organizationId || e.programmeId !== plan.programmeId)
  ) {
    throw badRequest('One or more learners are not enrolled on this plan’s programme', 'enrolmentIds');
  }
  return rows;
}

export async function assignPlan(actor: Actor, planId: string, input: TaskPlanAssignInput, now: Date = new Date()) {
  const a = assertAdmin(actor);
  const plan = await loadPlan(actor, planId);
  if (plan.status !== 'ACTIVE') throw badRequest('This plan is archived');
  if (!isWithinWindow(plan.validFrom, plan.validTo, todayIso(now))) {
    throw badRequest('This plan can only be assigned between its valid from and valid to dates');
  }
  const enrolments = await loadPlanEnrolments(plan, input.enrolmentIds);
  const items = await listPlanItems(plan.id);
  if (items.length === 0) throw badRequest('Add at least one task to this plan before assigning it');
  const itemCriteria = await listPlanItemCriteria(items.map((i) => i.id));

  const result = await runInTransaction(async (tx) => {
    const rows = enrolments.flatMap((e) =>
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
        // No start date on the enrolment → no due date (the UI shows "Set start date").
        dueDate: taskDueDate(e.startDate, item.monthOffset),
        expectedMinutes: item.expectedMinutes,
        files: item.files,
        createdBy: a.userId
      }))
    );
    const created = await insertApprTasksSkippingExisting(tx, rows);
    const criteriaByItem = new Map<string, string[]>();
    for (const c of itemCriteria)
      criteriaByItem.set(c.itemId, [...(criteriaByItem.get(c.itemId) ?? []), c.criterionId]);
    await insertTaskCriteria(
      tx,
      created.flatMap((task) =>
        (criteriaByItem.get(task.planItemId ?? '') ?? []).map((criterionId) => ({ taskId: task.id, criterionId }))
      )
    );
    return { created, total: rows.length };
  });

  // One notification per learner per assign call (entity = their first newly created task).
  const firstTaskByLearner = new Map<string, string>();
  for (const task of result.created)
    if (!firstTaskByLearner.has(task.learnerId)) firstTaskByLearner.set(task.learnerId, task.id);
  for (const [learnerId, taskId] of firstTaskByLearner) {
    await notifySafely('task assigned', () => notifyTasksAssigned({ taskId, learnerId }));
  }

  await audit(actor, 'appr.task_plan.assigned', plan.id, {
    enrolments: enrolments.length,
    created: result.created.length,
    skipped: result.total - result.created.length
  });
  return { created: result.created.length, skipped: result.total - result.created.length };
}

export async function unassignPlan(actor: Actor, planId: string, input: TaskPlanAssignInput) {
  const plan = await loadPlan(actor, planId);
  const enrolments = await loadPlanEnrolments(plan, input.enrolmentIds);
  const removed = await runInTransaction((tx) =>
    deletePlannedPlanTasks(
      tx,
      plan.id,
      enrolments.map((e) => e.id)
    )
  );
  await audit(actor, 'appr.task_plan.unassigned', plan.id, { enrolments: enrolments.length, removed });
  return { removed };
}

/** Push the plan items' current title / details / type / minutes / files / criteria / due date to still-PLANNED tasks. */
export async function syncPlan(actor: Actor, planId: string) {
  const plan = await loadPlan(actor, planId);
  const items = await listPlanItems(plan.id);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const itemCriteria = await listPlanItemCriteria(items.map((i) => i.id));
  const planned = await listPlannedPlanTasks(plan.id);
  const taskCriteria = await listTaskCriteria(planned.map((p) => p.task.id));

  let updated = 0;
  await runInTransaction(async (tx) => {
    for (const { task, startDate } of planned) {
      const item = task.planItemId ? itemById.get(task.planItemId) : undefined;
      if (!item) continue; // its item was deleted: the task is now standalone
      const dueDate = taskDueDate(startDate, item.monthOffset);
      const wantCriteria = itemCriteria
        .filter((c) => c.itemId === item.id)
        .map((c) => c.criterionId)
        .sort();
      const haveCriteria = taskCriteria
        .filter((c) => c.taskId === task.id)
        .map((c) => c.criterionId)
        .sort();
      const same =
        task.title === item.title &&
        task.details === item.details &&
        task.typeKey === item.typeKey &&
        task.expectedMinutes === item.expectedMinutes &&
        task.dueDate === dueDate &&
        JSON.stringify(task.files) === JSON.stringify(item.files) &&
        JSON.stringify(wantCriteria) === JSON.stringify(haveCriteria);
      if (same) continue;
      // Conditional on PLANNED: a task answered meanwhile is left alone.
      const row = await updateApprTask(
        tx,
        task.id,
        {
          title: item.title,
          details: item.details,
          typeKey: item.typeKey,
          expectedMinutes: item.expectedMinutes,
          files: item.files,
          dueDate,
          ...(dueDate !== task.dueDate ? { overdueNotifiedAt: null } : {})
        },
        'PLANNED'
      );
      if (!row) continue;
      await replaceTaskCriteria(tx, task.id, wantCriteria);
      updated += 1;
    }
  });
  await audit(actor, 'appr.task_plan.synced', plan.id, { updated });
  return { updated };
}
