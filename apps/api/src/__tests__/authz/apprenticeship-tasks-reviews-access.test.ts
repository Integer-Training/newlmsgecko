import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Actor } from '@cio/db/actor';
import type { AuthSession } from '@api/types/auth';

// Gecko Apprenticeships round 2 — task plans, tasks and reviews API access. Real routers + real services, DB reads mocked.
// Proves, per route: anonymous 401; roles outside the route's audience 403 BEFORE any query runs; an admin of ANOTHER org
// 404s on every id; a tutor reaches only allocated learners and a learner only their own enrolment (404 otherwise);
// file keys must sit under the right prefix; criteria / enrolments of another programme are rejected (400).

vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  getApprProgramme: vi.fn(),
  getApprEnrolment: vi.fn(),
  getApprProgrammeStructure: vi.fn(async () => ({ qualifications: [], units: [], criteria: [] })),
  listApprEvidenceTypes: vi.fn(async () => [{ key: 'assignment', label: 'Assignment', active: true }]),
  filterCriterionIdsInProgramme: vi.fn(async (_p: string, ids: string[]) => ids),
  insertApprUploads: vi.fn(async () => undefined),
  markUploadsAttached: vi.fn(async () => undefined),
  markUploadsRemoved: vi.fn(async () => undefined),
  filterUploadKeysInOrg: vi.fn(async (_o: string, keys: string[]) => keys),
  // plans
  getTaskPlan: vi.fn(),
  listTaskPlans: vi.fn(async () => []),
  insertTaskPlan: vi.fn(async (_tx: unknown, v: object) => v),
  updateTaskPlan: vi.fn(async (_tx: unknown, id: string) => ({ id })),
  deleteTaskPlan: vi.fn(async () => undefined),
  countPlanTasksWithEvidence: vi.fn(async () => 0),
  deleteAllPlannedPlanTasks: vi.fn(async () => undefined),
  listPlanAssignees: vi.fn(async () => []),
  listPlanItems: vi.fn(async () => []),
  getPlanItem: vi.fn(),
  nextPlanItemSequence: vi.fn(async () => 0),
  insertPlanItem: vi.fn(async (_tx: unknown, v: object) => ({ id: 'item-1', ...v })),
  updatePlanItem: vi.fn(async (_tx: unknown, id: string) => ({ id })),
  deletePlanItem: vi.fn(async () => undefined),
  deletePlannedItemTasks: vi.fn(async () => 0),
  setPlanItemSequences: vi.fn(async () => undefined),
  listPlanItemCriteria: vi.fn(async () => []),
  replacePlanItemCriteria: vi.fn(async () => undefined),
  listApprEnrolmentsByIds: vi.fn(),
  insertApprTasksSkippingExisting: vi.fn(async () => []),
  insertTaskCriteria: vi.fn(async () => undefined),
  deletePlannedPlanTasks: vi.fn(async () => 0),
  listPlannedPlanTasks: vi.fn(async () => []),
  // tasks
  getApprTask: vi.fn(),
  insertApprTask: vi.fn(async (_tx: unknown, v: object) => v),
  updateApprTask: vi.fn(async (_tx: unknown, id: string) => ({ id })),
  deleteApprTask: vi.fn(async () => undefined),
  clearEvidenceTaskId: vi.fn(async () => []),
  listTasksForEnrolment: vi.fn(async () => []),
  listTaskCriteria: vi.fn(async () => []),
  replaceTaskCriteria: vi.fn(async () => undefined),
  listEvidenceForTasks: vi.fn(async () => []),
  listOverdueTasks: vi.fn(async () => []),
  // reviews
  getApprReview: vi.fn(),
  insertApprReview: vi.fn(async (_tx: unknown, v: object) => ({ id: 'rev-new', ...v })),
  listReviewsForEnrolment: vi.fn(async () => []),
  updateApprReviewIfUnchanged: vi.fn(),
  countOpenReviews: vi.fn(async () => 0),
  insertFirstReviewIfNone: vi.fn(async () => true),
  isTutorAllocatedToPlanLearner: vi.fn(async () => false),
  lockApprTask: vi.fn(async () => undefined)
}));
vi.mock('@api/services/apprenticeship/notifications', () => ({
  notifyTasksAssigned: vi.fn(async () => undefined),
  notifyReviewReadyToSign: vi.fn(async () => undefined),
  notifyEvidenceSubmitted: vi.fn(async () => undefined),
  notifyEvidenceReviewed: vi.fn(async () => undefined),
  notifySafely: async (_label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch {
      /* non-fatal */
    }
  }
}));
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => false),
  isCourseTutorForLearner: vi.fn(async () => false),
  isCourseTutor: vi.fn(async () => false),
  getOrgMemberRoleId: vi.fn(async () => null)
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', () => ({ runInTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@api/services/apprenticeship/progress', () => ({
  todayIso: () => '2026-06-01',
  recomputeEnrolment: vi.fn(async () => null),
  buildEnrolmentProgress: vi.fn(async () => null)
}));
vi.mock('@api/services/apprenticeship/enrolment', () => ({ toProgressSummary: () => ({}) }));
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
import { apprenticeshipRouter } from '@api/routes/apprenticeship';

