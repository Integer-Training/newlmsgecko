import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// Gecko Apprenticeships round 2 — task plans + tasks SERVICE rules (assign / unassign / sync, brief files, task status
// transitions through the evidence loop). DB queries mocked; the rules module is the real one.

vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  getApprEnrolment: vi.fn(),
  getApprEnrolmentByProgrammeLearner: vi.fn(async () => null),
  getApprProgramme: vi.fn(),
  getApprEvidence: vi.fn(),
  insertApprEvidence: vi.fn(),
  updateApprEvidence: vi.fn(),
  replaceEvidenceCriteria: vi.fn(),
  insertEvidenceNote: vi.fn(async () => ({})),
  listApprEvidenceTypes: vi.fn(async () => [{ key: 'assignment', label: 'Assignment', active: true }]),
  filterCriterionIdsInProgramme: vi.fn(async (_p: string, ids: string[]) => ids),
  insertApprUploads: vi.fn(async () => undefined),
  lockApprEnrolment: vi.fn(async () => null),
  markUploadsAttached: vi.fn(async () => undefined),
  markUploadsRemoved: vi.fn(async () => undefined),
  filterUploadKeysInOrg: vi.fn(async (_o: string, keys: string[]) => keys),
  getTaskPlan: vi.fn(),
  listTaskPlans: vi.fn(async () => []),
  lockTaskPlan: vi.fn(async () => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })),
  listPlanTaskCells: vi.fn(async () => []),
  deletePlannedPlanItemTasks: vi.fn(async () => []),
  nextPlanItemSequence: vi.fn(async () => 2),
  insertPlanItem: vi.fn(),
  replacePlanItemCriteria: vi.fn(async () => undefined),
  listPlanAssignees: vi.fn(async () => []),
  listPlanItems: vi.fn(),
  listPlanItemCriteria: vi.fn(async () => []),
  listApprEnrolmentsByIds: vi.fn(),
  insertApprTasksSkippingExisting: vi.fn(),
  insertTaskCriteria: vi.fn(async () => undefined),
  deletePlannedPlanTasks: vi.fn(),
  listPlannedPlanTasks: vi.fn(),
  listTaskCriteria: vi.fn(async () => []),
  replaceTaskCriteria: vi.fn(async () => undefined),
  updateApprTask: vi.fn(),
  updateApprTasksBulk: vi.fn(),
  replaceTaskCriteriaForTasks: vi.fn(async () => undefined),
  getApprTask: vi.fn(),
  insertApprTask: vi.fn(),
  deleteApprTask: vi.fn(),
  clearEvidenceTaskId: vi.fn(async () => ['ev-1']),
  listTaskEvidenceStatuses: vi.fn(),
  lockApprTask: vi.fn(async () => undefined),
  updateTaskPlan: vi.fn(),
  getPlanItem: vi.fn(),
  deletePlannedItemTasks: vi.fn(),
  deletePlanItem: vi.fn(async () => undefined),
  isTutorAllocatedToPlanLearner: vi.fn(async () => false),
  setApprTaskStatus: vi.fn(async () => true),
  countPlanTasksWithEvidence: vi.fn(async () => 0),
  deleteAllPlannedPlanTasks: vi.fn(),
  deleteTaskPlan: vi.fn(),
  setPlanItemSequences: vi.fn(async () => undefined),
  listTasksForEnrolment: vi.fn(async () => []),
  listEvidenceForTasks: vi.fn(async () => []),
  listOverdueTasks: vi.fn(async () => [])
}));
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => true),
  isCourseTutorForLearner: vi.fn(async () => false),
  isCourseTutor: vi.fn(async () => false),
  getOrgMemberRoleId: vi.fn(async () => null)
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', () => ({ runInTransaction: (fn: (tx: unknown) => unknown) => fn({ tx: true }) }));
vi.mock('@api/services/apprenticeship/progress', () => ({
  todayIso: (now: Date = new Date()) => now.toISOString().slice(0, 10),
  recomputeEnrolment: vi.fn(async () => null)
}));
vi.mock('@api/services/apprenticeship/notifications', () => ({
  notifyEvidenceSubmitted: vi.fn(async () => undefined),
  notifyEvidenceReviewed: vi.fn(async () => undefined),
  notifyTasksAssigned: vi.fn(async () => undefined),
  notifySafely: async (_label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch {
      /* non-fatal */
    }
  }
}));
vi.mock('@api/services/organization/users', () => ({ createOrgUser: vi.fn() }));
vi.mock('@api/services/organization/allocation', () => ({ createTutorAllocation: vi.fn() }));
vi.mock('@cio/core/utils/s3', () => ({
  generateDocumentUploadPresignedUrl: vi.fn(async () => 'https://upload.test/put'),
  generateDocumentDownloadPresignedUrls: vi.fn(async (keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, `https://dl.test/${k}`]))
  )
}));
vi.mock('@cio/core/config/upload-limits', () => ({
  getUploadLimits: () => ({ documentBytes: 10_000_000, imageBytes: 10_000_000, videoBytes: 100_000_000 })
}));

import * as q from '@cio/db/queries/apprenticeship';
import { isTutorAllocatedToLearner } from '@cio/db/queries/allocation';
import { notifyTasksAssigned } from '@api/services/apprenticeship/notifications';
import {
  createTask,
  deleteTask,
  listEnrolmentTasks,
  listOverdue,
  syncTaskStatuses,
  updateTask
} from '@api/services/apprenticeship/tasks';
import {
  assignPlan,
  buildTaskRows,
  createPlanItem,
  createTasksFromPlan,
  deletePlan,
  deletePlanItemById,
  getPlanDetail,
  listPlanItemsForEnrolment,
  reorderPlanItems,
  syncPlan,
  unassignPlan
} from '@api/services/apprenticeship/task-plans';
import { recordAudit } from '@cio/db/audit';
import { createEvidence, reviewEvidence, updateEvidence } from '@api/services/apprenticeship/evidence';

const ORG = 'org-1';
const PROG = '11111111-1111-4111-8111-111111111111';
const OTHER_PROG = '99999999-9999-4999-8999-999999999999';
const LRN = '22222222-2222-4222-8222-222222222222';
const LRN2 = '23232323-2323-4232-8232-232323232323';
const ENR = '33333333-3333-4333-8333-333333333333';
const ENR2 = '34343434-3434-4343-8343-343434343434';
const PLAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const ITEM2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const ITEM3 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
const FOREIGN_ITEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9';
const TASK = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EV = '44444444-4444-4444-8444-444444444444';
const CRIT = '55555555-5555-4555-8555-555555555555';

const admin = { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG } as Actor;
const tutor = { authenticated: true, userId: 'u-tutor', role: 'TUTOR', status: 'ACTIVE', orgId: ORG } as Actor;
const learner = { authenticated: true, userId: LRN, role: 'LEARNER', status: 'ACTIVE', orgId: ORG } as Actor;

const plan = (over: Record<string, unknown> = {}) => ({
  id: PLAN,
  organizationId: ORG,
  programmeId: PROG,
  title: 'Year 1',
  validFrom: null,
  validTo: null,
  files: [],
  status: 'ACTIVE',
  ...over
});
const item = (id: string, monthOffset: number, over: Record<string, unknown> = {}) => ({
  id,
  planId: PLAN,
  title: `Task ${id.slice(-1)}`,
  details: '',
  typeKey: 'assignment',
  sequence: 0,
  monthOffset,
  expectedMinutes: 60,
  files: [],
  ...over
});
const enrolment = (id: string, learnerId: string, startDate: string | null, over: Record<string, unknown> = {}) => ({
  id,
  organizationId: ORG,
  programmeId: PROG,
  learnerId,
  startDate,
  ...over
});
const task = (over: Record<string, unknown> = {}) => ({
  id: TASK,
  organizationId: ORG,
  programmeId: PROG,
  enrolmentId: ENR,
  learnerId: LRN,
  planId: PLAN,
  planItemId: ITEM1,
  title: 'Task 1',
  details: '',
  typeKey: 'assignment',
  dueDate: '2026-02-01',
  expectedMinutes: 60,
  files: [],
  status: 'PLANNED',
  ...over
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.getTaskPlan).mockResolvedValue(plan() as never);
  vi.mocked(q.listPlanItemCriteria).mockResolvedValue([] as never);
  vi.mocked(q.listTaskCriteria).mockResolvedValue([] as never);
  vi.mocked(q.lockTaskPlan).mockResolvedValue({ id: PLAN } as never);
  vi.mocked(q.listPlanTaskCells).mockResolvedValue([] as never);
  vi.mocked(q.deletePlannedPlanItemTasks).mockResolvedValue([] as never);
  // The bulk update reports every id it was given as updated (tests override this to simulate a lost race).
  vi.mocked(q.updateApprTasksBulk).mockImplementation((async (_tx: unknown, ids: string[]) => ids) as never);
  vi.mocked(q.listPlanItems).mockResolvedValue([item(ITEM1, 0), item(ITEM2, 1)] as never);
  vi.mocked(q.listApprEnrolmentsByIds).mockResolvedValue([enrolment(ENR, LRN, '2026-01-31')] as never);
  vi.mocked(q.insertApprTasksSkippingExisting).mockImplementation((async (
    _tx: unknown,
    rows: { learnerId: string }[]
  ) =>
    rows.map((r, i) => ({
      ...r,
      id: `t-${i}`,
      planItemId: (r as { planItemId?: string }).planItemId ?? null
    }))) as never);
});

