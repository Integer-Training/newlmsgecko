import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Actor } from '@cio/db/actor';
import type { AuthSession } from '@api/types/auth';

// Gecko Apprenticeships round 2 Deploy 2 — GLH log, gateway and EPA API access. Real routers + services, DB mocked.
// Per route: anonymous 401, managers 403 before any query; learners read only their own and never write; a tutor reaches
// allocated learners only (404 otherwise); an admin of another org gets 404 on every id; programme checklist is ADMIN only.

vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  getApprEnrolment: vi.fn(),
  getApprProgramme: vi.fn(),
  getApprSettings: vi.fn(async () => ({ concernGapPct: 15, otjFactor: 0.2, otjWeeklyCapHours: 30 })),
  listProgrammeUnits: vi.fn(async () => [{ unitId: 'u1', qualificationId: 'q1', glh: 5 }]),
  listProgrammeCriteria: vi.fn(async () => []),
  countAcceptedByCriterion: vi.fn(async () => new Map()),
  getEvidenceTotals: vi.fn(async () => ({ submitted: 0, accepted: 0, referred: 0, otjMinutes: 0 })),
  listEnrolmentUnitRows: vi.fn(async () => []),
  writeEnrolmentCache: vi.fn(async () => undefined),
  sumGlhLogMinutes: vi.fn(async () => 0),
  claimGatewayReady: vi.fn(async () => false),
  clearGatewayReady: vi.fn(async () => undefined),
  setGatewayTick: vi.fn(async () => ({})),
  passGateway: vi.fn(async () => ({})),
  reopenGateway: vi.fn(async () => ({})),
  setEpa: vi.fn(async () => ({})),
  updateApprProgramme: vi.fn(async () => ({})),
  listEnrolmentIdsForProgramme: vi.fn(async () => []),
  listGlhLogs: vi.fn(async () => []),
  insertGlhLog: vi.fn(async () => ({ id: 'log-1', minutes: 60 })),
  deleteGlhLog: vi.fn(async () => true)
}));
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => false),
  isCourseTutorForLearner: vi.fn(async () => false),
  isCourseTutor: vi.fn(async () => false),
  getOrgMemberRoleId: vi.fn(async () => null)
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', () => ({ runInTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@api/services/organization/users', () => ({ createOrgUser: vi.fn() }));
vi.mock('@api/services/organization/allocation', () => ({ createTutorAllocation: vi.fn() }));
vi.mock('@api/services/apprenticeship/notifications', () => ({
  notifyGatewayReadyOrRelease: vi.fn(async () => undefined),
  notifySafely: async (_l: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch {
      /* non-fatal */
    }
  }
}));

import * as q from '@cio/db/queries/apprenticeship';
import { isTutorAllocatedToLearner } from '@cio/db/queries/allocation';
import { apprenticeshipRouter } from '@api/routes/apprenticeship';

const ORG = 'org-1';
const PROG = '11111111-1111-4111-8111-111111111111';
const LRN = '22222222-2222-4222-8222-222222222222';
const LRN2 = '23232323-2323-4232-8232-232323232323';
const ENR = '33333333-3333-4333-8333-333333333333';
const LOG = '44444444-4444-4444-8444-444444444444';

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

const enrolment = (over: Record<string, unknown> = {}) => ({
  id: ENR,
  organizationId: ORG,
  programmeId: PROG,
  learnerId: LRN,
  startDate: '2026-01-01',
  plannedEndDate: '2026-12-31',
  contractedHoursWeek: 30,
  otjTargetMinutesOverride: null,
  achievedAt: null,
  gatewayItems: {},
  gatewayPassedAt: null,
  epaBookedDate: null,
  epaResult: null,
  epaResultDate: null,
  ...over
});

type Route = { method: string; path: string; body?: unknown };
const E = `/apprenticeship/enrolments/${ENR}`;
const GLH_READ: Route = { method: 'GET', path: `${E}/glh-logs` };
const GLH_ADD: Route = { method: 'POST', path: `${E}/glh-logs`, body: { minutes: 60, logDate: '2026-02-01' } };
const GLH_DEL: Route = { method: 'DELETE', path: `${E}/glh-logs/${LOG}` };
const GW_READ: Route = { method: 'GET', path: `${E}/gateway` };
const GW_TICK: Route = { method: 'PUT', path: `${E}/gateway/items/english`, body: { done: true } };
const GW_CONFIRM: Route = { method: 'POST', path: `${E}/gateway/confirm` };
const GW_REOPEN: Route = { method: 'POST', path: `${E}/gateway/reopen` };
const EPA: Route = { method: 'PATCH', path: `${E}/epa`, body: { epaBookedDate: '2026-06-01' } };
const CL_READ: Route = { method: 'GET', path: `/apprenticeship/programmes/${PROG}/gateway-checklist` };
const CL_PUT: Route = {
  method: 'PUT',
  path: `/apprenticeship/programmes/${PROG}/gateway-checklist`,
  body: { checklist: [{ key: 'a', label: 'A', kind: 'MANUAL' }] }
};

const READS = [GLH_READ, GW_READ];
const STAFF_WRITES = [GLH_ADD, GLH_DEL, GW_TICK, GW_CONFIRM, EPA];
const ADMIN_ONLY = [GW_REOPEN, CL_READ, CL_PUT];
const ENROLMENT_ROUTES = [...READS, ...STAFF_WRITES, GW_REOPEN];

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
    status: 'ACTIVE',
    gatewayChecklist: null
  } as never);
  vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment() as never);
  vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(false);
});

