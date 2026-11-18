import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Actor } from '@cio/db/actor';
import type { AuthSession } from '@api/types/auth';

// Gecko Apprenticeships Deploy 3 — off-the-job log access. Real router + real service, DB reads mocked. Admin: org;
// tutor: reach incl. across the linked pair; learner: own only (SUBMITTED, edit while SUBMITTED/REJECTED, delete while
// SUBMITTED, blocked after gateway confirmed); manager 403; other org / other learner 404; the queue is staff-only.

const state = vi.hoisted(() => ({
  log: null as Record<string, unknown> | null,
  carrier: null as Record<string, unknown> | null
}));

vi.mock('@cio/db/queries/apprenticeship', () => ({
  getLinkedEnrolment: vi.fn(async () => null),
  isProgrammeTutor: vi.fn(async () => false),
  isProgrammeTutorOfLinked: vi.fn(async () => false),
  getApprEnrolment: vi.fn(),
  getApprSettings: vi.fn(async () => ({ concernGapPct: 15, otjFactor: 0.2, otjWeeklyCapHours: 30 })),
  getOtjLog: vi.fn(),
  lockOtjLog: vi.fn(),
  lockApprEnrolment: vi.fn(),
  listOtjLogs: vi.fn(async () => []),
  listOtjEvidenceRows: vi.fn(async () => []),
  listOtjLogQueue: vi.fn(async () => []),
  insertOtjLog: vi.fn(async (_tx: unknown, v: Record<string, unknown>) => ({ id: 'new', ...v })),
  updateOtjLog: vi.fn(async (_tx: unknown, id: string, patch: Record<string, unknown>) => ({
    ...state.log,
    id,
    ...patch
  })),
  deleteOtjLog: vi.fn(async () => undefined)
}));
vi.mock('@cio/db/queries/allocation', () => ({ isTutorAllocatedToLearner: vi.fn(async () => false) }));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', () => ({ runInTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@api/middlewares/guards/ownership', () => ({ isAllocatedTutor: vi.fn(async () => false) }));
vi.mock('@api/services/apprenticeship/enrolment', async () => {
  const q = await import('@cio/db/queries/apprenticeship');
  return {
    resolveApprenticeship: async (id: string) => {
      const e = (await q.getApprEnrolment(id)) as { id: string; primaryEnrolmentId: string | null };
      const carrier = e.primaryEnrolmentId ? await q.getApprEnrolment(e.primaryEnrolmentId) : e;
      return { carrier, component: null };
    }
  };
});
vi.mock('@api/services/apprenticeship/progress', () => ({
  todayIso: () => '2026-06-01',
  recomputeEnrolment: vi.fn(async () => ({ gatewayReadyClaimed: false }))
}));
vi.mock('@api/services/apprenticeship/notifications', () => ({
  notifyGatewayReadyOrRelease: vi.fn(async () => undefined),
  notifyOtjSubmitted: vi.fn(async () => undefined),
  notifyOtjReviewed: vi.fn(async () => undefined),
  notifySafely: async (_l: string, fn: () => Promise<void>) => fn()
}));

import * as q from '@cio/db/queries/apprenticeship';
import { isAllocatedTutor } from '@api/middlewares/guards/ownership';
import { notifyOtjReviewed, notifyOtjSubmitted } from '@api/services/apprenticeship/notifications';
import { apprenticeshipRouter } from '@api/routes/apprenticeship';

const ORG = 'org-1';
const PROG = '11111111-1111-4111-8111-111111111111';
const LRN = '22222222-2222-4222-8222-222222222222';
const CARRIER = '33333333-3333-4333-8333-333333333333';
const COMPONENT = '33333333-3333-4333-8333-444444444444';
const LOG = '55555555-5555-4555-8555-555555555555';