const NOW = new Date('2026-06-01T10:00:00Z');

describe('assignPlan', () => {
  it('creates one task per (enrolment, item) with due = start + month offset (month-end clamped)', async () => {
    const res = await assignPlan(admin, PLAN, { enrolmentIds: [ENR] }, NOW);
    expect(res).toMatchObject({ created: 2, skipped: 0, learners: 1, dueOverride: null });
    const rows = vi.mocked(q.insertApprTasksSkippingExisting).mock.calls[0][1] as {
      dueDate: string | null;
      dueManual: boolean;
    }[];
    expect(rows.map((r) => r.dueDate)).toEqual(['2026-01-31', '2026-02-28']);
    // rule dates are never "manual"
    expect(rows.map((r) => r.dueManual)).toEqual([false, false]);
  });

  it('a learner with no start date gets tasks with NO due date (not a guess)', async () => {
    vi.mocked(q.listApprEnrolmentsByIds).mockResolvedValue([enrolment(ENR, LRN, null)] as never);
    await assignPlan(admin, PLAN, { enrolmentIds: [ENR] }, NOW);
    const rows = vi.mocked(q.insertApprTasksSkippingExisting).mock.calls[0][1] as { dueDate: string | null }[];
    expect(rows.map((r) => r.dueDate)).toEqual([null, null]);
  });

  it('is idempotent: a re-assign skips existing tasks and notifies nobody', async () => {
    vi.mocked(q.insertApprTasksSkippingExisting).mockResolvedValue([] as never);
    const res = await assignPlan(admin, PLAN, { enrolmentIds: [ENR] }, NOW);
    expect(res).toMatchObject({ created: 0, skipped: 2, learners: 0 });
    expect(notifyTasksAssigned).not.toHaveBeenCalled();
  });

  it('notifies each learner ONCE per assign call, however many tasks they got', async () => {
    vi.mocked(q.listApprEnrolmentsByIds).mockResolvedValue([
      enrolment(ENR, LRN, '2026-01-01'),
      enrolment(ENR2, LRN2, '2026-02-01')
    ] as never);
    await assignPlan(admin, PLAN, { enrolmentIds: [ENR, ENR2] }, NOW);
    expect(notifyTasksAssigned).toHaveBeenCalledTimes(2);
    const learners = vi.mocked(notifyTasksAssigned).mock.calls.map((c) => c[0].learnerId);
    expect(new Set(learners)).toEqual(new Set([LRN, LRN2]));
  });

  it('refuses outside the valid window, for an archived plan, and for an empty plan', async () => {
    vi.mocked(q.getTaskPlan).mockResolvedValue(plan({ validTo: '2026-01-31' }) as never);
    await expect(assignPlan(admin, PLAN, { enrolmentIds: [ENR] }, NOW)).rejects.toMatchObject({ statusCode: 400 });
    vi.mocked(q.getTaskPlan).mockResolvedValue(plan({ validFrom: '2026-07-01' }) as never);
    await expect(assignPlan(admin, PLAN, { enrolmentIds: [ENR] }, NOW)).rejects.toMatchObject({ statusCode: 400 });
    vi.mocked(q.getTaskPlan).mockResolvedValue(plan({ status: 'ARCHIVED' }) as never);
    await expect(assignPlan(admin, PLAN, { enrolmentIds: [ENR] }, NOW)).rejects.toMatchObject({ statusCode: 400 });
    vi.mocked(q.getTaskPlan).mockResolvedValue(plan() as never);
    vi.mocked(q.listPlanItems).mockResolvedValue([] as never);
    await expect(assignPlan(admin, PLAN, { enrolmentIds: [ENR] }, NOW)).rejects.toMatchObject({ statusCode: 400 });
    expect(q.insertApprTasksSkippingExisting).not.toHaveBeenCalled();
  });

  it('rejects an enrolment of another programme / unknown id (400) and never inserts', async () => {
    vi.mocked(q.listApprEnrolmentsByIds).mockResolvedValue([
      enrolment(ENR, LRN, '2026-01-01', { programmeId: OTHER_PROG })
    ] as never);
    await expect(assignPlan(admin, PLAN, { enrolmentIds: [ENR] }, NOW)).rejects.toMatchObject({ statusCode: 400 });
    vi.mocked(q.listApprEnrolmentsByIds).mockResolvedValue([] as never);
    await expect(assignPlan(admin, PLAN, { enrolmentIds: [ENR] }, NOW)).rejects.toMatchObject({ statusCode: 400 });
    expect(q.insertApprTasksSkippingExisting).not.toHaveBeenCalled();
  });

  it('is admin-only and org-scoped (tutor 403, other org 404)', async () => {
    await expect(assignPlan(tutor, PLAN, { enrolmentIds: [ENR] }, NOW)).rejects.toMatchObject({ statusCode: 403 });
    const otherAdmin = { ...admin, orgId: 'org-2' } as Actor;
    await expect(assignPlan(otherAdmin, PLAN, { enrolmentIds: [ENR] }, NOW)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('unassignPlan / deletePlan', () => {
  it('removes only PLANNED tasks of that plan for those enrolments (the query keeps tasks with evidence)', async () => {
    vi.mocked(q.deletePlannedPlanTasks).mockResolvedValue(2 as never);
    expect(await unassignPlan(admin, PLAN, { enrolmentIds: [ENR] })).toEqual({ removed: 2, kept: 0 });
    expect(q.deletePlannedPlanTasks).toHaveBeenCalledWith({ tx: true }, PLAN, [ENR]);
  });

  it('a plan whose tasks already have evidence cannot be deleted (409); otherwise it goes with its planned tasks', async () => {
    vi.mocked(q.countPlanTasksWithEvidence).mockResolvedValueOnce(1);
    await expect(deletePlan(admin, PLAN)).rejects.toMatchObject({ statusCode: 409 });
    expect(q.deleteTaskPlan).not.toHaveBeenCalled();
    await deletePlan(admin, PLAN);
    expect(q.deleteAllPlannedPlanTasks).toHaveBeenCalled();
    expect(q.deleteTaskPlan).toHaveBeenCalled();
  });
});

describe('syncPlan', () => {
  it('updates only changed PLANNED tasks, skips standalone ones, and counts a lost race as not updated', async () => {
    vi.mocked(q.listPlanItems).mockResolvedValue([item(ITEM1, 1, { title: 'Renamed' }), item(ITEM2, 0)] as never);
    vi.mocked(q.listPlannedPlanTasks).mockResolvedValue([
      {
        task: task({ id: 't-changed', planItemId: ITEM1, title: 'Old', dueDate: '2026-01-01' }),
        startDate: '2026-01-01'
      },
      {
        task: task({ id: 't-same', planItemId: ITEM2, title: 'Task 2', dueDate: '2026-01-01' }),
        startDate: '2026-01-01'
      },
      { task: task({ id: 't-orphan', planItemId: null }), startDate: '2026-01-01' },
      { task: task({ id: 't-raced', planItemId: ITEM1, title: 'Old', dueDate: '2026-02-01' }), startDate: '2026-01-01' }
    ] as never);
    vi.mocked(q.updateApprTasksBulk).mockImplementation((async (_tx: unknown, ids: string[]) =>
      ids.filter((id) => id !== 't-raced')) as never);

    expect(await syncPlan(admin, PLAN)).toMatchObject({ updated: 1 });
    const calls = vi.mocked(q.updateApprTasksBulk).mock.calls;
    // Both tasks of ITEM1 need different due dates, so they are two groups; the same-value one would share a call.
    expect(calls.flatMap((c) => c[1]).sort()).toEqual(['t-changed', 't-raced']);
    // Conditional on PLANNED, so a task answered meanwhile is untouched; the moved due date re-arms the overdue alert.
    const changedCall = calls.find((c) => c[1].includes('t-changed'))!;
    expect(changedCall[3]).toBe('PLANNED');
    expect(changedCall[2]).toMatchObject({ title: 'Renamed', dueDate: '2026-02-01', overdueNotifiedAt: null });
  });

  it('tasks that need identical new values share ONE update; criteria are rewritten only where they changed', async () => {
    vi.mocked(q.listPlanItems).mockResolvedValue([item(ITEM1, 1, { title: 'Renamed' }), item(ITEM2, 0)] as never);
    vi.mocked(q.listPlanItemCriteria).mockResolvedValue([
      { itemId: ITEM1, criterionId: 'c-b', code: 'B' },
      { itemId: ITEM1, criterionId: 'c-a', code: 'A' }
    ] as never);
    // t1/t2/t3 are ITEM1 tasks of learners with the same start date → identical patches; t3 already has the criteria.
    vi.mocked(q.listTaskCriteria).mockResolvedValue([
      { taskId: 't3', criterionId: 'c-a', code: 'A' },
      { taskId: 't3', criterionId: 'c-b', code: 'B' }
    ] as never);
    vi.mocked(q.listPlannedPlanTasks).mockResolvedValue(
      ['t1', 't2', 't3'].map((id) => ({
        task: task({ id, title: 'Old', dueDate: '2026-02-01' }),
        startDate: '2026-01-01'
      })) as never
    );
    expect(await syncPlan(admin, PLAN)).toMatchObject({ updated: 3 });
    expect(q.updateApprTasksBulk).toHaveBeenCalledTimes(1);
    expect(vi.mocked(q.updateApprTasksBulk).mock.calls[0][1]).toEqual(['t1', 't2', 't3']);
    // one criteria call for the two tasks whose criteria really differ; t3 (already right) is not rewritten
    expect(q.replaceTaskCriteriaForTasks).toHaveBeenCalledTimes(1);
    expect(q.replaceTaskCriteriaForTasks).toHaveBeenCalledWith({ tx: true }, ['t1', 't2'], ['c-a', 'c-b']);
    // the per-task helpers are no longer used by sync
    expect(q.updateApprTask).not.toHaveBeenCalled();
    expect(q.replaceTaskCriteria).not.toHaveBeenCalled();
  });

  it('a task lost to a race is neither counted nor given new criteria', async () => {
    vi.mocked(q.listPlanItemCriteria).mockResolvedValue([{ itemId: ITEM1, criterionId: 'c-a', code: 'A' }] as never);
    vi.mocked(q.listPlannedPlanTasks).mockResolvedValue(
      ['t1', 't2'].map((id) => ({ task: task({ id, title: 'Old' }), startDate: '2026-01-01' })) as never
    );
    vi.mocked(q.updateApprTasksBulk).mockResolvedValue(['t1'] as never);
    expect(await syncPlan(admin, PLAN)).toMatchObject({ updated: 1 });
    expect(q.replaceTaskCriteriaForTasks).toHaveBeenCalledWith({ tx: true }, ['t1'], ['c-a']);
  });
});

describe('plan items', () => {
  it('rejects criteria from another programme (400) and reorder lists that are not exactly the plan’s items', async () => {
    vi.mocked(q.filterCriterionIdsInProgramme).mockResolvedValueOnce([]);
    await expect(
      createPlanItem(admin, PLAN, {
        title: 'T',
        details: '',
        typeKey: 'assignment',
        monthOffset: 0,
        expectedMinutes: 0,
        files: [],
        criterionIds: [CRIT],
        assignTo: 'NONE'
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(reorderPlanItems(admin, PLAN, [ITEM1])).rejects.toMatchObject({ statusCode: 400 });
    await expect(reorderPlanItems(admin, PLAN, [ITEM1, ITEM1])).rejects.toMatchObject({ statusCode: 400 });
    await expect(reorderPlanItems(admin, PLAN, [ITEM2, ITEM1])).resolves.toEqual({ ordered: 2 });
  });
});

describe('individual tasks + brief files', () => {
  const body = {
    title: 'Reflect',
    details: '',
    typeKey: 'assignment',
    expectedMinutes: 0,
    files: [] as { key: string; name: string }[],
    criterionIds: [] as string[]
  };
  beforeEach(() => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment(ENR, LRN, '2026-01-01') as never);
    vi.mocked(q.insertApprTask).mockImplementation((async (_tx: unknown, v: object) => v) as never);
  });

  it('a file key must sit under THIS learner’s task prefix and have been issued to the org', async () => {
    const id = TASK;
    const ok = `apprenticeship/${PROG}/${LRN}/tasks/${id}/abc-brief.pdf`;
    await expect(
      createTask(admin, ENR, { ...body, id, files: [{ key: ok, name: 'brief.pdf' }] })
    ).resolves.toBeTruthy();
    expect(q.markUploadsAttached).toHaveBeenCalledWith([ok], { tx: true });

    // another learner's prefix
    const foreign = `apprenticeship/${PROG}/${LRN2}/tasks/${id}/abc-brief.pdf`;
    await expect(
      createTask(admin, ENR, { ...body, id, files: [{ key: foreign, name: 'b.pdf' }] })
    ).rejects.toMatchObject({
      statusCode: 400
    });
    // right prefix but never presigned for this org
    vi.mocked(q.filterUploadKeysInOrg).mockResolvedValueOnce([]);
    await expect(createTask(admin, ENR, { ...body, id, files: [{ key: ok, name: 'b.pdf' }] })).rejects.toMatchObject({
      statusCode: 400
    });
    // files without the presigned id
    await expect(createTask(admin, ENR, { ...body, files: [{ key: ok, name: 'b.pdf' }] })).rejects.toMatchObject({
      statusCode: 400
    });
  });

  it('a tutor can add a task only for an allocated learner; a learner never can', async () => {
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValueOnce(false);
    await expect(createTask(tutor, ENR, body)).rejects.toMatchObject({ statusCode: 404 });
    await expect(createTask(learner, ENR, body)).rejects.toMatchObject({ statusCode: 403 });
    await expect(createTask(tutor, ENR, body)).resolves.toBeTruthy();
  });

  it('editing the due date re-arms the overdue alert; dropping its own file releases it for clean-up, a plan brief stays', async () => {
    const own = `apprenticeship/${PROG}/${LRN}/tasks/${TASK}/own.pdf`;
    const brief = `apprenticeship/plans/${PLAN}/brief.pdf`;
    vi.mocked(q.getApprTask).mockResolvedValue(
      task({
        files: [
          { key: own, name: 'own.pdf' },
          { key: brief, name: 'brief.pdf' }
        ]
      }) as never
    );
    vi.mocked(q.updateApprTask).mockImplementation((async (_tx: unknown, _id: string, p: object) => p) as never);
    await updateTask(admin, TASK, { dueDate: '2026-03-01', files: [] });
    expect(vi.mocked(q.updateApprTask).mock.calls[0][2]).toMatchObject({
      dueDate: '2026-03-01',
      overdueNotifiedAt: null
    });
    // every dropped key starts its grace period (the job still protects keys the plan lists)
    expect(q.markUploadsRemoved).toHaveBeenCalledWith([own, brief], { tx: true });
  });

  it('deleting a task detaches its evidence (keeps it) and a learner of another enrolment cannot reach it', async () => {
    vi.mocked(q.getApprTask).mockResolvedValue(task() as never);
    vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment(ENR, LRN, '2026-01-01') as never);
    const res = await deleteTask(admin, TASK);
    expect(res).toEqual({ deleted: true, detachedEvidence: 1 });
    expect(q.clearEvidenceTaskId).toHaveBeenCalledWith({ tx: true }, TASK);
    expect(q.deleteApprTask).toHaveBeenCalled();
    await expect(deleteTask({ ...tutor, orgId: 'org-2' } as Actor, TASK)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('task status follows the latest linked evidence (same transaction)', () => {
  const statusOf = async (linked: string[]) => {
    vi.mocked(q.listTaskEvidenceStatuses).mockResolvedValue(
      linked.map((status, i) => ({ id: `e${i}`, status })) as never
    );
    vi.mocked(q.setApprTaskStatus).mockClear();
    await syncTaskStatuses({} as never, [TASK, TASK, null, undefined]);
    return vi.mocked(q.setApprTaskStatus).mock.calls.map((c) => c[2]);
  };

  it('PLANNED → SUBMITTED → REFERRED → resubmitted SUBMITTED → COMPLETE; deduplicates ids', async () => {
    expect(await statusOf([])).toEqual(['PLANNED']);
    expect(await statusOf(['SUBMITTED'])).toEqual(['SUBMITTED']);
    expect(await statusOf(['REFERRED'])).toEqual(['REFERRED']);
    expect(await statusOf(['SUBMITTED', 'REFERRED'])).toEqual(['SUBMITTED']); // newest first: the resubmission wins
    expect(await statusOf(['REFERRED', 'ACCEPTED'])).toEqual(['COMPLETE']); // any accepted piece completes it
  });

  const evidenceRow = (status: string, over: Record<string, unknown> = {}) => ({
    id: EV,
    organizationId: ORG,
    programmeId: PROG,
    learnerId: LRN,
    status,
    taskId: TASK,
    files: [],
    ...over
  });

  beforeEach(() => {
    vi.mocked(q.getApprTask).mockResolvedValue(task() as never);
    vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment(ENR, LRN, '2026-01-01') as never);
    vi.mocked(q.insertApprEvidence).mockImplementation((async (_tx: unknown, v: object) => v) as never);
    vi.mocked(q.getApprEnrolmentByProgrammeLearner).mockResolvedValue(enrolment(ENR, LRN, '2026-01-01') as never);
  });

  it('submitting evidence for a task syncs the task inside the transaction', async () => {
    vi.mocked(q.listTaskEvidenceStatuses).mockResolvedValue([{ id: EV, status: 'SUBMITTED' }] as never);
    await createEvidence(learner, ENR, {
      title: 'Answer',
      details: '',
      typeKey: 'assignment',
      minutes: 0,
      includeOtj: false,
      criterionIds: [CRIT],
      files: [],
      taskId: TASK
    });
    expect(q.setApprTaskStatus).toHaveBeenCalledWith({ tx: true }, TASK, 'SUBMITTED');
  });

  it('evidence for a task of ANOTHER learner or programme is a 400 and nothing is saved', async () => {
    vi.mocked(q.getApprTask).mockResolvedValue(task({ learnerId: LRN2 }) as never);
    const input = {
      title: 'Answer',
      details: '',
      typeKey: 'assignment',
      minutes: 0,
      includeOtj: false,
      criterionIds: [CRIT],
      files: [],
      taskId: TASK
    };
    await expect(createEvidence(learner, ENR, input)).rejects.toMatchObject({ statusCode: 400 });
    vi.mocked(q.getApprTask).mockResolvedValue(task({ programmeId: OTHER_PROG }) as never);
    await expect(createEvidence(learner, ENR, input)).rejects.toMatchObject({ statusCode: 400 });
    vi.mocked(q.getApprTask).mockResolvedValue(null as never);
    await expect(createEvidence(learner, ENR, input)).rejects.toMatchObject({ statusCode: 400 });
    expect(q.insertApprEvidence).not.toHaveBeenCalled();
  });

  it('refer then learner resubmit then accept walks the task REFERRED → SUBMITTED → COMPLETE', async () => {
    // tutor refers a SUBMITTED piece
    vi.mocked(q.getApprEvidence).mockResolvedValue(evidenceRow('SUBMITTED') as never);
    vi.mocked(q.updateApprEvidence).mockResolvedValue(evidenceRow('REFERRED') as never);
    vi.mocked(q.listTaskEvidenceStatuses).mockResolvedValue([{ id: EV, status: 'REFERRED' }] as never);
    await reviewEvidence(tutor, EV, { decision: 'REFER', criterionIds: [] });
    expect(q.setApprTaskStatus).toHaveBeenLastCalledWith({ tx: true }, TASK, 'REFERRED');

    // learner edits and resubmits
    vi.mocked(q.getApprEvidence).mockResolvedValue(evidenceRow('REFERRED') as never);
    vi.mocked(q.updateApprEvidence).mockResolvedValue(evidenceRow('SUBMITTED') as never);
    vi.mocked(q.listTaskEvidenceStatuses).mockResolvedValue([{ id: EV, status: 'SUBMITTED' }] as never);
    await updateEvidence(learner, EV, { details: 'better' });
    expect(q.setApprTaskStatus).toHaveBeenLastCalledWith({ tx: true }, TASK, 'SUBMITTED');

    // tutor accepts
    vi.mocked(q.getApprEvidence).mockResolvedValue(evidenceRow('SUBMITTED') as never);
    vi.mocked(q.updateApprEvidence).mockResolvedValue(evidenceRow('ACCEPTED') as never);
    vi.mocked(q.listTaskEvidenceStatuses).mockResolvedValue([{ id: EV, status: 'ACCEPTED' }] as never);
    await reviewEvidence(tutor, EV, { decision: 'ACCEPT', criterionIds: [CRIT] });
    expect(q.setApprTaskStatus).toHaveBeenLastCalledWith({ tx: true }, TASK, 'COMPLETE');
  });

  it('re-linking evidence to a different task re-syncs BOTH tasks', async () => {
    const OTHER_TASK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    vi.mocked(q.getApprEvidence).mockResolvedValue(evidenceRow('SUBMITTED') as never);
    vi.mocked(q.getApprTask).mockResolvedValue(task({ id: OTHER_TASK }) as never);
    vi.mocked(q.updateApprEvidence).mockResolvedValue(evidenceRow('SUBMITTED', { taskId: OTHER_TASK }) as never);
    vi.mocked(q.listTaskEvidenceStatuses).mockResolvedValue([] as never);
    await updateEvidence(admin, EV, { taskId: OTHER_TASK });
    const synced = vi.mocked(q.setApprTaskStatus).mock.calls.map((c) => c[1]);
    expect(new Set(synced)).toEqual(new Set([TASK, OTHER_TASK]));
  });
});

describe('row lock before status recompute', () => {
  it('locks the task row BEFORE reading its evidence, so concurrent writes cannot overwrite COMPLETE', async () => {
    const order: string[] = [];
    vi.mocked(q.lockApprTask).mockImplementation((async () => void order.push('lock')) as never);
    vi.mocked(q.listTaskEvidenceStatuses).mockImplementation((async () => {
      order.push('read');
      return [{ id: 'e', status: 'ACCEPTED' }];
    }) as never);
    vi.mocked(q.setApprTaskStatus).mockImplementation((async () => void order.push('write')) as never);
    await syncTaskStatuses({} as never, [TASK]);
    expect(order).toEqual(['lock', 'read', 'write']);
  });
});

describe('plan files: removal + sync keep task-own files', () => {
  it('plan edit, item edit/delete and plan delete release dropped / removed keys', async () => {
    const k = (n: string) => `apprenticeship/plans/${PLAN}/${n}.pdf`;
    vi.mocked(q.getTaskPlan).mockResolvedValue(
      plan({
        files: [
          { key: k('a'), name: 'a' },
          { key: k('b'), name: 'b' }
        ]
      }) as never
    );
    vi.mocked(q.updateTaskPlan).mockResolvedValue({ id: PLAN } as never);
    const {
      updatePlan,
      deletePlan: delPlan,
      deletePlanItemById
    } = await import('@api/services/apprenticeship/task-plans');
    await updatePlan(admin, PLAN, { files: [{ key: k('a'), name: 'a' }] });
    expect(q.markUploadsRemoved).toHaveBeenLastCalledWith([k('b')], { tx: true });

    vi.mocked(q.getPlanItem).mockResolvedValue(item(ITEM1, 0, { files: [{ key: k('i'), name: 'i' }] }) as never);
    vi.mocked(q.deletePlannedItemTasks).mockResolvedValue(0 as never);
    await deletePlanItemById(admin, PLAN, ITEM1);
    expect(q.markUploadsRemoved).toHaveBeenLastCalledWith([k('i')], { tx: true });

    vi.mocked(q.listPlanItems).mockResolvedValue([item(ITEM1, 0, { files: [{ key: k('i'), name: 'i' }] })] as never);
    await delPlan(admin, PLAN);
    expect(q.markUploadsRemoved).toHaveBeenLastCalledWith([k('a'), k('b'), k('i')], { tx: true });
  });

  it('sync replaces plan briefs but keeps files uploaded for the task itself', async () => {
    const own = `apprenticeship/${PROG}/${LRN}/tasks/${TASK}/own.pdf`;
    const oldBrief = `apprenticeship/plans/${PLAN}/old.pdf`;
    const newBrief = `apprenticeship/plans/${PLAN}/new.pdf`;
    vi.mocked(q.listPlanItems).mockResolvedValue([
      item(ITEM1, 0, { title: 'Task 1', files: [{ key: newBrief, name: 'new' }] })
    ] as never);
    vi.mocked(q.listPlannedPlanTasks).mockResolvedValue([
      {
        task: task({
          files: [
            { key: oldBrief, name: 'old' },
            { key: own, name: 'own' }
          ],
          dueDate: '2026-01-01'
        }),
        startDate: '2026-01-01'
      }
    ] as never);
    await syncPlan(admin, PLAN);
    expect(vi.mocked(q.updateApprTasksBulk).mock.calls[0][2].files).toEqual([
      { key: newBrief, name: 'new' },
      { key: own, name: 'own' }
    ]);
  });
});

describe('plan brief download access', () => {
  it('a tutor needs an allocated learner holding a task from the plan (else 404); admin always', async () => {
    const { signPlanDownloads } = await import('@api/services/apprenticeship/task-plans');
    const key = `apprenticeship/plans/${PLAN}/brief.pdf`;
    vi.mocked(q.getTaskPlan).mockResolvedValue(plan({ files: [{ key, name: 'b' }] }) as never);
    await expect(signPlanDownloads(tutor, PLAN, [key])).rejects.toMatchObject({ statusCode: 404 });
    vi.mocked(q.isTutorAllocatedToPlanLearner).mockResolvedValueOnce(true);
    await expect(signPlanDownloads(tutor, PLAN, [key])).resolves.toBeTruthy();
    await expect(signPlanDownloads(admin, PLAN, [key])).resolves.toBeTruthy();
  });
});

describe('planTitle on task lists', () => {
  it('lists carry the plan title, null for individual tasks', async () => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment(ENR, LRN, '2026-01-01') as never);
    vi.mocked(q.listTasksForEnrolment).mockResolvedValue([
      task({ id: 'a', planTitle: 'Year 1' }),
      task({ id: 'b', planId: null, planItemId: null, planTitle: null })
    ] as never);
    const res = await listEnrolmentTasks(admin, ENR, NOW);
    expect(res.items.map((t) => t.planTitle)).toEqual(['Year 1', null]);
  });

  it('the overdue list passes planTitle through', async () => {
    vi.mocked(q.listOverdueTasks).mockResolvedValue([{ id: 'a', planTitle: 'Year 1', total: 1 }] as never);
    const res = await listOverdue(admin, { page: 1, pageSize: 25 }, NOW);
    expect(res.items[0]).toMatchObject({ planTitle: 'Year 1' });
  });
});

// ── Per-item assignment, batch due-date override, locking (plan §5) ──

const cell = (enrolmentId: string, itemId: string, over: Record<string, unknown> = {}) => ({
  enrolmentId,
  itemId,
  taskId: `task-${enrolmentId.slice(0, 2)}-${itemId.slice(-1)}`,
  status: 'PLANNED',
  dueDate: null,
  dueManual: false,
  ...over
});
type InsertedRow = { enrolmentId: string; planItemId: string; dueDate: string | null; dueManual: boolean };
const insertedRows = () => vi.mocked(q.insertApprTasksSkippingExisting).mock.calls[0][1] as unknown as InsertedRow[];

describe('assignPlan — subset of items', () => {
  it('creates only the chosen items', async () => {
    const res = await assignPlan(admin, PLAN, { enrolmentIds: [ENR], itemIds: [ITEM2] }, NOW);
    expect(insertedRows().map((r) => r.planItemId)).toEqual([ITEM2]);
    expect(res).toMatchObject({ created: 1, skipped: 0, learners: 1 });
  });

  it('an item id of another plan (or deleted meanwhile) is a 404 and NOTHING is created or notified', async () => {
    await expect(
      assignPlan(admin, PLAN, { enrolmentIds: [ENR], itemIds: [ITEM1, FOREIGN_ITEM] }, NOW)
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(q.insertApprTasksSkippingExisting).not.toHaveBeenCalled();
    expect(notifyTasksAssigned).not.toHaveBeenCalled();
  });

  it('an archived plan or one outside its window is refused for a subset too', async () => {
    vi.mocked(q.getTaskPlan).mockResolvedValue(plan({ status: 'ARCHIVED' }) as never);
    await expect(assignPlan(admin, PLAN, { enrolmentIds: [ENR], itemIds: [ITEM1] }, NOW)).rejects.toMatchObject({
      statusCode: 400
    });
    vi.mocked(q.getTaskPlan).mockResolvedValue(plan({ validTo: '2026-01-31' }) as never);
    await expect(assignPlan(admin, PLAN, { enrolmentIds: [ENR], itemIds: [ITEM1] }, NOW)).rejects.toMatchObject({
      statusCode: 400
    });
    expect(q.insertApprTasksSkippingExisting).not.toHaveBeenCalled();
  });

  it('re-running the same subset creates nothing and notifies nobody', async () => {
    vi.mocked(q.insertApprTasksSkippingExisting).mockResolvedValue([] as never);
    const res = await assignPlan(admin, PLAN, { enrolmentIds: [ENR], itemIds: [ITEM1] }, NOW);
    expect(res).toMatchObject({ created: 0, skipped: 1, learners: 0 });
    expect(notifyTasksAssigned).not.toHaveBeenCalled();
  });

  it('notifies each learner once per batch even when the batch is a subset of several items', async () => {
    vi.mocked(q.listApprEnrolmentsByIds).mockResolvedValue([
      enrolment(ENR, LRN, '2026-01-01'),
      enrolment(ENR2, LRN2, '2026-02-01')
    ] as never);
    await assignPlan(admin, PLAN, { enrolmentIds: [ENR, ENR2], itemIds: [ITEM1, ITEM2] }, NOW);
    expect(notifyTasksAssigned).toHaveBeenCalledTimes(2);
  });

  it('a notification failure never fails the assign', async () => {
    vi.mocked(notifyTasksAssigned).mockRejectedValueOnce(new Error('queue down'));
    await expect(assignPlan(admin, PLAN, { enrolmentIds: [ENR] }, NOW)).resolves.toMatchObject({ created: 2 });
  });

  it('audits mode, item ids and the override', async () => {
    await assignPlan(admin, PLAN, { enrolmentIds: [ENR], itemIds: [ITEM2], dueDate: '2026-09-01' }, NOW);
    expect(recordAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'appr.task_plan.assigned',
        metadata: expect.objectContaining({ mode: 'ITEMS', itemIds: [ITEM2], dueOverride: '2026-09-01', created: 1 })
      })
    );
    await assignPlan(admin, PLAN, { enrolmentIds: [ENR] }, NOW);
    expect(recordAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ mode: 'ALL', itemIds: null, dueOverride: null }) })
    );
  });
});

describe('assignPlan — batch due-date override', () => {
  it('gives every new task the override date and marks it manual, also for a learner with no start date', async () => {
    vi.mocked(q.listApprEnrolmentsByIds).mockResolvedValue([
      enrolment(ENR, LRN, '2026-01-31'),
      enrolment(ENR2, LRN2, null)
    ] as never);
    const res = await assignPlan(admin, PLAN, { enrolmentIds: [ENR, ENR2], dueDate: '2026-09-01' }, NOW);
    const rows = insertedRows();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.dueDate === '2026-09-01' && r.dueManual === true)).toBe(true);
    expect(res).toMatchObject({ dueOverride: '2026-09-01', overrideInPast: false, pastDue: 0, undated: 0 });
  });

  it('without an override a no-start learner stays undated (counted) and nothing is manual', async () => {
    vi.mocked(q.listApprEnrolmentsByIds).mockResolvedValue([enrolment(ENR, LRN, null)] as never);
    const res = await assignPlan(admin, PLAN, { enrolmentIds: [ENR] }, NOW);
    expect(insertedRows().every((r) => r.dueDate === null && r.dueManual === false)).toBe(true);
    expect(res).toMatchObject({ undated: 2, dueOverride: null });
  });

  it('a past date is allowed (back-filling a late learner) and flagged with the number of tasks already overdue', async () => {
    const res = await assignPlan(admin, PLAN, { enrolmentIds: [ENR], dueDate: '2026-03-01' }, NOW);
    expect(res).toMatchObject({ overrideInPast: true, pastDue: 2, dueOverride: '2026-03-01' });
    expect(insertedRows().every((r) => r.dueManual)).toBe(true);
  });

  it('refuses a date before the start of any selected learner, an impossible date, and an absurdly far one', async () => {
    vi.mocked(q.listApprEnrolmentsByIds).mockResolvedValue([
      enrolment(ENR, LRN, '2026-01-31'),
      enrolment(ENR2, LRN2, '2026-08-01')
    ] as never);
    // 2026-07-01 is after learner 1's start but before learner 2's: the 400 names HOW MANY learners are the problem
    // and says nothing was created (the dashboard checks this up front, so the server stays the final guard).
    await expect(
      assignPlan(admin, PLAN, { enrolmentIds: [ENR, ENR2], dueDate: '2026-07-01' }, NOW)
    ).rejects.toMatchObject({
      statusCode: 400,
      field: 'dueDate',
      message: expect.stringMatching(/before the start date of 1 selected learner. Nothing was created/)
    });
    await expect(
      assignPlan(admin, PLAN, { enrolmentIds: [ENR, ENR2], dueDate: '2026-02-30' }, NOW)
    ).rejects.toMatchObject({ statusCode: 400, field: 'dueDate' });
    await expect(
      assignPlan(admin, PLAN, { enrolmentIds: [ENR, ENR2], dueDate: '2046-01-01' }, NOW)
    ).rejects.toMatchObject({ statusCode: 400, field: 'dueDate' });
    expect(q.insertApprTasksSkippingExisting).not.toHaveBeenCalled();
    expect(notifyTasksAssigned).not.toHaveBeenCalled();
  });

  it('a learner who already holds every chosen task does not block the batch date (they are skipped anyway)', async () => {
    vi.mocked(q.listApprEnrolmentsByIds).mockResolvedValue([
      enrolment(ENR, LRN, '2026-01-31'),
      enrolment(ENR2, LRN2, '2026-08-01') // starts after the override but already holds both tasks
    ] as never);
    vi.mocked(q.listPlanTaskCells).mockResolvedValue([cell(ENR2, ITEM1), cell(ENR2, ITEM2)] as never);
    await expect(
      assignPlan(admin, PLAN, { enrolmentIds: [ENR, ENR2], dueDate: '2026-07-01' }, NOW)
    ).resolves.toBeTruthy();
    // ...but one who is still missing a task does
    vi.mocked(q.listPlanTaskCells).mockResolvedValue([cell(ENR2, ITEM1)] as never);
    await expect(
      assignPlan(admin, PLAN, { enrolmentIds: [ENR, ENR2], dueDate: '2026-07-01' }, NOW)
    ).rejects.toMatchObject({ statusCode: 400, field: 'dueDate' });
  });

  it('a due date equal to the start date is fine (not "before")', async () => {
    await expect(assignPlan(admin, PLAN, { enrolmentIds: [ENR], dueDate: '2026-01-31' }, NOW)).resolves.toBeTruthy();
  });
});

