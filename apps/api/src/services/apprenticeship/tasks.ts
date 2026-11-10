import { randomUUID } from 'node:crypto';

import { AppError, ErrorCodes } from '@api/utils/errors';
import {
  assertStaff,
  canAccessLearner,
  getEnrolmentForActor,
  requireAuthed
} from '@api/services/apprenticeship/access';
import { assertActiveType, assertAllowedFile, assertCriteriaInProgramme } from '@api/services/apprenticeship/checks';
import { todayIso } from '@api/services/apprenticeship/progress';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import { runInTransaction, type DbOrTxClient } from '@cio/db/drizzle';
import {
  clearEvidenceTaskId,
  deleteApprTask,
  filterUploadKeysInOrg,
  getApprTask,
  insertApprTask,
  insertApprUploads,
  listEvidenceForTasks,
  listOverdueTasks,
  listTaskCriteria,
  listTaskEvidenceStatuses,
  lockApprTask,
  listTasksForEnrolment,
  markUploadsAttached,
  markUploadsRemoved,
  replaceTaskCriteria,
  setApprTaskStatus,
  updateApprTask,
  type ApprTaskFile,
  type ApprTaskRow
} from '@cio/db/queries/apprenticeship';
import { apprenticeshipTaskKeyPrefix, generateApprenticeshipTaskFileKey } from '@cio/core/utils/upload';
import { generateDocumentDownloadPresignedUrls, generateDocumentUploadPresignedUrl } from '@cio/core/utils/s3';
import { APPR_TASK_STATUS_LABELS, type ApprTaskStatus } from '@cio/utils/constants/apprenticeship';
import { isTaskOverdue, taskStatusFromEvidence } from '@cio/utils/functions/apprenticeship-progress';
import type {
  EvidenceFileInput,
  TaskCreateInput,
  TaskPresignInput,
  TaskUpdateInput
} from '@cio/utils/validation/apprenticeship';

// Gecko Apprenticeships — learner tasks (from an assigned plan, or individual). Access is the enrolment rule
// (access.ts): ADMIN org, TUTOR allocated, LEARNER self (read only). A task's status (PLANNED / SUBMITTED / REFERRED /
// COMPLETE) is a cache of its linked evidence, recomputed in the SAME transaction as every evidence write that touches
// it (syncTaskStatuses); "overdue" is never stored — it is computed on read (isTaskOverdue).

const notFound = () => new AppError('Task not found', ErrorCodes.NOT_FOUND, 404);
const badRequest = (message: string, field?: string) => new AppError(message, ErrorCodes.VALIDATION_ERROR, 400, field);

// ── Shared with the evidence + task-plan services ──

/** The learner/programme/org an evidence row (or enrolment) belongs to — what a linked task must match. */
interface TaskOwnerContext {
  organizationId: string;
  programmeId: string;
  learnerId: string;
}

/** A task may only be answered by evidence of the SAME learner on the SAME programme (else 400). */
export async function assertTaskForEvidence(taskId: string, owner: TaskOwnerContext): Promise<ApprTaskRow> {
  const task = await getApprTask(taskId);
  if (
    !task ||
    task.organizationId !== owner.organizationId ||
    task.programmeId !== owner.programmeId ||
    task.learnerId !== owner.learnerId
  ) {
    throw badRequest('This task does not belong to this learner and programme', 'taskId');
  }
  return task;
}

/**
 * Re-derive the cached status of each task from its linked evidence (latest activity first). Call inside the
 * transaction of any evidence create / edit / review / relink. Falsy ids are ignored; duplicates are collapsed.
 */
export async function syncTaskStatuses(tx: DbOrTxClient, taskIds: (string | null | undefined)[]): Promise<void> {
  for (const taskId of new Set(taskIds.filter((id): id is string => Boolean(id)))) {
    // Lock first: concurrent evidence writes then recompute one after the other and COMPLETE cannot be overwritten.
    await lockApprTask(tx, taskId);
    const linked = await listTaskEvidenceStatuses(taskId, tx);
    await setApprTaskStatus(tx, taskId, taskStatusFromEvidence(linked));
  }
}

/**
 * Brief files (plan / item / individual task): each NEW key must sit under the allowed prefix AND have been issued to
 * this organization by a presign (appr_upload) — so a key can never be lifted from another org or learner. Keys already
 * on the record are kept as they are.
 */
export async function assertBriefFiles(
  organizationId: string,
  files: EvidenceFileInput[],
  allowedPrefix: string,
  existing: { key: string }[] = []
): Promise<void> {
  const owned = new Set(existing.map((f) => f.key));
  for (const f of files) assertAllowedFile(f);
  const fresh = files.filter((f) => !owned.has(f.key));
  if (fresh.some((f) => !f.key.startsWith(allowedPrefix))) throw badRequest('Invalid file reference', 'files');
  const known = new Set(
    await filterUploadKeysInOrg(
      organizationId,
      fresh.map((f) => f.key)
    )
  );
  if (fresh.some((f) => !known.has(f.key))) throw badRequest('Upload the files before saving', 'files');
}