const ORG = 'org-1';
const PROG = '11111111-1111-4111-8111-111111111111';
const OTHER_PROG = '99999999-9999-4999-8999-999999999999';
const LRN = '22222222-2222-4222-8222-222222222222';
const LRN2 = '23232323-2323-4232-8232-232323232323';
const ENR = '33333333-3333-4333-8333-333333333333';
const PLAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const TASK = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REV = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CRIT = '55555555-5555-4555-8555-555555555555';

const ACTORS: Record<string, Actor> = {
  anon: { authenticated: false, reason: 'anonymous' },
  learner: { authenticated: true, userId: LRN, role: 'LEARNER', status: 'ACTIVE', orgId: ORG },
  otherLearner: { authenticated: true, userId: LRN2, role: 'LEARNER', status: 'ACTIVE', orgId: ORG },
  tutor: { authenticated: true, userId: 'u-tutor', role: 'TUTOR', status: 'ACTIVE', orgId: ORG },
  manager: { authenticated: true, userId: 'u-manager', role: 'MANAGER', status: 'ACTIVE', orgId: ORG },
  admin: { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG },
  otherAdmin: { authenticated: true, userId: 'u-admin2', role: 'ADMIN', status: 'ACTIVE', orgId: 'org-2' }
};

const app = new Hono<AuthSession>()
  .use('*', async (c, next) => {
    c.set('actor', ACTORS[c.req.header('x-test-actor') ?? 'anon'] ?? ACTORS.anon);
    await next();
  })
  .route('/apprenticeship', apprenticeshipRouter as unknown as Hono);

const ENROLMENT = {
  id: ENR,
  organizationId: ORG,
  programmeId: PROG,
  learnerId: LRN,
  startDate: '2026-01-01',
  plannedEndDate: '2026-12-31'
};
const PLAN_ROW = {
  id: PLAN,
  organizationId: ORG,
  programmeId: PROG,
  title: 'Plan',
  validFrom: null,
  validTo: null,
  files: [{ key: `apprenticeship/plans/${PLAN}/brief.pdf`, name: 'brief.pdf' }],
  status: 'ACTIVE'
};
const ITEM_ROW = {
  id: ITEM,
  planId: PLAN,
  title: 'Task',
  details: '',
  typeKey: 'assignment',
  sequence: 0,
  monthOffset: 0,
  expectedMinutes: 0,
  files: []
};
const TASK_KEY = `apprenticeship/${PROG}/${LRN}/tasks/${TASK}/brief.pdf`;
const TASK_ROW = {
  id: TASK,
  organizationId: ORG,
  programmeId: PROG,
  enrolmentId: ENR,
  learnerId: LRN,
  planId: null,
  planItemId: null,
  title: 'Task',
  details: '',
  typeKey: 'assignment',
  dueDate: '2026-02-01',
  expectedMinutes: 0,
  files: [{ key: TASK_KEY, name: 'brief.pdf' }],
  status: 'PLANNED'
};
const REVIEW_ROW = {
  id: REV,
  organizationId: ORG,
  enrolmentId: ENR,
  scheduledDate: '2026-07-01',
  heldDate: null,
  status: 'DRAFT',
  targets: [],
  tutorSignedAt: null,
  learnerSignedAt: null,
  employerSignedAt: null,
  learnerComment: null,
  updatedAt: '2026-05-01T10:00:00.000Z'
};