describe('plan row lock + in-transaction re-read', () => {
  it('assign locks the plan BEFORE re-reading plan, enrolments and items, and inserts last', async () => {
    const order: string[] = [];
    vi.mocked(q.lockTaskPlan).mockImplementation((async () => {
      order.push('lock');
      return { id: PLAN };
    }) as never);
    vi.mocked(q.getTaskPlan).mockImplementation((async (_id: string, client?: unknown) => {
      order.push(client ? 'plan(tx)' : 'plan');
      return plan();
    }) as never);
    vi.mocked(q.listApprEnrolmentsByIds).mockImplementation((async () => {
      order.push('enrolments');
      return [enrolment(ENR, LRN, '2026-01-31')];
    }) as never);
    vi.mocked(q.listPlanItems).mockImplementation((async () => {
      order.push('items');
      return [item(ITEM1, 0)];
    }) as never);
    vi.mocked(q.insertApprTasksSkippingExisting).mockImplementation((async () => {
      order.push('insert');
      return [];
    }) as never);
    await assignPlan(admin, PLAN, { enrolmentIds: [ENR] }, NOW);
    expect(order).toEqual(['plan', 'lock', 'plan(tx)', 'enrolments', 'items', 'insert']);
  });

  it('a plan deleted between the check and the lock is a 404 and nothing is created', async () => {
    vi.mocked(q.lockTaskPlan).mockResolvedValueOnce(null as never);
    await expect(assignPlan(admin, PLAN, { enrolmentIds: [ENR] }, NOW)).rejects.toMatchObject({ statusCode: 404 });
    expect(q.insertApprTasksSkippingExisting).not.toHaveBeenCalled();
  });

  it('unassign, sync and item delete lock the plan; archive, edit and delete serialise on it too', async () => {
    await unassignPlan(admin, PLAN, { enrolmentIds: [ENR] });
    await syncPlan(admin, PLAN);
    vi.mocked(q.getPlanItem).mockResolvedValue(item(ITEM1, 0) as never);
    vi.mocked(q.deletePlannedItemTasks).mockResolvedValue(0 as never);
    await deletePlanItemById(admin, PLAN, ITEM1);
    expect(q.lockTaskPlan).toHaveBeenCalledTimes(3);
    vi.mocked(q.updateTaskPlan).mockResolvedValue({ id: PLAN } as never);
    const { setPlanArchived, updatePlan } = await import('@api/services/apprenticeship/task-plans');
    await setPlanArchived(admin, PLAN, true);
    await updatePlan(admin, PLAN, { title: 'New title' });
    await deletePlan(admin, PLAN);
    expect(q.lockTaskPlan).toHaveBeenCalledTimes(6);
  });

  it('deleting an item that vanished before the lock is a 404 (no tasks deleted)', async () => {
    vi.mocked(q.getPlanItem)
      .mockResolvedValueOnce(item(ITEM1, 0) as never)
      .mockResolvedValueOnce(null as never);
    await expect(deletePlanItemById(admin, PLAN, ITEM1)).rejects.toMatchObject({ statusCode: 404 });
    expect(q.deletePlannedItemTasks).not.toHaveBeenCalled();
    expect(q.deletePlanItem).not.toHaveBeenCalled();
  });
});

