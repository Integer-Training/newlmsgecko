import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Actor } from '@cio/db/actor';
import type { AuthSession } from '@api/types/auth';

// Gecko Apprenticeships Deploy 2 — access across a linked Diploma + Standard pair. Real routers + real services with the
// DB reads mocked. A tutor assigned to ONE programme of the pair reaches the whole apprenticeship (either enrolment id);
// a tutor with no reach, another org, and another learner get 404; managers 403; the new admin-only routes are guarded.

vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  sumValidatedOtjLogMinutes: vi.fn(async () => 0),
  listLinkedUnitCounts: vi.fn(async () => new Map()),
  isProgrammeTutorOfLinked: vi.fn(async () => false),
  getApprEnrolment: vi.fn(),
  getApprProgramme: vi.fn(),
  getApprSettings: vi.fn(async () => ({ concernGapPct: 15, otjFactor: 0.2, otjWeeklyCapHours: 30 })),
  getEnrolmentOverview: vi.fn(),
  getApprProgrammeStructure: vi.fn(async () => ({ qualifications: [], units: [], criteria: [] })),
  countEvidenceByCriterion: vi.fn(async () => new Map()),
  listCriterionAcceptedDates: vi.fn(async () => new Map()),
  getEvidenceTotals: vi.fn(async () => ({ submitted: 0, accepted: 0, referred: 0, otjMinutes: 0 })),
  listEnrolmentUnitRows: vi.fn(async () => []),
  sumGlhLogMinutes: vi.fn(async () => 0),
  listEnrolmentRows: vi.fn(async () => []),
  getLinkedEnrolment: vi.fn(async () => null),
  listLearnerEnrolments: vi.fn(async () => []),
  linkApprEnrolments: vi.fn(async () => true),
  unlinkApprEnrolment: vi.fn(async () => undefined),
  countCrossMappedEvidence: vi.fn(async () => 0),
  getOrgLearnerByEmail: vi.fn(async () => null),
  countRegularCourses: vi.fn(async () => 0)
}));
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => false),
  getOrgMemberRoleId: vi.fn(async () => 3)
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', async () => ({
  runInTransaction: (fn: (tx: unknown) => unknown) => fn({}),
  // the real tag, so the tutorReachSql text can be rendered below
  sql: (await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm')).sql
}));
vi.mock('@api/services/apprenticeship/onboarding', () => ({ ensureOnboardingTypes: vi.fn(async () => undefined) }));
vi.mock('@api/services/organization/users', () => ({ createOrgUser: vi.fn() }));
vi.mock('@api/services/organization/allocation', () => ({ createTutorAllocation: vi.fn() }));
vi.mock('@api/middlewares/guards/ownership', () => ({ isAllocatedTutor: vi.fn(async () => false) }));

import * as q from '@cio/db/queries/apprenticeship';
import { isAllocatedTutor } from '@api/middlewares/guards/ownership';
import { apprenticeshipRouter } from '@api/routes/apprenticeship';

const ORG = 'org-1';
const DIP = '11111111-1111-4111-8111-111111111111';
const STD = '11111111-1111-4111-8111-222222222222';
const LRN = '22222222-2222-4222-8222-222222222222';
const CARRIER = '33333333-3333-4333-8333-333333333333';
const COMPONENT = '33333333-3333-4333-8333-444444444444';

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

const enrolmentRow = (id: string, programmeId: string, primaryEnrolmentId: string | null) => ({
  id,
  organizationId: ORG,
  learnerId: LRN,
  programmeId,
  primaryEnrolmentId,
  startDate: '2026-01-01',
  plannedEndDate: '2027-01-01',
  contractedHoursWeek: 30,
  otjTargetMinutesOverride: null,
  gatewayItems: {}
});