type Route = { method: string; path: string; body?: unknown };
const P = '/apprenticeship/task-plans';
const T = '/apprenticeship/tasks';
const R = '/apprenticeship/reviews';

// ADMIN only (tutors, learners and managers never see plans).
const PLAN_ROUTES: Route[] = [
  { method: 'GET', path: P },
  { method: 'POST', path: P, body: { programmeId: PROG, title: 'New plan' } },
  { method: 'POST', path: `${P}/presign`, body: { files: [{ name: 'a.pdf', type: 'application/pdf' }] } },
  { method: 'GET', path: `${P}/${PLAN}` },
  { method: 'PATCH', path: `${P}/${PLAN}`, body: { title: 'Renamed' } },
  { method: 'DELETE', path: `${P}/${PLAN}` },
  { method: 'POST', path: `${P}/${PLAN}/archive` },
  { method: 'POST', path: `${P}/${PLAN}/unarchive` },
  { method: 'POST', path: `${P}/${PLAN}/items`, body: { title: 'T', typeKey: 'assignment' } },
  { method: 'PATCH', path: `${P}/${PLAN}/items/${ITEM}`, body: { title: 'T2' } },
  { method: 'DELETE', path: `${P}/${PLAN}/items/${ITEM}` },
  { method: 'PUT', path: `${P}/${PLAN}/items/reorder`, body: { orderedIds: [ITEM] } },
  { method: 'POST', path: `${P}/${PLAN}/assign`, body: { enrolmentIds: [ENR] } },
  { method: 'POST', path: `${P}/${PLAN}/unassign`, body: { enrolmentIds: [ENR] } },
  { method: 'POST', path: `${P}/${PLAN}/sync` }
];
// Routes that resolve an id (cross-org must 404); list / create / presign are org-scoped or programme-bound instead.
const PLAN_ID_ROUTES = PLAN_ROUTES.filter((r) => r.path.includes(PLAN));

const TASK_READ: Route = { method: 'GET', path: `${T}/enrolments/${ENR}/tasks` };
const TASK_CREATE: Route = {
  method: 'POST',
  path: `${T}/enrolments/${ENR}/tasks`,
  body: { title: 'Reflect', typeKey: 'assignment' }
};
const TASK_PATCH: Route = { method: 'PATCH', path: `${T}/${TASK}`, body: { title: 'Renamed' } };
const TASK_DELETE: Route = { method: 'DELETE', path: `${T}/${TASK}` };
const TASK_DOWNLOAD: Route = { method: 'POST', path: `${T}/download`, body: { taskId: TASK, keys: [TASK_KEY] } };
const TASK_PRESIGN: Route = {
  method: 'POST',
  path: `${T}/presign`,
  body: { enrolmentId: ENR, files: [{ name: 'a.pdf', type: 'application/pdf' }] }
};
const TASK_OVERDUE: Route = { method: 'GET', path: `${T}/overdue` };
// staff-only task routes (ADMIN or the allocated TUTOR)
const TASK_STAFF_ROUTES = [TASK_CREATE, TASK_PATCH, TASK_DELETE, TASK_PRESIGN];
const TASK_ID_ROUTES = [TASK_READ, TASK_CREATE, TASK_PATCH, TASK_DELETE, TASK_DOWNLOAD, TASK_PRESIGN];

const REVIEW_READ: Route = { method: 'GET', path: `${R}/enrolments/${ENR}/reviews` };
const REVIEW_CREATE: Route = {
  method: 'POST',
  path: `${R}/enrolments/${ENR}/reviews`,
  body: { scheduledDate: '2026-08-01' }
};
const REVIEW_PATCH_TUTOR: Route = { method: 'PATCH', path: `${R}/${REV}`, body: { tutorComment: 'Good' } };
const REVIEW_PATCH_LEARNER: Route = { method: 'PATCH', path: `${R}/${REV}`, body: { learnerComment: 'Thanks' } };
const REVIEW_SIGN_TUTOR: Route = { method: 'POST', path: `${R}/${REV}/sign`, body: { role: 'TUTOR', name: 'Tina' } };
const REVIEW_SIGN_LEARNER: Route = { method: 'POST', path: `${R}/${REV}/sign`, body: { role: 'LEARNER', name: 'Lee' } };
const REVIEW_CANCEL: Route = { method: 'POST', path: `${R}/${REV}/cancel` };