describe('buildTaskRows', () => {
  const target = { id: PLAN, organizationId: ORG, programmeId: PROG };

  it('rule due = start + offset (no start → null); an override applies to all and sets dueManual', () => {
    const enrolments = [
      { id: ENR, learnerId: LRN, startDate: '2026-01-31' },
      { id: ENR2, learnerId: LRN2, startDate: null }
    ];
    const items = [item(ITEM1, 0), item(ITEM2, 1)] as never;
    const rule = buildTaskRows(target, enrolments, items, 'u-admin');
    expect(rule.map((r) => [r.enrolmentId, r.planItemId, r.dueDate, r.dueManual])).toEqual([
      [ENR, ITEM1, '2026-01-31', false],
      [ENR, ITEM2, '2026-02-28', false],
      [ENR2, ITEM1, null, false],
      [ENR2, ITEM2, null, false]
    ]);
    const override = buildTaskRows(target, enrolments, items, 'u-admin', '2026-09-01');
    expect(override.every((r) => r.dueDate === '2026-09-01' && r.dueManual)).toBe(true);
    expect(override[0]).toMatchObject({ planId: PLAN, createdBy: 'u-admin', organizationId: ORG, programmeId: PROG });
  });

  it('a 500-learner x 30-item batch is one row set (the query layer chunks the INSERT)', () => {
    const enrolments = Array.from({ length: 500 }, (_, i) => ({
      id: `e${i}`,
      learnerId: `l${i}`,
      startDate: '2026-01-01'
    }));
    const items = Array.from({ length: 30 }, (_, i) =>
      item(`bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, '0')}`, i)
    );
    expect(buildTaskRows(target, enrolments, items as never, 'u')).toHaveLength(15000);
  });
});