const overviewOf = (id: string, programmeId: string, primaryEnrolmentId: string | null) => ({
  enrolment: enrolmentRow(id, programmeId, primaryEnrolmentId),
  learnerName: 'Amy',
  learnerEmail: 'amy@example.com',
  programmeTitle: programmeId === DIP ? 'L3 Diploma' : 'L3 Standard',
  programmeReference: null,
  programmeLevel: '3',
  programmeType: programmeId === DIP ? 'DIPLOMA' : 'STANDARD',
  counterpart: {
    enrolmentId: id === CARRIER ? COMPONENT : CARRIER,
    programmeId: id === CARRIER ? STD : DIP,
    title: 'x',
    type: 'DIPLOMA'
  },
  tutors: [],
  overdueTaskCount: 0,
  nextReview: null,
  gatewayChecklist: null
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAllocatedTutor).mockResolvedValue(false);
  vi.mocked(q.isProgrammeTutor).mockResolvedValue(false);
  vi.mocked(q.isProgrammeTutorOfLinked).mockResolvedValue(false);
  vi.mocked(q.getApprEnrolment).mockImplementation((async (id: string) =>
    id === CARRIER
      ? enrolmentRow(CARRIER, DIP, null)
      : id === COMPONENT
        ? enrolmentRow(COMPONENT, STD, CARRIER)
        : null) as never);
  vi.mocked(q.getEnrolmentOverview).mockImplementation((async (id: string) =>
    id === CARRIER
      ? overviewOf(CARRIER, DIP, null)
      : id === COMPONENT
        ? overviewOf(COMPONENT, STD, CARRIER)
        : null) as never);
  vi.mocked(q.listEnrolmentRows).mockResolvedValue([]);
});

describe('tutor reach extends across the pair', () => {
  it('a tutor assigned only to the Standard opens the diploma (carrier) and the standard (component) portfolios', async () => {
    // programme tutor of STD only: the direct branch is true for the component, the linked branch for the carrier
    vi.mocked(q.isProgrammeTutor).mockImplementation(async (programmeId) => programmeId === STD);
    vi.mocked(q.isProgrammeTutorOfLinked).mockImplementation(async (_l, programmeId) => programmeId === DIP);
    for (const id of [CARRIER, COMPONENT]) {
      const res = await call('GET', `/apprenticeship/enrolments/${id}/portfolio`, 'tutor');
      expect(res.status, id).toBe(200);
    }
  });

  it('the linked check is asked about the learner + the enrolment programme + the tutor', async () => {
    vi.mocked(q.isProgrammeTutorOfLinked).mockResolvedValue(true);
    await call('GET', `/apprenticeship/enrolments/${CARRIER}/portfolio`, 'tutor');
    expect(q.isProgrammeTutorOfLinked).toHaveBeenCalledWith(LRN, DIP, 'u-tutor');
  });

  it('a tutor with no link of any kind (named, programme, linked) gets 404 on either id', async () => {
    for (const id of [CARRIER, COMPONENT]) {
      expect((await call('GET', `/apprenticeship/enrolments/${id}/portfolio`, 'tutor')).status).toBe(404);
    }
  });

  it('a named tutor needs no programme lookup at all (unchanged)', async () => {
    vi.mocked(isAllocatedTutor).mockResolvedValue(true);
    expect((await call('GET', `/apprenticeship/enrolments/${COMPONENT}/portfolio`, 'tutor')).status).toBe(200);
    expect(q.isProgrammeTutor).not.toHaveBeenCalled();
    expect(q.isProgrammeTutorOfLinked).not.toHaveBeenCalled();
  });

  it('another org (even an admin) and an unrelated learner get 404; the apprentice reads both of their own', async () => {
    for (const actor of ['otherAdmin', 'otherLearner']) {
      expect((await call('GET', `/apprenticeship/enrolments/${CARRIER}/portfolio`, actor)).status, actor).toBe(404);
    }
    for (const id of [CARRIER, COMPONENT]) {
      expect((await call('GET', `/apprenticeship/enrolments/${id}/portfolio`, 'learner')).status).toBe(200);
    }
  });

  it('managers have no apprenticeship access (403) on the list and the portfolio', async () => {
    expect((await call('GET', '/apprenticeship/enrolments', 'manager')).status).toBe(403);
    expect((await call('GET', `/apprenticeship/enrolments/${CARRIER}/portfolio`, 'manager')).status).toBe(403);
  });

  it('the learners list is restricted for a tutor by reach (the SQL branch is in tutorReachSql), org-wide for an admin', async () => {
    await call('GET', '/apprenticeship/enrolments?type=STANDARD', 'tutor');
    expect(vi.mocked(q.listEnrolmentRows).mock.calls[0][0]).toMatchObject({
      organizationId: ORG,
      restrictToTutorId: 'u-tutor',
      type: 'STANDARD'
    });
    await call('GET', `/apprenticeship/enrolments?programmeId=${STD}`, 'admin');
    expect(vi.mocked(q.listEnrolmentRows).mock.calls[1][0]).toMatchObject({ organizationId: ORG, programmeId: STD });
    expect(vi.mocked(q.listEnrolmentRows).mock.calls[1][0].restrictToTutorId).toBeUndefined();
  });
});