function call(r: Route, actor: string) {
  return app.request(r.path, {
    method: r.method,
    headers: { 'x-test-actor': actor, 'content-type': 'application/json' },
    body: r.body === undefined ? undefined : JSON.stringify(r.body)
  });
}
const status = async (r: Route, actor: string) => (await call(r, actor)).status;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.getApprProgramme).mockResolvedValue({
    id: PROG,
    organizationId: ORG,
    title: 'P',
    status: 'ACTIVE'
  } as never);
  vi.mocked(q.getApprEnrolment).mockResolvedValue(ENROLMENT as never);
  vi.mocked(q.getTaskPlan).mockResolvedValue(PLAN_ROW as never);
  vi.mocked(q.getPlanItem).mockResolvedValue(ITEM_ROW as never);
  vi.mocked(q.listPlanItems).mockResolvedValue([ITEM_ROW] as never);
  vi.mocked(q.listApprEnrolmentsByIds).mockResolvedValue([ENROLMENT] as never);
  vi.mocked(q.getApprTask).mockResolvedValue(TASK_ROW as never);
  vi.mocked(q.getApprReview).mockResolvedValue(REVIEW_ROW as never);
  vi.mocked(q.updateApprReviewIfUnchanged).mockImplementation((async (
    _tx: unknown,
    _id: string,
    _e: string,
    patch: object
  ) => ({ ...REVIEW_ROW, ...patch })) as never);
  vi.mocked(q.filterCriterionIdsInProgramme).mockImplementation(async (_p, ids) => ids);
  vi.mocked(q.filterUploadKeysInOrg).mockImplementation(async (_o, keys) => keys);
  vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(false);
});

const noWrites = () => {
  for (const fn of [
    q.insertTaskPlan,
    q.updateTaskPlan,
    q.deleteTaskPlan,
    q.insertPlanItem,
    q.updatePlanItem,
    q.deletePlanItem,
    q.insertApprTasksSkippingExisting,
    q.deletePlannedPlanTasks,
    q.insertApprTask,
    q.updateApprTask,
    q.deleteApprTask,
    q.insertApprReview,
    q.updateApprReviewIfUnchanged
  ]) {
    expect(fn).not.toHaveBeenCalled();
  }
};