describe('unassignPlan — subset + kept', () => {
  it("removes only the chosen items' PLANNED tasks and reports how many were kept (answered / started)", async () => {
    vi.mocked(q.listApprEnrolmentsByIds).mockResolvedValue([
      enrolment(ENR, LRN, '2026-01-31'),
      enrolment(ENR2, LRN2, '2026-01-31')
    ] as never);
    vi.mocked(q.listPlanTaskCells).mockResolvedValue([
      cell(ENR, ITEM1),
      cell(ENR, ITEM2),
      cell(ENR2, ITEM1, { status: 'SUBMITTED' }) // answered: the query keeps it
    ] as never);
    vi.mocked(q.deletePlannedPlanItemTasks).mockResolvedValue([
      { id: 'x', enrolmentId: ENR, planItemId: ITEM1 }
    ] as never);
    const res = await unassignPlan(admin, PLAN, { enrolmentIds: [ENR, ENR2], itemIds: [ITEM1] });
    expect(res).toEqual({ removed: 1, kept: 1 });
    expect(q.deletePlannedPlanItemTasks).toHaveBeenCalledWith({ tx: true }, PLAN, [ENR, ENR2], [ITEM1]);
    expect(q.deletePlannedPlanTasks).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'appr.task_plan.unassigned',
        metadata: expect.objectContaining({ itemIds: [ITEM1], kept: 1, removed: 1 })
      })
    );
  });

  it('whole-plan unassign counts kept tasks; a foreign item id is a 404 and nothing is deleted', async () => {
    vi.mocked(q.listPlanTaskCells).mockResolvedValue([
      cell(ENR, ITEM1),
      cell(ENR, ITEM2, { status: 'COMPLETE' })
    ] as never);
    vi.mocked(q.deletePlannedPlanTasks).mockResolvedValue(1 as never);
    expect(await unassignPlan(admin, PLAN, { enrolmentIds: [ENR] })).toEqual({ removed: 1, kept: 1 });
    await expect(unassignPlan(admin, PLAN, { enrolmentIds: [ENR], itemIds: [FOREIGN_ITEM] })).rejects.toMatchObject({
      statusCode: 404
    });
    expect(q.deletePlannedPlanItemTasks).not.toHaveBeenCalled();
  });

  it('an unknown / foreign enrolment is a 400 and nothing is deleted', async () => {
    vi.mocked(q.listApprEnrolmentsByIds).mockResolvedValue([] as never);
    await expect(unassignPlan(admin, PLAN, { enrolmentIds: [ENR], itemIds: [ITEM1] })).rejects.toMatchObject({
      statusCode: 400
    });
    expect(q.deletePlannedPlanItemTasks).not.toHaveBeenCalled();
  });
});

