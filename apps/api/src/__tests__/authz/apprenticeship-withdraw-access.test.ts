import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Actor } from '@cio/db/actor';
import type { AuthSession } from '@api/types/auth';

// Gecko Apprenticeships Deploy 5 — who may withdraw / reinstate. Real routers + real services with the DB reads mocked.
// Admin only (tutor, learner, manager 403, anonymous 401); another org's admin gets 404; reinstate's body is optional.

type Row = Record<string, unknown> & { id: string };
const store = new Map<string, Row>();

vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  isProgrammeTutorOfLinked: vi.fn(async () => false),
  getApprEnrolment: vi.fn(async (id: string) => store.get(id) ?? null),
  getApprProgramme: vi.fn(async (id: string) => ({
    id,
    organizationId: 'org-1',
    title: 'Programme',
    type: 'DIPLOMA',
    pairedProgrammeId: null
  })),
  lockApprEnrolment: vi.fn(async (_tx: unknown, id: string) => store.get(id) ?? null),
  lockLearnerEnrolments: vi.fn(async () => undefined),
  listLearnerEnrolments: vi.fn(async () => []),
  getLinkedEnrolment: vi.fn(async () => null),
  setApprEnrolmentWithdrawn: vi.fn(async (_tx: unknown, id: string, by: { reason: string; at: string }) => {
    Object.assign(store.get(id)!, { withdrawnAt: by.at, withdrawalReason: by.reason });
  }),
  clearApprEnrolmentWithdrawn: vi.fn(async (_tx: unknown, id: string) => {
    Object.assign(store.get(id)!, { withdrawnAt: null, withdrawalReason: null });
    return true;
  })
}));
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => false),
  getOrgMemberRoleId: vi.fn(async () => 3)
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', async () => ({
  runInTransaction: (fn: (tx: unknown) => unknown) => fn({}),
  sql: (await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm')).sql
}));
vi.mock('@api/services/apprenticeship/progress', () => ({
  todayIso: () => '2026-06-01',
  recomputeEnrolment: vi.fn(async () => null)
}));
vi.mock('@api/services/apprenticeship/onboarding', () => ({ ensureOnboardingTypes: vi.fn(async () => undefined) }));
vi.mock('@api/services/apprenticeship/notifications', () => ({ notifyGatewayReadyOrRelease: vi.fn() }));
vi.mock('@api/services/organization/users', () => ({ createOrgUser: vi.fn() }));
vi.mock('@api/services/organization/allocation', () => ({ createTutorAllocation: vi.fn() }));
vi.mock('@api/middlewares/guards/ownership', () => ({ isAllocatedTutor: vi.fn(async () => false) }));

import * as q from '@cio/db/queries/apprenticeship';
import { apprenticeshipRouter } from '@api/routes/apprenticeship';

const ORG = 'org-1';
const LRN = '22222222-2222-4222-8222-222222222222';
const PROG = '11111111-1111-4111-8111-111111111111';
const ENR = '33333333-3333-4333-8333-333333333333';

const ACTORS: Record<string, Actor> = {
  anon: { authenticated: false, reason: 'anonymous' },
  learner: { authenticated: true, userId: LRN, role: 'LEARNER', status: 'ACTIVE', orgId: ORG },
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

function call(method: string, path: string, actor: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'x-test-actor': actor, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  store.set(ENR, {
    id: ENR,
    organizationId: ORG,
    learnerId: LRN,
    programmeId: PROG,
    primaryEnrolmentId: null,
    withdrawnAt: null,
    withdrawalReason: null,
    achievedAt: null
  });
});

const withdraw = (actor: string, body: unknown = { reason: 'Left the employer', scope: 'BOTH' }) =>
  call('POST', `/apprenticeship/enrolments/${ENR}/withdraw`, actor, body);

describe('withdraw', () => {
  it('is admin only: anonymous 401, tutor / learner / manager 403', async () => {
    expect((await withdraw('anon')).status).toBe(401);
    for (const actor of ['tutor', 'learner', 'manager']) {
      expect((await withdraw(actor)).status, actor).toBe(403);
    }
    expect(q.setApprEnrolmentWithdrawn).not.toHaveBeenCalled();
  });

  it("another org's admin gets 404 and nothing is written", async () => {
    expect((await withdraw('otherAdmin')).status).toBe(404);
    expect(q.setApprEnrolmentWithdrawn).not.toHaveBeenCalled();
  });

  it('the admin withdraws: 200 with { enrolmentId, withdrawnIds, closed, withdrawnAt }', async () => {
    const res = await withdraw('admin');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ enrolmentId: ENR, withdrawnIds: [ENR], closed: true });
    expect(typeof data.withdrawnAt).toBe('string');
  });

  it('a missing reason or an unknown scope is a 400', async () => {
    expect((await withdraw('admin', { scope: 'BOTH' })).status).toBe(400);
    expect((await withdraw('admin', { reason: '   ' })).status).toBe(400);
    expect((await withdraw('admin', { reason: 'ok', scope: 'ALL' })).status).toBe(400);
  });

  it('a second withdraw of the same enrolment is a 409', async () => {
    await withdraw('admin');
    expect((await withdraw('admin')).status).toBe(409);
  });
});

describe('reinstate', () => {
  const reinstate = (actor: string, body?: unknown) =>
    call('POST', `/apprenticeship/enrolments/${ENR}/reinstate`, actor, body);

  beforeEach(() => {
    Object.assign(store.get(ENR)!, { withdrawnAt: '2026-05-01T09:00:00.000Z', withdrawalReason: 'x' });
  });

  it('is admin only: anonymous 401, tutor / learner / manager 403, another org 404', async () => {
    expect((await reinstate('anon')).status).toBe(401);
    for (const actor of ['tutor', 'learner', 'manager']) {
      expect((await reinstate(actor)).status, actor).toBe(403);
    }
    expect((await reinstate('otherAdmin')).status).toBe(404);
    expect(q.clearApprEnrolmentWithdrawn).not.toHaveBeenCalled();
  });

  it('the admin reinstates with NO body (scope defaults to THIS)', async () => {
    const res = await call('POST', `/apprenticeship/enrolments/${ENR}/reinstate`, 'admin');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ enrolmentId: ENR, reinstatedIds: [ENR] });
    expect(store.get(ENR)!.withdrawnAt).toBeNull();
  });

  it('an explicit scope is accepted; a bad one is a 400; reinstating an active enrolment is a 409', async () => {
    expect((await reinstate('admin', { scope: 'NOPE' })).status).toBe(400);
    expect((await reinstate('admin', { scope: 'BOTH' })).status).toBe(200);
    expect((await reinstate('admin', { scope: 'BOTH' })).status).toBe(409);
  });
});