const noWrites = () => {
  for (const fn of [
    q.insertGlhLog,
    q.deleteGlhLog,
    q.setGatewayTick,
    q.passGateway,
    q.reopenGateway,
    q.setEpa,
    q.updateApprProgramme
  ]) {
    expect(fn).not.toHaveBeenCalled();
  }
};

describe('role guard — before any query runs', () => {
  for (const r of [...ENROLMENT_ROUTES, ...ADMIN_ONLY]) {
    it(`${r.method} ${r.path.replace('/apprenticeship', '').replace(ENR, ':id').replace(PROG, ':id').replace(LOG, ':log')}: anon 401, manager 403`, async () => {
      expect(await status(r, 'anon')).toBe(401);
      expect(await status(r, 'manager')).toBe(403);
      expect(q.getApprEnrolment).not.toHaveBeenCalled();
      expect(q.getApprProgramme).not.toHaveBeenCalled();
      noWrites();
    });
  }

  it('learners never write GLH, gateway or EPA, and never touch the checklist or reopen (403)', async () => {
    for (const r of [...STAFF_WRITES, ...ADMIN_ONLY])
      expect(await status(r, 'learner'), `${r.method} ${r.path}`).toBe(403);
    noWrites();
  });

  it('tutors cannot edit the programme checklist or reopen a gateway (403)', async () => {
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(true);
    for (const r of ADMIN_ONLY) expect(await status(r, 'tutor'), `${r.method} ${r.path}`).toBe(403);
    noWrites();
  });
});

describe('scoping', () => {
  it('a learner reads their own GLH and gateway; another learner gets 404', async () => {
    for (const r of READS) {
      expect(await status(r, 'learner'), r.path).toBe(200);
      expect(await status(r, 'otherLearner'), r.path).toBe(404);
    }
  });

  it('a tutor reaches allocated learners only (404 otherwise) — reads and writes', async () => {
    for (const r of [...READS, ...STAFF_WRITES])
      expect(await status(r, 'tutor'), `unallocated ${r.method} ${r.path}`).toBe(404);
    noWrites();
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(true);
    vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment({ gatewayPassedAt: '2026-05-01T00:00:00Z' }) as never);
    // (a confirmed gateway so EPA is allowed; the tick route then answers 409 which is still past the scope check)
    for (const r of [GLH_READ, GLH_ADD, GLH_DEL, GW_READ, EPA]) {
      const s = await status(r, 'tutor');
      expect(s, `allocated ${r.method} ${r.path}`).toBeGreaterThanOrEqual(200);
      expect(s, `allocated ${r.method} ${r.path}`).toBeLessThan(300);
    }
    expect(await status(GW_TICK, 'tutor')).toBe(409);
  });

  it('an admin of another org gets 404 on every enrolment / programme id and nothing is written', async () => {
    for (const r of [...ENROLMENT_ROUTES, CL_READ, CL_PUT]) {
      expect(await status(r, 'otherAdmin'), `${r.method} ${r.path}`).toBe(404);
    }
    noWrites();
  });

  it('the admin reaches the enrolment routes in their own org', async () => {
    for (const r of [GLH_READ, GLH_ADD, GLH_DEL, GW_READ, GW_TICK, CL_READ, CL_PUT]) {
      const s = await status(r, 'admin');
      expect(s, `${r.method} ${r.path}`).toBeGreaterThanOrEqual(200);
      expect(s, `${r.method} ${r.path}`).toBeLessThan(300);
    }
  });
});

describe('request validation', () => {
  it('rejects bad GLH minutes, a malformed date, an invalid result and an invalid checklist (400)', async () => {
    expect(await status({ ...GLH_ADD, body: { minutes: 0, logDate: '2026-02-01' } }, 'admin')).toBe(400);
    expect(await status({ ...GLH_ADD, body: { minutes: 1441, logDate: '2026-02-01' } }, 'admin')).toBe(400);
    expect(await status({ ...GLH_ADD, body: { minutes: 30, logDate: 'yesterday' } }, 'admin')).toBe(400);
    expect(await status({ ...EPA, body: { epaResult: 'EXCELLENT' } }, 'admin')).toBe(400);
    expect(
      await status(
        {
          ...CL_PUT,
          body: {
            checklist: [
              { key: 'a', label: 'A', kind: 'AUTO_UNITS' },
              { key: 'b', label: 'B', kind: 'AUTO_UNITS' }
            ]
          }
        },
        'admin'
      )
    ).toBe(400);
    noWrites();
  });

  it('the programme checklist GET returns the default when none is set', async () => {
    const res = await call(CL_READ, 'admin');
    const body = (await res.json()) as { data: { isDefault: boolean; checklist: unknown[] } };
    expect(body.data.isDefault).toBe(true);
    expect(body.data.checklist).toHaveLength(6);
  });

  it('a gateway item that is automatic or unknown cannot be ticked (400 / 404) through the route', async () => {
    expect(await status({ ...GW_TICK, path: `${E}/gateway/items/units` }, 'admin')).toBe(400);
    expect(await status({ ...GW_TICK, path: `${E}/gateway/items/nope` }, 'admin')).toBe(404);
    expect(q.setGatewayTick).not.toHaveBeenCalled();
  });
});