describe('syncPlan — item subset + manual dues', () => {
  it('limited to the chosen items: only their planned tasks are read; a foreign id is a 404', async () => {
    vi.mocked(q.listPlannedPlanTasks).mockResolvedValue([] as never);
    await syncPlan(admin, PLAN, { itemIds: [ITEM1] });
    expect(q.listPlannedPlanTasks).toHaveBeenCalledWith(PLAN, { tx: true }, [ITEM1]);
    await syncPlan(admin, PLAN);
    expect(vi.mocked(q.listPlannedPlanTasks).mock.calls[1][2]).toBeUndefined();
    await expect(syncPlan(admin, PLAN, { itemIds: [FOREIGN_ITEM] })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('never overwrites a manual due date (batch override / hand-edited) but still updates the rest of the task', async () => {
    vi.mocked(q.listPlanItems).mockResolvedValue([item(ITEM1, 1, { title: 'Renamed' })] as never);
    vi.mocked(q.listPlannedPlanTasks).mockResolvedValue([
      {
        task: task({ id: 't-manual', title: 'Old', dueDate: '2026-05-05', dueManual: true }),
        startDate: '2026-01-01'
      }
    ] as never);
    const res = await syncPlan(admin, PLAN);
    expect(res).toEqual({ updated: 1, manualDueKept: 1 });
    const patch = vi.mocked(q.updateApprTasksBulk).mock.calls[0][2];
    expect(patch).toMatchObject({ title: 'Renamed' });
    expect(patch).not.toHaveProperty('dueDate');
    expect(patch).not.toHaveProperty('overdueNotifiedAt'); // the due date did not move
  });

  it('a manual task that differs only by its due date is left completely alone', async () => {
    vi.mocked(q.listPlanItems).mockResolvedValue([item(ITEM1, 1, { title: 'Task 1' })] as never);
    vi.mocked(q.listPlannedPlanTasks).mockResolvedValue([
      { task: task({ dueDate: '2026-05-05', dueManual: true }), startDate: '2026-01-01' }
    ] as never);
    expect(await syncPlan(admin, PLAN)).toEqual({ updated: 0, manualDueKept: 1 });
    expect(q.updateApprTasksBulk).not.toHaveBeenCalled();
  });

  it('a task whose due date was cleared (not manual) follows the rule again on sync', async () => {
    vi.mocked(q.listPlanItems).mockResolvedValue([item(ITEM1, 1)] as never);
    vi.mocked(q.listPlannedPlanTasks).mockResolvedValue([
      { task: task({ title: 'Task 1', dueDate: null, dueManual: false }), startDate: '2026-01-01' }
    ] as never);
    await syncPlan(admin, PLAN);
    expect(vi.mocked(q.updateApprTasksBulk).mock.calls[0][2]).toMatchObject({ dueDate: '2026-02-01' });
  });
});

describe('createPlanItem — assignTo WHOLE_PLAN', () => {
  const base = {
    title: 'New task',
    details: '',
    typeKey: 'assignment',
    monthOffset: 2,
    expectedMinutes: 0,
    files: [] as { key: string; name: string }[],
    criterionIds: [] as string[]
  };
  beforeEach(() => {
    vi.mocked(q.insertPlanItem).mockImplementation((async (_tx: unknown, v: object) => ({
      ...item(ITEM3, 2),
      ...v,
      id: ITEM3
    })) as never);
    // ENR holds the whole plan (ITEM1 + ITEM2); ENR2 holds only ITEM1.
    vi.mocked(q.listPlanTaskCells).mockResolvedValue([cell(ENR, ITEM1), cell(ENR, ITEM2), cell(ENR2, ITEM1)] as never);
    vi.mocked(q.listApprEnrolmentsByIds).mockResolvedValue([enrolment(ENR, LRN, '2026-01-31')] as never);
  });

  it('creates the task ONLY for learners who held every item before the insert, then notifies them once', async () => {
    const res = await createPlanItem(admin, PLAN, { ...base, assignTo: 'WHOLE_PLAN' }, NOW);
    expect(q.listApprEnrolmentsByIds).toHaveBeenCalledWith([ENR], { tx: true });
    const rows = insertedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ enrolmentId: ENR, planItemId: ITEM3, dueDate: '2026-03-31', dueManual: false });
    expect(res.assigned).toEqual({ created: 1, learners: 1 });
    expect(notifyTasksAssigned).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'appr.task_plan.item_created',
        metadata: expect.objectContaining({ itemId: ITEM3, autoAssigned: 1 })
      })
    );
  });

  it('holders are read BEFORE the new item is inserted, under the plan lock', async () => {
    await createPlanItem(admin, PLAN, { ...base, assignTo: 'WHOLE_PLAN' }, NOW);
    const firstCall = (fn: unknown) => vi.mocked(fn as never).mock.invocationCallOrder[0];
    expect(firstCall(q.lockTaskPlan)).toBeLessThan(firstCall(q.listPlanTaskCells));
    expect(firstCall(q.listPlanTaskCells)).toBeLessThan(firstCall(q.insertPlanItem));
    expect(firstCall(q.insertPlanItem)).toBeLessThan(firstCall(q.insertApprTasksSkippingExisting));
  });

  it('NONE (the default) creates the item only', async () => {
    const res = await createPlanItem(admin, PLAN, { ...base, assignTo: 'NONE' }, NOW);
    expect(q.insertApprTasksSkippingExisting).not.toHaveBeenCalled();
    expect(res.assigned).toEqual({ created: 0, learners: 0 });
    expect(notifyTasksAssigned).not.toHaveBeenCalled();
  });

  it('no learner holds the whole plan → item created, nothing assigned', async () => {
    vi.mocked(q.listPlanTaskCells).mockResolvedValue([cell(ENR, ITEM1), cell(ENR2, ITEM2)] as never);
    const res = await createPlanItem(admin, PLAN, { ...base, assignTo: 'WHOLE_PLAN' }, NOW);
    expect(q.insertPlanItem).toHaveBeenCalled();
    expect(q.insertApprTasksSkippingExisting).not.toHaveBeenCalled();
    expect(res.assigned).toEqual({ created: 0, learners: 0 });
  });

  it('an archived plan / one outside its window still gets the item; the auto-assign is skipped with a reason', async () => {
    vi.mocked(q.getTaskPlan).mockResolvedValue(plan({ status: 'ARCHIVED' }) as never);
    let res = await createPlanItem(admin, PLAN, { ...base, assignTo: 'WHOLE_PLAN' }, NOW);
    expect(res.assigned).toEqual({ created: 0, learners: 0, skippedReason: 'ARCHIVED' });
    vi.mocked(q.getTaskPlan).mockResolvedValue(plan({ validTo: '2026-01-31' }) as never);
    res = await createPlanItem(admin, PLAN, { ...base, assignTo: 'WHOLE_PLAN' }, NOW);
    expect(res.assigned).toMatchObject({ created: 0, skippedReason: 'OUTSIDE_WINDOW' });
    expect(q.insertPlanItem).toHaveBeenCalledTimes(2);
    expect(q.insertApprTasksSkippingExisting).not.toHaveBeenCalled();
  });
});