const ACTORS: Record<string, Actor> = {
  anon: { authenticated: false, reason: 'anonymous' },
  learner: { authenticated: true, userId: LRN, role: 'LEARNER', status: 'ACTIVE', orgId: ORG },
  otherLearner: {
    authenticated: true,
    userId: '22222222-2222-4222-8222-999999999999',
    role: 'LEARNER',
    status: 'ACTIVE',
    orgId: ORG
  },
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

const enrolment = (id: string, primary: string | null, over: Record<string, unknown> = {}) => ({
  id,
  organizationId: ORG,
  learnerId: LRN,
  programmeId: PROG,
  primaryEnrolmentId: primary,
  startDate: '2026-01-01',
  plannedEndDate: '2027-01-01',
  contractedHoursWeek: 30,
  otjTargetMinutesOverride: null,
  gatewayPassedAt: null,
  ...over
});
const logRow = (over: Record<string, unknown> = {}) => ({
  id: LOG,
  organizationId: ORG,
  enrolmentId: CARRIER,
  learnerId: LRN,
  title: 'Workshop',
  details: '',
  logDate: '2026-05-01',
  minutes: 60,
  isOtj: true,
  status: 'SUBMITTED',
  reviewNote: null,
  ...over
});
const NEW_LOG = { title: 'Workshop', logDate: '2026-05-01', minutes: 90 };

beforeEach(() => {
  vi.clearAllMocks();
  state.carrier = enrolment(CARRIER, null);
  state.log = logRow();
  vi.mocked(isAllocatedTutor).mockResolvedValue(false);
  vi.mocked(q.isProgrammeTutor).mockResolvedValue(false);
  vi.mocked(q.isProgrammeTutorOfLinked).mockResolvedValue(false);
  vi.mocked(q.getApprEnrolment).mockImplementation((async (id: string) =>
    id === CARRIER ? state.carrier : id === COMPONENT ? enrolment(COMPONENT, CARRIER) : null) as never);
  vi.mocked(q.lockApprEnrolment).mockImplementation((async () => state.carrier) as never);
  vi.mocked(q.getOtjLog).mockImplementation((async () => state.log) as never);
  vi.mocked(q.lockOtjLog).mockImplementation((async () => state.log) as never);
});

describe('GET /enrolments/:id/otj', () => {
  it('admin, named tutor and the apprentice read it; either half of a pair resolves to the carrier', async () => {
    vi.mocked(isAllocatedTutor).mockResolvedValue(true);
    for (const actor of ['admin', 'tutor', 'learner']) {
      expect((await call('GET', `/apprenticeship/enrolments/${COMPONENT}/otj`, actor)).status, actor).toBe(200);
    }
    expect(vi.mocked(q.listOtjLogs).mock.calls.every((c) => c[0] === CARRIER)).toBe(true);
  });

  it('a tutor assigned only to the other programme of the pair reaches it', async () => {
    vi.mocked(q.isProgrammeTutorOfLinked).mockResolvedValue(true);
    expect((await call('GET', `/apprenticeship/enrolments/${CARRIER}/otj`, 'tutor')).status).toBe(200);
  });

  it('no reach / other org / other learner are 404; manager is 403', async () => {
    expect((await call('GET', `/apprenticeship/enrolments/${CARRIER}/otj`, 'tutor')).status).toBe(404);
    expect((await call('GET', `/apprenticeship/enrolments/${CARRIER}/otj`, 'otherAdmin')).status).toBe(404);
    expect((await call('GET', `/apprenticeship/enrolments/${CARRIER}/otj`, 'otherLearner')).status).toBe(404);
    expect((await call('GET', `/apprenticeship/enrolments/${CARRIER}/otj`, 'manager')).status).toBe(403);
  });
});

describe('POST /enrolments/:id/otj-logs', () => {
  it('a learner entry is always SUBMITTED (even if VALIDATED is asked), stored on the carrier; tutors are told', async () => {
    const res = await call('POST', `/apprenticeship/enrolments/${COMPONENT}/otj-logs`, 'learner', {
      ...NEW_LOG,
      status: 'VALIDATED'
    });
    expect(res.status).toBe(201);
    expect(vi.mocked(q.insertOtjLog).mock.calls[0][1]).toMatchObject({
      enrolmentId: CARRIER,
      status: 'SUBMITTED',
      createdBy: LRN
    });
    expect(notifyOtjSubmitted).toHaveBeenCalled();
  });

  it('staff may add it as VALIDATED (no tutor alert)', async () => {
    const res = await call('POST', `/apprenticeship/enrolments/${CARRIER}/otj-logs`, 'admin', {
      ...NEW_LOG,
      status: 'VALIDATED'
    });
    expect(res.status).toBe(201);
    expect(vi.mocked(q.insertOtjLog).mock.calls[0][1]).toMatchObject({ status: 'VALIDATED', reviewedBy: 'u-admin' });
    expect(notifyOtjSubmitted).not.toHaveBeenCalled();
  });

  it('a future date is 400; a date outside the window is allowed', async () => {
    const path = `/apprenticeship/enrolments/${CARRIER}/otj-logs`;
    expect((await call('POST', path, 'learner', { ...NEW_LOG, logDate: '2026-12-01' })).status).toBe(400);
    expect((await call('POST', path, 'learner', { ...NEW_LOG, logDate: '2025-01-01' })).status).toBe(201);
  });

  it('the learner is blocked after the gateway is confirmed; staff are not', async () => {
    state.carrier = enrolment(CARRIER, null, { gatewayPassedAt: '2026-05-01T00:00:00Z' });
    const path = `/apprenticeship/enrolments/${CARRIER}/otj-logs`;
    expect((await call('POST', path, 'learner', NEW_LOG)).status).toBe(403);
    vi.mocked(isAllocatedTutor).mockResolvedValue(true);
    expect((await call('POST', path, 'tutor', NEW_LOG)).status).toBe(201);
  });

  it('another learner is 404 and a manager 403', async () => {
    const path = `/apprenticeship/enrolments/${CARRIER}/otj-logs`;
    expect((await call('POST', path, 'otherLearner', NEW_LOG)).status).toBe(404);
    expect((await call('POST', path, 'manager', NEW_LOG)).status).toBe(403);
  });
});

describe('PATCH /otj-logs/:logId', () => {
  it('the learner edits their own SUBMITTED log; an edit of a REJECTED log resubmits it', async () => {
    expect((await call('PATCH', `/apprenticeship/otj-logs/${LOG}`, 'learner', { minutes: 30 })).status).toBe(200);
    expect(vi.mocked(q.updateOtjLog).mock.calls[0][2]).not.toHaveProperty('status');

    state.log = logRow({ status: 'REJECTED', reviewNote: 'no' });
    expect((await call('PATCH', `/apprenticeship/otj-logs/${LOG}`, 'learner', { minutes: 30 })).status).toBe(200);
    expect(vi.mocked(q.updateOtjLog).mock.calls[1][2]).toMatchObject({ status: 'SUBMITTED', reviewNote: null });
    expect(notifyOtjSubmitted).toHaveBeenCalledTimes(1);
  });

  it('the learner cannot edit a VALIDATED log, nor someone else log', async () => {
    state.log = logRow({ status: 'VALIDATED' });
    expect((await call('PATCH', `/apprenticeship/otj-logs/${LOG}`, 'learner', { minutes: 30 })).status).toBe(403);
    state.log = logRow();
    expect((await call('PATCH', `/apprenticeship/otj-logs/${LOG}`, 'otherLearner', { minutes: 30 })).status).toBe(404);
  });
});

describe('POST /otj-logs/:logId/review', () => {
  const review = (decision: string, extra: Record<string, unknown> = {}) => ({
    decision,
    expectedStatus: 'SUBMITTED',
    ...extra
  });
  const path = `/apprenticeship/otj-logs/${LOG}/review`;

  it('learners and managers are refused (403)', async () => {
    for (const actor of ['learner', 'manager']) {
      expect((await call('POST', path, actor, review('VALIDATE'))).status, actor).toBe(403);
    }
  });

  it('a tutor outside reach gets 404; a tutor in reach validates and the apprentice is told', async () => {
    expect((await call('POST', path, 'tutor', review('VALIDATE'))).status).toBe(404);
    vi.mocked(q.isProgrammeTutor).mockResolvedValue(true);
    expect((await call('POST', path, 'tutor', review('VALIDATE'))).status).toBe(200);
    expect(vi.mocked(q.updateOtjLog).mock.calls[0][2]).toMatchObject({ status: 'VALIDATED', reviewedBy: 'u-tutor' });
    expect(notifyOtjReviewed).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'VALIDATED', learnerId: LRN }));
  });

  it('REJECT needs a note (400)', async () => {
    expect((await call('POST', path, 'admin', review('REJECT'))).status).toBe(400);
    expect((await call('POST', path, 'admin', review('REJECT', { note: 'Not OTJ' }))).status).toBe(200);
  });

  it('a stale expectedStatus is 409', async () => {
    state.log = logRow({ status: 'VALIDATED' });
    expect((await call('POST', path, 'admin', review('VALIDATE'))).status).toBe(409);
  });

  it('reopening a VALIDATED log is admin only', async () => {
    state.log = logRow({ status: 'VALIDATED' });
    vi.mocked(q.isProgrammeTutor).mockResolvedValue(true);
    const body = { decision: 'REOPEN', expectedStatus: 'VALIDATED' };
    expect((await call('POST', path, 'tutor', body)).status).toBe(403);
    expect((await call('POST', path, 'admin', body)).status).toBe(200);
  });
});

