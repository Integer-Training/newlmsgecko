import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// Gecko Apprenticeships round 2 — task plans + tasks SERVICE rules (assign / unassign / sync, brief files, task status
// transitions through the evidence loop). DB queries mocked; the rules module is the real one.

vi.mock('@cio/db/queries/apprenticeship', () => ({
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
  markUploadsAttached: vi.fn(async () => undefined),
  markUploadsRemoved: vi.fn(async () => undefined),
  filterUploadKeysInOrg: vi.fn(async (_o: string, keys: string[]) => keys),
  getTaskPlan: vi.fn(),
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
  createPlanItem,
  deletePlan,
  reorderPlanItems,
  syncPlan,
  unassignPlan
} from '@api/services/apprenticeship/task-plans';
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
    expect(res).toEqual({ created: 2, skipped: 0 });
    const rows = vi.mocked(q.insertApprTasksSkippingExisting).mock.calls[0][1] as { dueDate: string | null }[];
    expect(rows.map((r) => r.dueDate)).toEqual(['2026-01-31', '2026-02-28']);
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
    expect(res).toEqual({ created: 0, skipped: 2 });
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
    expect(await unassignPlan(admin, PLAN, { enrolmentIds: [ENR] })).toEqual({ removed: 2 });
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
    vi.mocked(q.updateApprTask).mockImplementation((async (_tx: unknown, id: string) =>
      id === 't-raced' ? null : { id }) as never);

    expect(await syncPlan(admin, PLAN)).toEqual({ updated: 1 });
    const calls = vi.mocked(q.updateApprTask).mock.calls;
    expect(calls.map((c) => c[1])).toEqual(['t-changed', 't-raced']);
    // Conditional on PLANNED, so a task answered meanwhile is untouched; the moved due date re-arms the overdue alert.
    expect(calls[0][3]).toBe('PLANNED');
    expect(calls[0][2]).toMatchObject({ title: 'Renamed', dueDate: '2026-02-01', overdueNotifiedAt: null });
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
        criterionIds: [CRIT]
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
    vi.mocked(q.updateApprTask).mockResolvedValue({ id: TASK } as never);
    await syncPlan(admin, PLAN);
    expect(vi.mocked(q.updateApprTask).mock.calls[0][2].files).toEqual([
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