describe('updateTask — due_manual', () => {
  beforeEach(() => {
    vi.mocked(q.updateApprTask).mockImplementation((async (_tx: unknown, _id: string, p: object) => p) as never);
  });
  const patchOf = () => vi.mocked(q.updateApprTask).mock.calls.at(-1)![2] as Record<string, unknown>;

  it("moving a PLAN task's due date makes it manual; clearing it hands it back to the rule (not manual)", async () => {
    vi.mocked(q.getApprTask).mockResolvedValue(task() as never);
    await updateTask(admin, TASK, { dueDate: '2026-03-01' });
    expect(patchOf()).toMatchObject({ dueDate: '2026-03-01', dueManual: true, overdueNotifiedAt: null });
    await updateTask(admin, TASK, { dueDate: null });
    expect(patchOf()).toMatchObject({ dueDate: null, dueManual: false });
  });

  it('an unchanged due date, other fields, and individual tasks never touch the flag', async () => {
    vi.mocked(q.getApprTask).mockResolvedValue(task() as never);
    await updateTask(admin, TASK, { dueDate: '2026-02-01' });
    expect(patchOf()).not.toHaveProperty('dueManual');
    await updateTask(admin, TASK, { title: 'Renamed' });
    expect(patchOf()).not.toHaveProperty('dueManual');
    vi.mocked(q.getApprTask).mockResolvedValue(task({ planId: null, planItemId: null }) as never);
    await updateTask(admin, TASK, { dueDate: '2026-04-01' });
    expect(patchOf()).not.toHaveProperty('dueManual');
  });
});