describe('task plans — admin only', () => {
  for (const r of PLAN_ROUTES) {
    it(`${r.method} ${r.path.replace('/apprenticeship/task-plans', '').slice(0, 40) || '/'}: anon 401, learner/tutor/manager 403, no query runs`, async () => {
      expect(await status(r, 'anon')).toBe(401);
      for (const who of ['learner', 'tutor', 'manager']) expect(await status(r, who)).toBe(403);
      expect(q.getTaskPlan).not.toHaveBeenCalled();
      expect(q.getApprProgramme).not.toHaveBeenCalled();
      noWrites();
    });
  }

  for (const r of PLAN_ID_ROUTES) {
    it(`${r.method} ${r.path.replace('/apprenticeship/task-plans', '').slice(0, 40)}: admin of another org → 404, nothing written`, async () => {
      expect(await status(r, 'otherAdmin')).toBe(404);
      noWrites();
    });
  }

  it('the admin reaches every plan route (2xx)', async () => {
    for (const r of PLAN_ROUTES) {
      const s = await status(r, 'admin');
      expect(s, `${r.method} ${r.path}`).toBeGreaterThanOrEqual(200);
      expect(s, `${r.method} ${r.path}`).toBeLessThan(300);
    }
  });

  it('creating a plan on a programme of another org → 404; the plans list is queried with the ACTOR org', async () => {
    expect(await status(PLAN_ROUTES[1], 'otherAdmin')).toBe(404);
    expect(q.insertTaskPlan).not.toHaveBeenCalled();
    await app.request(P, { headers: { 'x-test-actor': 'otherAdmin', 'x-organization-id': ORG } });
    expect(vi.mocked(q.listTaskPlans).mock.calls[0][0]).toBe('org-2');
  });

  it('plan / item files must sit under THIS plan prefix and have been issued to the org', async () => {
    const own = `apprenticeship/plans/${PLAN}/new.pdf`;
    const otherPlan = `apprenticeship/plans/${'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}/new.pdf`;
    const patch = (key: string): Route => ({
      method: 'PATCH',
      path: `${P}/${PLAN}`,
      body: { files: [{ key, name: 'new.pdf' }] }
    });
    expect(await status(patch(own), 'admin')).toBe(200);
    expect(await status(patch(otherPlan), 'admin')).toBe(400);
    expect(await status(patch(`apprenticeship/${PROG}/${LRN}/ev/x.pdf`), 'admin')).toBe(400);
    vi.mocked(q.filterUploadKeysInOrg).mockResolvedValueOnce([]);
    expect(await status(patch(own), 'admin')).toBe(400);
    // an item may not smuggle one in either
    expect(
      await status(
        { method: 'PATCH', path: `${P}/${PLAN}/items/${ITEM}`, body: { files: [{ key: otherPlan, name: 'x.pdf' }] } },
        'admin'
      )
    ).toBe(400);
  });

  it('a criterion of another programme is a 400 (item create / update)', async () => {
    vi.mocked(q.filterCriterionIdsInProgramme).mockResolvedValue([]);
    const create: Route = {
      method: 'POST',
      path: `${P}/${PLAN}/items`,
      body: { title: 'T', typeKey: 'assignment', criterionIds: [CRIT] }
    };
    expect(await status(create, 'admin')).toBe(400);
    expect(
      await status({ method: 'PATCH', path: `${P}/${PLAN}/items/${ITEM}`, body: { criterionIds: [CRIT] } }, 'admin')
    ).toBe(400);
    expect(q.insertPlanItem).not.toHaveBeenCalled();
    expect(q.updatePlanItem).not.toHaveBeenCalled();
  });

  it('assign / unassign reject an enrolment of another programme (400) and an item of another plan (404)', async () => {
    vi.mocked(q.listApprEnrolmentsByIds).mockResolvedValue([{ ...ENROLMENT, programmeId: OTHER_PROG }] as never);
    expect(await status(PLAN_ROUTES[12], 'admin')).toBe(400);
    expect(await status(PLAN_ROUTES[13], 'admin')).toBe(400);
    expect(q.insertApprTasksSkippingExisting).not.toHaveBeenCalled();
    expect(q.deletePlannedPlanTasks).not.toHaveBeenCalled();
    vi.mocked(q.getPlanItem).mockResolvedValue({
      ...ITEM_ROW,
      planId: 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    } as never);
    expect(await status(PLAN_ROUTES[9], 'admin')).toBe(404);
    expect(await status(PLAN_ROUTES[10], 'admin')).toBe(404);
  });

  it('a plan brief can be downloaded by staff of the org only for keys on that plan (tutor only via an allocated learner; learner/other org never)', async () => {
    const ok: Route = {
      method: 'POST',
      path: `${T}/download`,
      body: { planId: PLAN, keys: [`apprenticeship/plans/${PLAN}/brief.pdf`] }
    };
    expect(await status(ok, 'admin')).toBe(200);
    expect(await status(ok, 'tutor')).toBe(404); // no allocated learner holds a task from the plan
    vi.mocked(q.isTutorAllocatedToPlanLearner).mockResolvedValueOnce(true);
    expect(await status(ok, 'tutor')).toBe(200);
    expect(await status(ok, 'learner')).toBe(403);
    expect(await status(ok, 'otherAdmin')).toBe(404);
    expect(
      await status({ ...ok, body: { planId: PLAN, keys: ['apprenticeship/plans/other/secret.pdf'] } }, 'admin')
    ).toBe(403);
    expect(await status({ ...ok, body: { keys: ['x'] } }, 'admin')).toBe(400);
  });
});