export function toBriefFiles(files: EvidenceFileInput[], existing: ApprTaskFile[], uploadedBy: string): ApprTaskFile[] {
  const byKey = new Map(existing.map((f) => [f.key, f]));
  const now = new Date().toISOString();
  return files.map(
    (f) => byKey.get(f.key) ?? { key: f.key, name: f.name, size: f.size, type: f.type, uploadedBy, uploadedAt: now }
  );
}

// ── Reads ──

async function loadTaskForActor(actor: Actor, taskId: string): Promise<ApprTaskRow> {
  requireAuthed(actor);
  const task = await getApprTask(taskId);
  if (!task || !(await canAccessLearner(actor, task.organizationId, task.learnerId, task.programmeId)))
    throw notFound();
  return task;
}

function shapeTask(
  task: ApprTaskRow & { planTitle?: string | null },
  criteria: { criterionId: string; code: string }[],
  evidence: { id: string; title: string; status: string }[],
  today: string
) {
  const status = task.status as ApprTaskStatus;
  return {
    ...task,
    /** The plan this task came from; null for an individual task. */
    planTitle: task.planTitle ?? null,
    status,
    statusLabel: APPR_TASK_STATUS_LABELS[status] ?? task.status,
    overdue: isTaskOverdue(task, today),
    /** No start date on the enrolment → no due date: the UI shows "Set start date". */
    fromPlan: task.planId !== null,
    criteria: criteria.map((c) => ({ id: c.criterionId, code: c.code })),
    evidence: evidence.map((e) => ({ id: e.id, title: e.title, status: e.status }))
  };
}

export async function listEnrolmentTasks(actor: Actor, enrolmentId: string, now: Date = new Date()) {
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  const today = todayIso(now);
  const tasks = await listTasksForEnrolment(enrolment.id);
  const ids = tasks.map((t) => t.id);
  const [criteria, evidence] = await Promise.all([listTaskCriteria(ids), listEvidenceForTasks(ids)]);
  const items = tasks.map((t) =>
    shapeTask(
      t,
      criteria.filter((c) => c.taskId === t.id),
      evidence.filter((e) => e.taskId === t.id),
      today
    )
  );
  return {
    items,
    counts: {
      total: items.length,
      complete: items.filter((t) => t.status === 'COMPLETE').length,
      overdue: items.filter((t) => t.overdue).length
    }
  };
}

/** Overdue tasks across learners: ADMIN → the org; TUTOR → allocated learners only (joined in the query). */
export async function listOverdue(
  actor: Actor,
  query: { programmeId?: string; page: number; pageSize: number },
  now: Date = new Date()
) {
  const a = assertStaff(actor);
  const rows = await listOverdueTasks(
    {
      organizationId: a.orgId,
      programmeId: query.programmeId,
      restrictToTutorId: a.role === 'TUTOR' ? a.userId : undefined
    },
    todayIso(now),
    { limit: query.pageSize, offset: (query.page - 1) * query.pageSize }
  );
  return {
    items: rows.map(({ total: _total, ...row }) => row),
    total: rows[0]?.total ?? 0,
    page: query.page,
    pageSize: query.pageSize
  };
}

// ── Uploads ──

/** Brief-file uploads for an INDIVIDUAL task (plan briefs use the task-plans presign). Staff, enrolment-scoped. */
export async function presignTaskUploads(actor: Actor, input: TaskPresignInput) {
  const a = assertStaff(actor);
  const enrolment = await getEnrolmentForActor(actor, input.enrolmentId);

  let taskId = input.taskId;
  if (taskId) {
    const existing = await getApprTask(taskId);
    if (existing && (existing.enrolmentId !== enrolment.id || existing.organizationId !== enrolment.organizationId)) {
      throw notFound();
    }
  } else {
    taskId = randomUUID();
  }

  for (const f of input.files) assertAllowedFile(f);
  const files = await Promise.all(
    input.files.map(async (f) => {
      let key: string;
      try {
        key = generateApprenticeshipTaskFileKey(enrolment.programmeId, enrolment.learnerId, taskId!, f.name);
      } catch {
        throw badRequest(`"${f.name}" needs a file extension`, 'files');
      }
      return { name: f.name, key, uploadUrl: await generateDocumentUploadPresignedUrl(key, f.type) };
    })
  );
  await insertApprUploads(
    files.map((f) => ({
      organizationId: enrolment.organizationId,
      learnerId: enrolment.learnerId,
      ownerId: a.userId,
      key: f.key
    }))
  );
  return { taskId, files };
}