describe('the SQL reach rule has a third OR EXISTS across the pair', () => {
  it('tutorReachSql joins the learner enrolment to its linked counterpart and then to appr_programme_tutor', async () => {
    const real = await vi.importActual<typeof import('@cio/db/queries/apprenticeship')>(
      '@cio/db/queries/apprenticeship'
    );
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { sql: text } = new PgDialect().sqlToQuery(
      real.tutorReachSql('"appr_task"."learner_id"', '"appr_task"."programme_id"', 'tutor-1')
    );
    expect(text).toContain('tutor_allocation');
    expect(text.match(/appr_programme_tutor/g)?.length).toBe(2);
    expect(text).toContain('lk.primary_enrolment_id = me.id or lk.id = me.primary_enrolment_id');
    expect(text).toContain('me.learner_id = "appr_task"."learner_id"');
    expect(text).toContain('me.programme_id = "appr_task"."programme_id"');
  });
});

describe('new Deploy 2 routes are admin only', () => {
  const routes: { method: string; path: string; body?: unknown }[] = [
    { method: 'GET', path: `/apprenticeship/enrolments/learner-check?learnerId=${LRN}` },
    {
      method: 'POST',
      path: '/apprenticeship/enrolments/apprenticeship',
      body: {
        learner: { learnerId: LRN },
        tutorId: '88888888-8888-4888-8888-888888888888',
        enrolments: [{ programmeId: DIP, startDate: '2026-06-01', plannedEndDate: '2027-06-01' }]
      }
    },
    { method: 'POST', path: `/apprenticeship/enrolments/${CARRIER}/link`, body: { enrolmentId: COMPONENT } },
    { method: 'DELETE', path: `/apprenticeship/enrolments/${CARRIER}/link` }
  ];

  for (const r of routes) {
    it(`${r.method} ${r.path.split('?')[0].replace(/[0-9a-f-]{36}/g, ':id')}: anon 401, learner/tutor/manager 403`, async () => {
      expect((await call(r.method, r.path, 'anon', r.body)).status).toBe(401);
      for (const actor of ['learner', 'tutor', 'manager']) {
        expect((await call(r.method, r.path, actor, r.body)).status, actor).toBe(403);
      }
    });
  }

  it('learner-check needs exactly one of learnerId / email (400), and an admin gets the payload', async () => {
    expect((await call('GET', '/apprenticeship/enrolments/learner-check', 'admin')).status).toBe(400);
    expect(
      (await call('GET', `/apprenticeship/enrolments/learner-check?learnerId=${LRN}&email=a@b.co`, 'admin')).status
    ).toBe(400);
    const res = await call('GET', `/apprenticeship/enrolments/learner-check?learnerId=${LRN}`, 'admin');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      data: { exists: true, learnerId: LRN, regularCourses: 0 }
    });
  });

  it('another org admin cannot link or unlink these enrolments (404)', async () => {
    expect(
      (await call('POST', `/apprenticeship/enrolments/${CARRIER}/link`, 'otherAdmin', { enrolmentId: COMPONENT }))
        .status
    ).toBe(404);
    expect((await call('DELETE', `/apprenticeship/enrolments/${CARRIER}/link`, 'otherAdmin')).status).toBe(404);
  });
});