describe('tasks — role guard + scoping', () => {
  it('anon 401 and managers 403 on every task route, before any query runs', async () => {
    for (const r of [...TASK_ID_ROUTES, TASK_OVERDUE]) {
      expect(await status(r, 'anon'), r.path).toBe(401);
      expect(await status(r, 'manager'), r.path).toBe(403);
    }
    expect(q.getApprEnrolment).not.toHaveBeenCalled();
    expect(q.getApprTask).not.toHaveBeenCalled();
  });

  it('learners may read their tasks and download briefs, never create / edit / delete / presign / list overdue', async () => {
    for (const r of [...TASK_STAFF_ROUTES, TASK_OVERDUE]) expect(await status(r, 'learner'), r.path).toBe(403);
    expect(await status(TASK_READ, 'learner')).toBe(200);
    expect(await status(TASK_DOWNLOAD, 'learner')).toBe(200);
    noWrites();
  });

  it('a learner sees only THEIR enrolment and tasks (other learner → 404)', async () => {
    expect(await status(TASK_READ, 'otherLearner')).toBe(404);
    expect(await status(TASK_DOWNLOAD, 'otherLearner')).toBe(404);
  });

  it('a tutor reaches tasks of ALLOCATED learners only (404 otherwise), admin always (own org)', async () => {
    for (const r of TASK_ID_ROUTES) expect(await status(r, 'tutor'), `unallocated ${r.method} ${r.path}`).toBe(404);
    noWrites();
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(true);
    for (const r of TASK_ID_ROUTES) {
      const s = await status(r, 'tutor');
      expect(s, `allocated ${r.method} ${r.path}`).toBeGreaterThanOrEqual(200);
      expect(s, `allocated ${r.method} ${r.path}`).toBeLessThan(300);
    }
    for (const r of TASK_ID_ROUTES) expect(await status(r, 'admin'), r.path).toBeLessThan(300);
  });

  it('an admin of another org gets 404 on every task id and nothing is written', async () => {
    for (const r of TASK_ID_ROUTES) expect(await status(r, 'otherAdmin'), `${r.method} ${r.path}`).toBe(404);
    noWrites();
  });

  it('the overdue list is scoped: admin → org, tutor → restricted to their allocations', async () => {
    expect(await status(TASK_OVERDUE, 'admin')).toBe(200);
    expect(vi.mocked(q.listOverdueTasks).mock.calls[0][0]).toMatchObject({
      organizationId: ORG,
      restrictToTutorId: undefined
    });
    expect(await status(TASK_OVERDUE, 'tutor')).toBe(200);
    expect(vi.mocked(q.listOverdueTasks).mock.calls[1][0]).toMatchObject({
      organizationId: ORG,
      restrictToTutorId: 'u-tutor'
    });
    await app.request(`${T}/overdue`, { headers: { 'x-test-actor': 'otherAdmin', 'x-organization-id': ORG } });
    expect(vi.mocked(q.listOverdueTasks).mock.calls[2][0]).toMatchObject({ organizationId: 'org-2' });
  });

  it('brief-file keys: must be under the task prefix of THIS learner, presigned for the org, and listed on the task to download', async () => {
    const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const create = (key: string, withId = true): Route => ({
      method: 'POST',
      path: `${T}/enrolments/${ENR}/tasks`,
      body: { ...(withId ? { id } : {}), title: 'T', typeKey: 'assignment', files: [{ key, name: 'b.pdf' }] }
    });
    expect(await status(create(`apprenticeship/${PROG}/${LRN}/tasks/${id}/b.pdf`), 'admin')).toBe(201);
    expect(await status(create(`apprenticeship/${PROG}/${LRN2}/tasks/${id}/b.pdf`), 'admin')).toBe(400);
    expect(await status(create(`apprenticeship/plans/${PLAN}/b.pdf`), 'admin')).toBe(400);
    expect(await status(create(`apprenticeship/${PROG}/${LRN}/tasks/${id}/b.pdf`, false), 'admin')).toBe(400);
    // download: a key that is not on the task is refused even for the admin
    expect(
      await status(
        { ...TASK_DOWNLOAD, body: { taskId: TASK, keys: [`apprenticeship/${PROG}/${LRN}/tasks/${TASK}/other.pdf`] } },
        'admin'
      )
    ).toBe(403);
  });

  it('a criterion of another programme is a 400 on task create / update', async () => {
    vi.mocked(q.filterCriterionIdsInProgramme).mockResolvedValue([]);
    const create: Route = { ...TASK_CREATE, body: { title: 'T', typeKey: 'assignment', criterionIds: [CRIT] } };
    expect(await status(create, 'admin')).toBe(400);
    expect(await status({ ...TASK_PATCH, body: { criterionIds: [CRIT] } }, 'admin')).toBe(400);
    expect(q.insertApprTask).not.toHaveBeenCalled();
    expect(q.updateApprTask).not.toHaveBeenCalled();
  });
});