/** Signed download URLs for a task's brief files. Every key must be listed on THAT task, which the caller can see. */
export async function signTaskDownloads(actor: Actor, taskId: string, keys: string[]) {
  const task = await loadTaskForActor(actor, taskId);
  const owned = new Set(task.files.map((f) => f.key));
  if (!keys.every((k) => owned.has(k))) {
    throw new AppError('You do not have access to these files', ErrorCodes.FORBIDDEN, 403);
  }
  return generateDocumentDownloadPresignedUrls(keys);
}

// ── Writes ──

const audit = (actor: Actor, action: string, entityId: string, metadata: Record<string, unknown> = {}) =>
  recordAudit({ actor, action, entityType: 'appr_task', entityId, metadata });

/** An individual task for one learner (no plan). Staff only; a tutor only for an allocated learner. */
export async function createTask(actor: Actor, enrolmentId: string, input: TaskCreateInput) {
  const a = assertStaff(actor);
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  await assertActiveType(enrolment.organizationId, input.typeKey);
  const criterionIds = await assertCriteriaInProgramme(enrolment.programmeId, input.criterionIds);

  if (input.files.length > 0 && !input.id) throw badRequest('Upload the files before saving', 'files');
  const taskId = input.id ?? randomUUID();
  await assertBriefFiles(
    enrolment.organizationId,
    input.files,
    apprenticeshipTaskKeyPrefix(enrolment.programmeId, enrolment.learnerId, taskId)
  );

  const task = await runInTransaction(async (tx) => {
    const row = await insertApprTask(tx, {
      id: taskId,
      organizationId: enrolment.organizationId,
      programmeId: enrolment.programmeId,
      enrolmentId: enrolment.id,
      learnerId: enrolment.learnerId,
      title: input.title,
      details: input.details,
      typeKey: input.typeKey,
      dueDate: input.dueDate ?? null,
      expectedMinutes: input.expectedMinutes,
      files: toBriefFiles(input.files, [], a.userId),
      createdBy: a.userId
    });
    await replaceTaskCriteria(tx, taskId, criterionIds);
    await markUploadsAttached(
      input.files.map((f) => f.key),
      tx
    );
    return row;
  });
  await audit(actor, 'appr.task.created', taskId, { enrolmentId: enrolment.id, individual: true });
  return task;
}

/** Edit a task (plan-derived or individual): title, details, type, due date, minutes, brief files, criteria. */
export async function updateTask(actor: Actor, taskId: string, input: TaskUpdateInput) {
  const a = assertStaff(actor);
  const task = await loadTaskForActor(actor, taskId);
  if (input.typeKey !== undefined && input.typeKey !== task.typeKey) {
    await assertActiveType(task.organizationId, input.typeKey);
  }
  const criterionIds = input.criterionIds
    ? await assertCriteriaInProgramme(task.programmeId, input.criterionIds)
    : undefined;
  if (input.files) {
    await assertBriefFiles(
      task.organizationId,
      input.files,
      apprenticeshipTaskKeyPrefix(task.programmeId, task.learnerId, task.id),
      task.files
    );
  }

  const { criterionIds: _ids, files, ...fields } = input;
  const keptKeys = files?.map((f) => f.key) ?? [];
  // Dropped files start their clean-up grace; a key the plan (or another record) still lists is protected by the job.
  const droppedKeys = files ? task.files.map((f) => f.key).filter((k) => !keptKeys.includes(k)) : [];
  const dueChanged = input.dueDate !== undefined && input.dueDate !== task.dueDate;

  const updated = await runInTransaction(async (tx) => {
    const row = await updateApprTask(tx, taskId, {
      ...fields,
      ...(files ? { files: toBriefFiles(files, task.files, a.userId) } : {}),
      // A moved due date re-arms the overdue notification.
      ...(dueChanged ? { overdueNotifiedAt: null } : {})
    });
    if (!row) throw notFound();
    if (criterionIds) await replaceTaskCriteria(tx, taskId, criterionIds);
    if (files) {
      await markUploadsAttached(keptKeys, tx);
      await markUploadsRemoved(droppedKeys, tx);
    }
    return row;
  });
  await audit(actor, 'appr.task.updated', taskId, { fields: Object.keys(input) });
  return updated;
}

/** Delete a task. Evidence that answered it is kept — it is just detached (task_id cleared) in the same transaction. */
export async function deleteTask(actor: Actor, taskId: string) {
  assertStaff(actor);
  const task = await loadTaskForActor(actor, taskId);
  const detached = await runInTransaction(async (tx) => {
    const evidenceIds = await clearEvidenceTaskId(tx, taskId);
    await deleteApprTask(tx, taskId);
    await markUploadsRemoved(
      task.files.map((f) => f.key),
      tx
    );
    return evidenceIds.length;
  });
  await audit(actor, 'appr.task.deleted', taskId, { enrolmentId: task.enrolmentId, detachedEvidence: detached });
  return { deleted: true, detachedEvidence: detached };
}