describe('getPlanDetail — held items + whole plan', () => {
  it('derives wholePlan per learner and the per-item assigned counts', async () => {
    vi.mocked(q.listPlanAssignees).mockResolvedValue([
      { enrolmentId: ENR, learnerId: LRN, learnerName: 'A', taskCount: 2 },
      { enrolmentId: ENR2, learnerId: LRN2, learnerName: 'B', taskCount: 1 }
    ] as never);
    vi.mocked(q.listPlanTaskCells).mockResolvedValue([cell(ENR, ITEM1), cell(ENR, ITEM2), cell(ENR2, ITEM1)] as never);
    const res = await getPlanDetail(admin, PLAN);
    expect(res.assignees.map((a) => [a.enrolmentId, a.wholePlan, a.heldCount])).toEqual([
      [ENR, true, 2],
      [ENR2, false, 1]
    ]);
    expect(res.assignees[1].items.map((i) => i.itemId)).toEqual([ITEM1]);
    expect(res.items.map((i) => [i.id, i.assignedCount])).toEqual([
      [ITEM1, 2],
      [ITEM2, 1]
    ]);
    expect(res.wholePlanCount).toBe(1);
  });
});

describe('add from plan — one learner (tutor or admin)', () => {
  beforeEach(() => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment(ENR, LRN, '2026-01-31') as never);
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(true);
  });

  it('an allocated tutor creates the chosen items for that learner: one notification, audit appr.task.created', async () => {
    const res = await createTasksFromPlan(tutor, ENR, { planId: PLAN, itemIds: [ITEM2] }, NOW);
    expect(insertedRows().map((r) => r.planItemId)).toEqual([ITEM2]);
    expect(res).toMatchObject({ created: 1, skipped: 0, learners: 1, taskIds: ['t-0'] });
    expect(notifyTasksAssigned).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'appr.task.created',
        entityType: 'appr_task',
        metadata: expect.objectContaining({ planId: PLAN, itemIds: [ITEM2], fromPlan: true })
      })
    );
  });

  it('a learner the tutor does not reach is a 404; the apprentice themselves is a 403; nothing is created', async () => {
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(false);
    await expect(createTasksFromPlan(tutor, ENR, { planId: PLAN, itemIds: [ITEM1] }, NOW)).rejects.toMatchObject({
      statusCode: 404
    });
    await expect(createTasksFromPlan(learner, ENR, { planId: PLAN, itemIds: [ITEM1] }, NOW)).rejects.toMatchObject({
      statusCode: 403
    });
    expect(q.insertApprTasksSkippingExisting).not.toHaveBeenCalled();
  });

  it('a plan of another programme / org is a 404; an archived plan 400; a foreign item 404', async () => {
    vi.mocked(q.getTaskPlan).mockResolvedValue(plan({ programmeId: OTHER_PROG }) as never);
    await expect(createTasksFromPlan(tutor, ENR, { planId: PLAN, itemIds: [ITEM1] }, NOW)).rejects.toMatchObject({
      statusCode: 404
    });
    vi.mocked(q.getTaskPlan).mockResolvedValue(plan({ organizationId: 'org-2' }) as never);
    await expect(createTasksFromPlan(tutor, ENR, { planId: PLAN, itemIds: [ITEM1] }, NOW)).rejects.toMatchObject({
      statusCode: 404
    });
    vi.mocked(q.getTaskPlan).mockResolvedValue(plan({ status: 'ARCHIVED' }) as never);
    await expect(createTasksFromPlan(tutor, ENR, { planId: PLAN, itemIds: [ITEM1] }, NOW)).rejects.toMatchObject({
      statusCode: 400
    });
    vi.mocked(q.getTaskPlan).mockResolvedValue(plan() as never);
    await expect(createTasksFromPlan(tutor, ENR, { planId: PLAN, itemIds: [FOREIGN_ITEM] }, NOW)).rejects.toMatchObject(
      { statusCode: 404 }
    );
    expect(q.insertApprTasksSkippingExisting).not.toHaveBeenCalled();
  });

  it('repeating it creates nothing: no notification, no audit', async () => {
    vi.mocked(q.insertApprTasksSkippingExisting).mockResolvedValue([] as never);
    const res = await createTasksFromPlan(admin, ENR, { planId: PLAN, itemIds: [ITEM1, ITEM2] }, NOW);
    expect(res).toMatchObject({ created: 0, skipped: 2, taskIds: [] });
    expect(notifyTasksAssigned).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('an optional due date follows the override rules (manual; before the learner start → 400)', async () => {
    await createTasksFromPlan(tutor, ENR, { planId: PLAN, itemIds: [ITEM1], dueDate: '2026-09-01' }, NOW);
    expect(insertedRows()[0]).toMatchObject({ dueDate: '2026-09-01', dueManual: true });
    await expect(
      createTasksFromPlan(tutor, ENR, { planId: PLAN, itemIds: [ITEM1], dueDate: '2026-01-01' }, NOW)
    ).rejects.toMatchObject({ statusCode: 400, field: 'dueDate' });
  });

  it('lists only active, in-window plans that have tasks, with held flags and the rule due date', async () => {
    vi.mocked(q.listTaskPlans).mockResolvedValue([
      { id: PLAN, title: 'Year 1', validFrom: null, validTo: null, itemCount: 2 },
      { id: 'p-expired', title: 'Old', validFrom: null, validTo: '2026-01-01', itemCount: 1 },
      { id: 'p-empty', title: 'Empty', validFrom: null, validTo: null, itemCount: 0 }
    ] as never);
    vi.mocked(q.listTasksForEnrolment).mockResolvedValue([task({ id: 'held', planItemId: ITEM1 })] as never);
    const res = await listPlanItemsForEnrolment(tutor, ENR, NOW);
    expect(q.listTaskPlans).toHaveBeenCalledWith(ORG, { programmeId: PROG, status: 'ACTIVE' });
    expect(res.startDate).toBe('2026-01-31');
    expect(res.plans).toHaveLength(1);
    expect(res.plans[0].items.map((i) => [i.id, i.held, i.taskId, i.dueDate])).toEqual([
      [ITEM1, true, 'held', '2026-01-31'],
      [ITEM2, false, null, '2026-02-28']
    ]);
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(false);
    await expect(listPlanItemsForEnrolment(tutor, ENR, NOW)).rejects.toMatchObject({ statusCode: 404 });
    await expect(listPlanItemsForEnrolment(learner, ENR, NOW)).rejects.toMatchObject({ statusCode: 403 });
  });
});