describe('DELETE /otj-logs/:logId', () => {
  it('the learner deletes their own SUBMITTED log only', async () => {
    expect((await call('DELETE', `/apprenticeship/otj-logs/${LOG}`, 'learner')).status).toBe(200);
    state.log = logRow({ status: 'REJECTED' });
    expect((await call('DELETE', `/apprenticeship/otj-logs/${LOG}`, 'learner')).status).toBe(403);
    expect((await call('DELETE', `/apprenticeship/otj-logs/${LOG}`, 'otherLearner')).status).toBe(404);
  });

  it('staff in reach delete anything but VALIDATED; an admin may delete a validated one', async () => {
    vi.mocked(q.isProgrammeTutor).mockResolvedValue(true);
    state.log = logRow({ status: 'VALIDATED' });
    expect((await call('DELETE', `/apprenticeship/otj-logs/${LOG}`, 'tutor')).status).toBe(403);
    expect((await call('DELETE', `/apprenticeship/otj-logs/${LOG}`, 'admin')).status).toBe(200);
    state.log = logRow({ status: 'REJECTED' });
    expect((await call('DELETE', `/apprenticeship/otj-logs/${LOG}`, 'tutor')).status).toBe(200);
  });
});

describe('GET /otj-logs (cross-learner queue)', () => {
  it('learner and manager are 403', async () => {
    for (const actor of ['learner', 'manager']) {
      expect((await call('GET', '/apprenticeship/otj-logs', actor)).status, actor).toBe(403);
    }
  });

  it('admin = whole org, default SUBMITTED; tutor is restricted by reach', async () => {
    expect((await call('GET', '/apprenticeship/otj-logs', 'admin')).status).toBe(200);
    expect(vi.mocked(q.listOtjLogQueue).mock.calls[0][0]).toEqual({
      organizationId: ORG,
      status: 'SUBMITTED',
      restrictToTutorId: undefined
    });
    expect((await call('GET', '/apprenticeship/otj-logs?status=REJECTED', 'tutor')).status).toBe(200);
    expect(vi.mocked(q.listOtjLogQueue).mock.calls[1][0]).toEqual({
      organizationId: ORG,
      status: 'REJECTED',
      restrictToTutorId: 'u-tutor'
    });
  });
});