describe('reviews — role guard + scoping', () => {
  const ALL: Route[] = [
    REVIEW_READ,
    REVIEW_CREATE,
    REVIEW_PATCH_TUTOR,
    REVIEW_PATCH_LEARNER,
    REVIEW_SIGN_TUTOR,
    REVIEW_SIGN_LEARNER,
    REVIEW_CANCEL
  ];

  it('anon 401 and managers 403 on every review route, before any query runs', async () => {
    for (const r of ALL) {
      expect(await status(r, 'anon'), r.path).toBe(401);
      expect(await status(r, 'manager'), r.path).toBe(403);
    }
    expect(q.getApprEnrolment).not.toHaveBeenCalled();
    expect(q.getApprReview).not.toHaveBeenCalled();
  });

  it('learners cannot schedule or cancel (403); they read their own and can comment / sign only as themselves', async () => {
    expect(await status(REVIEW_CREATE, 'learner')).toBe(403);
    expect(await status(REVIEW_CANCEL, 'learner')).toBe(403);
    expect(await status(REVIEW_READ, 'learner')).toBe(200);
    expect(await status(REVIEW_PATCH_LEARNER, 'learner')).toBe(200);
    expect(await status(REVIEW_PATCH_TUTOR, 'learner')).toBe(403); // not their field
    vi.mocked(q.getApprReview).mockResolvedValue({ ...REVIEW_ROW, status: 'AWAITING_SIGNATURES' } as never);
    expect(await status(REVIEW_SIGN_LEARNER, 'learner')).toBe(200);
    expect(await status(REVIEW_SIGN_TUTOR, 'learner')).toBe(403); // cannot sign as the tutor
  });

  it('another learner or another org cannot see, comment on or sign the review (404)', async () => {
    vi.mocked(q.getApprReview).mockResolvedValue({ ...REVIEW_ROW, status: 'AWAITING_SIGNATURES' } as never);
    // (the schedule / cancel routes are staff-only, so another learner is stopped at the route guard there)
    for (const r of ALL) expect(await status(r, 'otherAdmin'), `otherAdmin ${r.method} ${r.path}`).toBe(404);
    for (const r of ALL.filter((x) => x !== REVIEW_CREATE && x !== REVIEW_CANCEL)) {
      expect(await status(r, 'otherLearner'), `otherLearner ${r.method} ${r.path}`).toBe(404);
    }
    expect(q.updateApprReviewIfUnchanged).not.toHaveBeenCalled();
    expect(q.insertApprReview).not.toHaveBeenCalled();
  });

  it('a tutor reaches reviews of ALLOCATED learners only; unallocated → 404 and nothing changes', async () => {
    vi.mocked(q.getApprReview).mockResolvedValue({ ...REVIEW_ROW, status: 'AWAITING_SIGNATURES' } as never);
    for (const r of [REVIEW_READ, REVIEW_CREATE, REVIEW_PATCH_TUTOR, REVIEW_SIGN_TUTOR, REVIEW_CANCEL]) {
      expect(await status(r, 'tutor'), `unallocated ${r.method} ${r.path}`).toBe(404);
    }
    expect(q.updateApprReviewIfUnchanged).not.toHaveBeenCalled();
    expect(q.insertApprReview).not.toHaveBeenCalled();
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(true);
    vi.mocked(q.getApprReview).mockResolvedValue({
      ...REVIEW_ROW,
      status: 'AWAITING_SIGNATURES',
      heldDate: '2026-06-02'
    } as never);
    expect(await status(REVIEW_READ, 'tutor')).toBe(200);
    expect(await status(REVIEW_CREATE, 'tutor')).toBe(201);
    expect(await status(REVIEW_PATCH_TUTOR, 'tutor')).toBe(200); // awaiting signatures, none signed yet → still editable
  });

  it('the admin schedules, edits, signs as tutor and cancels within the org', async () => {
    expect(await status(REVIEW_CREATE, 'admin')).toBe(201);
    expect(await status(REVIEW_PATCH_TUTOR, 'admin')).toBe(200);
    vi.mocked(q.getApprReview).mockResolvedValue({ ...REVIEW_ROW, status: 'AWAITING_SIGNATURES' } as never);
    expect(await status(REVIEW_SIGN_TUTOR, 'admin')).toBe(200);
    expect(await status(REVIEW_CANCEL, 'admin')).toBe(200);
  });
});
