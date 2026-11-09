import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Actor } from '@cio/db/actor';
import type { AuthSession } from '@api/types/auth';

// Gecko Apprenticeships Phase A2 + B — enrolment + evidence API access. Real routers + real services, DB reads mocked.
// Proves: learners/managers are stopped at the route (401/403, no query runs); tutors reach only allocated learners
// and never the admin-only enrol / programme-dates routes; an admin of ANOTHER org gets 404 on every
// enrolment/evidence id; file keys must sit under the learner's own evidence prefix; criteria/units from another
// programme are rejected; and the services themselves scope a TUTOR (allocated only) and a LEARNER (self) so the
// later phases only have to open routes.

vi.mock('@cio/db/queries/apprenticeship', () => ({
  getApprProgramme: vi.fn(),
  getApprEnrolment: vi.fn(),
  getApprEnrolmentByProgrammeLearner: vi.fn(async () => null),
  getEnrolmentOverview: vi.fn(),
  listEnrolmentRows: vi.fn(async () => []),
  getApprSettings: vi.fn(async () => ({ concernGapPct: 15, otjFactor: 0.2, otjWeeklyCapHours: 30 })),
  getApprProgrammeStructure: vi.fn(async () => ({ qualifications: [], units: [], criteria: [] })),
  countEvidenceByCriterion: vi.fn(async () => new Map()),
  getEvidenceTotals: vi.fn(async () => ({ submitted: 0, accepted: 0, referred: 0, otjMinutes: 0 })),
  listEnrolmentUnitRows: vi.fn(async () => []),
  listAcceptedEvidenceTitles: vi.fn(async () => new Map()),
  insertApprEnrolment: vi.fn(),
  insertEnrolmentUnits: vi.fn(),
  updateApprEnrolment: vi.fn(),
  upsertEnrolmentUnitDates: vi.fn(),
  getApprEvidence: vi.fn(),
  insertApprEvidence: vi.fn(),
  insertApprReview: vi.fn(async () => ({ id: 'rev-1' })),
  insertApprUploads: vi.fn(async () => undefined),
  filterUploadKeysInOrg: vi.fn(async (_o: string, keys: string[]) => keys),
  markUploadsAttached: vi.fn(async () => undefined),
  markUploadsRemoved: vi.fn(async () => undefined),
  updateApprEvidence: vi.fn(),
  replaceEvidenceCriteria: vi.fn(),
  insertEvidenceNote: vi.fn(async () => ({ kind: 'GENERAL' })),
  listApprEvidenceTypes: vi.fn(async () => [{ key: 'assignment', label: 'Assignment', active: true }]),
  filterCriterionIdsInProgramme: vi.fn(async (_p: string, ids: string[]) => ids),
  listEvidenceForLearner: vi.fn(async () => []),
  listEvidenceCriteriaDetail: vi.fn(async () => []),
  listEvidenceNotes: vi.fn(async () => []),
  listEvidenceForCriterion: vi.fn(async () => []),
  listToMark: vi.fn(async () => []),
  listApprPickerPeople: vi.fn(async () => ({ tutors: [], learners: [] }))
}));
// Evidence notifications: spies, with the REAL non-fatal wrapper semantics (a failure is logged, never thrown).
vi.mock('@api/services/apprenticeship/notifications', () => ({
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
  recomputeEnrolment: vi.fn(async () => ({
    actualPct: null,
    expectedPct: null,
    status: 'NOT_SET',
    otjTargetMinutes: null,
    otjExpectedMinutes: null,
    otjMinutes: 0,
    otjStatus: 'NOT_SET',
    totals: { submitted: 1, accepted: 0, referred: 0, otjMinutes: 0 }
  }))
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
import { apprenticeshipRouter } from '@api/routes/apprenticeship';
import { notifyEvidenceReviewed, notifyEvidenceSubmitted } from '@api/services/apprenticeship/notifications';
import { getPortfolio } from '@api/services/apprenticeship/enrolment';
import { createEvidence, getEvidenceDetail, updateEvidence } from '@api/services/apprenticeship/evidence';

const ORG = 'org-1';
const ACTORS: Record<string, Actor> = {
  anon: { authenticated: false, reason: 'anonymous' },
  learner: { authenticated: true, userId: 'u-learner', role: 'LEARNER', status: 'ACTIVE', orgId: ORG },
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

const PROG = '11111111-1111-4111-8111-111111111111';
const LRN = '22222222-2222-4222-8222-222222222222';
const ENR = '33333333-3333-4333-8333-333333333333';
const EV = '44444444-4444-4444-8444-444444444444';
const CRIT = '55555555-5555-4555-8555-555555555555';
const UNIT = '66666666-6666-4666-8666-666666666666';
const OTHER_LRN = '77777777-7777-4777-8777-777777777777';
const TUTOR = '88888888-8888-4888-8888-888888888888';

const ENROLMENT = {
  id: ENR,
  organizationId: ORG,
  programmeId: PROG,
  learnerId: LRN,
  startDate: '2026-01-01',
  plannedEndDate: '2026-12-31',
  contractedHoursWeek: 30,
  otjTargetMinutesOverride: null,
  achievedAt: null,
  recomputedAt: null
};
const OVERVIEW = {
  enrolment: ENROLMENT,
  learnerName: 'Lee Learner',
  learnerEmail: 'lee@example.com',
  programmeTitle: 'Adult Care',
  programmeReference: null,
  programmeLevel: null,
  tutors: []
};
const EVIDENCE = {
  id: EV,
  organizationId: ORG,
  programmeId: PROG,
  learnerId: LRN,
  title: 'Case study',
  details: 'd',
  typeKey: 'assignment',
  minutes: 0,
  includeOtj: false,
  status: 'SUBMITTED',
  files: [{ key: `apprenticeship/${PROG}/${LRN}/${EV}/abc-own.pdf`, name: 'own.pdf' }]
};

type Route = { method: string; path: string; body?: unknown };
const OWN_KEY = `apprenticeship/${PROG}/${LRN}/${EV}/xyz-file.pdf`;
const CREATE_BODY = {
  title: 'Evidence',
  details: 'Did a thing',
  typeKey: 'assignment',
  minutes: 30,
  includeOtj: true,
  criterionIds: [CRIT]
};
// Every route with a body that passes validation, so a 4xx can only come from the guard / ownership checks.
const ENROLMENT_ROUTES: Route[] = [
  { method: 'GET', path: '/apprenticeship/enrolments' },
  {
    method: 'POST',
    path: '/apprenticeship/enrolments',
    body: {
      programmeId: PROG,
      learner: { learnerId: LRN },
      tutorId: TUTOR,
      startDate: '2026-01-01',
      plannedEndDate: '2026-12-31'
    }
  },
  { method: 'PATCH', path: `/apprenticeship/enrolments/${ENR}`, body: { contractedHoursWeek: 20 } },
  {
    method: 'PUT',
    path: `/apprenticeship/enrolments/${ENR}/unit-dates`,
    body: { units: [{ unitId: UNIT, startDate: '2026-01-01', targetDate: '2026-02-01' }] }
  },
  { method: 'POST', path: `/apprenticeship/enrolments/${ENR}/unit-dates/spread`, body: {} },
  { method: 'GET', path: `/apprenticeship/enrolments/${ENR}/portfolio` },
  { method: 'GET', path: `/apprenticeship/enrolments/${ENR}/export.csv` }
];
const EVIDENCE_ROUTES: Route[] = [
  { method: 'GET', path: `/apprenticeship/evidence/enrolments/${ENR}/evidence` },
  { method: 'POST', path: `/apprenticeship/evidence/enrolments/${ENR}/evidence`, body: CREATE_BODY },
  {
    method: 'POST',
    path: '/apprenticeship/evidence/presign',
    body: { enrolmentId: ENR, files: [{ name: 'a.pdf', type: 'application/pdf' }] }
  },
  { method: 'POST', path: '/apprenticeship/evidence/download', body: { evidenceId: EV, keys: [OWN_KEY] } },
  { method: 'GET', path: '/apprenticeship/evidence/to-mark' },
  { method: 'GET', path: `/apprenticeship/evidence/criteria/${CRIT}/evidence?enrolmentId=${ENR}` },
  { method: 'GET', path: `/apprenticeship/evidence/${EV}` },
  { method: 'PATCH', path: `/apprenticeship/evidence/${EV}`, body: { title: 'New' } },
  { method: 'POST', path: `/apprenticeship/evidence/${EV}/review`, body: { decision: 'ACCEPT', criterionIds: [CRIT] } },
  { method: 'POST', path: `/apprenticeship/evidence/${EV}/notes`, body: { kind: 'GENERAL', body: 'hello' } }
];
const ALL_ROUTES = [...ENROLMENT_ROUTES, ...EVIDENCE_ROUTES];
// Routes that resolve an enrolment/evidence by id (cross-org must 404). The list endpoints are org-scoped instead.
const ID_ROUTES = ALL_ROUTES.filter(
  (r) =>
    r.path.includes(ENR) ||
    r.path.includes(EV) ||
    r.path.includes(CRIT) ||
    r.path.endsWith('/presign') ||
    r.path.endsWith('/download')
);

function call(r: Route, actor: string) {
  return app.request(r.path, {
    method: r.method,
    headers: { 'x-test-actor': actor, 'content-type': 'application/json' },
    body: r.body === undefined ? undefined : JSON.stringify(r.body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.getApprProgramme).mockResolvedValue({
    id: PROG,
    organizationId: ORG,
    title: 'P',
    status: 'ACTIVE'
  } as never);
  vi.mocked(q.getApprEnrolment).mockResolvedValue(ENROLMENT as never);
  vi.mocked(q.getEnrolmentOverview).mockResolvedValue(OVERVIEW as never);
  vi.mocked(q.getApprEvidence).mockResolvedValue(EVIDENCE as never);
  vi.mocked(q.insertApprEvidence).mockResolvedValue(EVIDENCE as never);
  vi.mocked(q.updateApprEvidence).mockResolvedValue(EVIDENCE as never);
  vi.mocked(q.getApprEnrolmentByProgrammeLearner).mockResolvedValue(ENROLMENT as never);
  vi.mocked(q.filterCriterionIdsInProgramme).mockImplementation(async (_p, ids) => ids);
  vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(false);
});

// Phase B: enrolling a learner and the programme dates / hours stay admin-only; everything else is open to the
// allocated tutor too (the services 404 any learner who is not allocated to them).
const ADMIN_ONLY_ROUTES = [ENROLMENT_ROUTES[1], ENROLMENT_ROUTES[2]];
const STAFF_ROUTES = ALL_ROUTES.filter((r) => !ADMIN_ONLY_ROUTES.includes(r));
// Phase C: staff-only even then — unit dates, spread, the marking queue and reviewing. Every other route is open to
// the apprentice themselves (the services scope them to their own enrolment).
const STAFF_ONLY_ROUTES = [ENROLMENT_ROUTES[3], ENROLMENT_ROUTES[4], EVIDENCE_ROUTES[4], EVIDENCE_ROUTES[8]];
const LEARNER_ROUTES = STAFF_ROUTES.filter((r) => !STAFF_ONLY_ROUTES.includes(r));

describe('apprenticeship enrolment + evidence API — role guard', () => {
  for (const r of ALL_ROUTES) {
    const blocked = ADMIN_ONLY_ROUTES.includes(r)
      ? ['learner', 'tutor', 'manager']
      : STAFF_ONLY_ROUTES.includes(r)
        ? ['learner', 'manager']
        : ['manager'];
    it(`${r.method} ${r.path.replace('/apprenticeship', '').slice(0, 60)}: anon 401, ${blocked.join('/').toUpperCase()} 403, no query runs`, async () => {
      expect((await call(r, 'anon')).status).toBe(401);
      for (const who of blocked) expect((await call(r, who)).status).toBe(403);
      expect(q.getApprEnrolment).not.toHaveBeenCalled();
      expect(q.getEnrolmentOverview).not.toHaveBeenCalled();
      expect(q.getApprEvidence).not.toHaveBeenCalled();
      expect(q.listEnrolmentRows).not.toHaveBeenCalled();
      expect(q.insertApprEvidence).not.toHaveBeenCalled();
    });
  }
});

describe('ids are bound to the actor org', () => {
  for (const r of ID_ROUTES) {
    it(`${r.method} ${r.path.replace('/apprenticeship', '').slice(0, 60)}: admin of another org → 404, nothing written`, async () => {
      expect((await call(r, 'otherAdmin')).status).toBe(404);
      expect(q.insertApprEvidence).not.toHaveBeenCalled();
      expect(q.updateApprEvidence).not.toHaveBeenCalled();
      expect(q.insertEvidenceNote).not.toHaveBeenCalled();
      expect(q.updateApprEnrolment).not.toHaveBeenCalled();
      expect(q.upsertEnrolmentUnitDates).not.toHaveBeenCalled();
    });
  }
  it('create-enrolment with a programme of another org → 404', async () => {
    expect((await call(ENROLMENT_ROUTES[1], 'otherAdmin')).status).toBe(404);
    expect(q.insertApprEnrolment).not.toHaveBeenCalled();
  });
  it('the learners table and the marking queue are queried with the ACTOR org, never a header', async () => {
    await app.request('/apprenticeship/enrolments', {
      headers: { 'x-test-actor': 'otherAdmin', 'x-organization-id': ORG }
    });
    expect(vi.mocked(q.listEnrolmentRows).mock.calls[0][0]).toMatchObject({ organizationId: 'org-2' });
    await app.request('/apprenticeship/evidence/to-mark', { headers: { 'x-test-actor': 'otherAdmin' } });
    expect(vi.mocked(q.listToMark).mock.calls[0][0]).toMatchObject({ organizationId: 'org-2' });
  });
});

describe('file keys must be under the learner evidence prefix', () => {
  const create = (files: unknown, evidenceId: string | null = EV) =>
    call(
      {
        method: 'POST',
        path: `/apprenticeship/evidence/enrolments/${ENR}/evidence`,
        body: { ...CREATE_BODY, evidenceId: evidenceId ?? undefined, files }
      },
      'admin'
    );

  it("another learner's key → 400, nothing saved", async () => {
    const res = await create([
      { key: `apprenticeship/${PROG}/${OTHER_LRN}/${EV}/x-a.pdf`, name: 'a.pdf', type: 'application/pdf' }
    ]);
    expect(res.status).toBe(400);
    expect(q.insertApprEvidence).not.toHaveBeenCalled();
  });
  it('a key for another evidence id → 400', async () => {
    const res = await create([
      { key: `apprenticeship/${PROG}/${LRN}/${PROG}/x-a.pdf`, name: 'a.pdf', type: 'application/pdf' }
    ]);
    expect(res.status).toBe(400);
  });
  it('a coursework key (other door) → 400', async () => {
    const res = await create([{ key: 'coursework/c/l/u/a/1/x-a.pdf', name: 'a.pdf', type: 'application/pdf' }]);
    expect(res.status).toBe(400);
  });
  it('files without a presigned evidence id → 400', async () => {
    const res = await create([{ key: OWN_KEY, name: 'a.pdf', type: 'application/pdf' }], null);
    expect(res.status).toBe(400);
  });
  it('a key under the learner own prefix is accepted → 201', async () => {
    const res = await create([{ key: OWN_KEY, name: 'a.pdf', type: 'application/pdf' }]);
    expect(res.status).toBe(201);
    expect(q.insertApprEvidence).toHaveBeenCalledTimes(1);
  });
  it('a NEW key with no live upload row (expired / collected / another learner) → 400 "upload expired"; kept keys are not re-checked', async () => {
    vi.mocked(q.filterUploadKeysInOrg).mockResolvedValueOnce([]);
    const res = await create([{ key: OWN_KEY, name: 'a.pdf', type: 'application/pdf' }]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('expired');
    expect(q.insertApprEvidence).not.toHaveBeenCalled();
    // the lookup is scoped to the learner and refuses removed rows
    await create([{ key: OWN_KEY, name: 'a.pdf', type: 'application/pdf' }]);
    expect(vi.mocked(q.filterUploadKeysInOrg).mock.calls.at(-1)).toEqual([
      ORG,
      [OWN_KEY],
      { learnerId: LRN, notRemoved: true }
    ]);
  });
  it('an unaccepted file type → 400', async () => {
    const res = await create([{ key: OWN_KEY, name: 'a.exe', type: 'application/x-msdownload' }]);
    expect(res.status).toBe(400);
  });
  it('PATCH with a foreign key → 400 (keys already on the row are kept)', async () => {
    const bad = await call(
      {
        method: 'PATCH',
        path: `/apprenticeship/evidence/${EV}`,
        body: { files: [{ key: `apprenticeship/${PROG}/${OTHER_LRN}/${EV}/x-a.pdf`, name: 'a.pdf' }] }
      },
      'admin'
    );
    expect(bad.status).toBe(400);
    const ok = await call(
      {
        method: 'PATCH',
        path: `/apprenticeship/evidence/${EV}`,
        body: { files: [{ key: EVIDENCE.files[0].key, name: 'own.pdf' }] }
      },
      'admin'
    );
    expect(ok.status).toBe(200);
  });
  it('download of a key that is not on that evidence row → 403', async () => {
    const res = await call(
      { method: 'POST', path: '/apprenticeship/evidence/download', body: { evidenceId: EV, keys: [OWN_KEY] } },
      'admin'
    );
    expect(res.status).toBe(403);
    const ok = await call(
      {
        method: 'POST',
        path: '/apprenticeship/evidence/download',
        body: { evidenceId: EV, keys: [EVIDENCE.files[0].key] }
      },
      'admin'
    );
    expect(ok.status).toBe(200);
  });
  it('presign keys are rebuilt from the enrolment, never from input', async () => {
    const res = await call(
      {
        method: 'POST',
        path: '/apprenticeship/evidence/presign',
        body: { enrolmentId: ENR, files: [{ name: 'a.pdf', type: 'application/pdf' }] }
      },
      'admin'
    );
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.files[0].key.startsWith(`apprenticeship/${PROG}/${LRN}/${data.evidenceId}/`)).toBe(true);
  });
  it("presign onto another learner's evidence id → 404", async () => {
    vi.mocked(q.getApprEvidence).mockResolvedValue({ ...EVIDENCE, learnerId: OTHER_LRN } as never);
    const res = await call(
      {
        method: 'POST',
        path: '/apprenticeship/evidence/presign',
        body: { enrolmentId: ENR, evidenceId: EV, files: [{ name: 'a.pdf', type: 'application/pdf' }] }
      },
      'admin'
    );
    expect(res.status).toBe(404);
  });
});

describe('criteria and units must belong to the programme', () => {
  it('create evidence with a criterion from another programme → 400', async () => {
    vi.mocked(q.filterCriterionIdsInProgramme).mockResolvedValue([]);
    const res = await call(EVIDENCE_ROUTES[1], 'admin');
    expect(res.status).toBe(400);
    expect(q.insertApprEvidence).not.toHaveBeenCalled();
  });
  it('review confirming a foreign criterion → 400', async () => {
    vi.mocked(q.filterCriterionIdsInProgramme).mockResolvedValue([]);
    const res = await call(EVIDENCE_ROUTES[8], 'admin');
    expect(res.status).toBe(400);
    expect(q.updateApprEvidence).not.toHaveBeenCalled();
  });
  it('the criterion popover for a foreign criterion → 404', async () => {
    vi.mocked(q.filterCriterionIdsInProgramme).mockResolvedValue([]);
    expect((await call(EVIDENCE_ROUTES[5], 'admin')).status).toBe(404);
  });
  it('unit-dates for a unit outside the programme → 404, nothing written', async () => {
    const res = await call(ENROLMENT_ROUTES[3], 'admin'); // structure mock has no units
    expect(res.status).toBe(404);
    expect(q.upsertEnrolmentUnitDates).not.toHaveBeenCalled();
  });
  it('unit-dates with target before start → 400', async () => {
    const res = await call(
      {
        method: 'PUT',
        path: `/apprenticeship/enrolments/${ENR}/unit-dates`,
        body: { units: [{ unitId: UNIT, startDate: '2026-03-01', targetDate: '2026-02-01' }] }
      },
      'admin'
    );
    expect(res.status).toBe(400);
  });
  it('export for a unit outside the programme → 404', async () => {
    expect((await call({ method: 'GET', path: `${ENROLMENT_ROUTES[6].path}?unitId=${UNIT}` }, 'admin')).status).toBe(
      404
    );
  });
  it('an unknown evidence type → 400', async () => {
    const res = await call({ ...EVIDENCE_ROUTES[1], body: { ...CREATE_BODY, typeKey: 'nope' } }, 'admin');
    expect(res.status).toBe(400);
  });
});

describe('Phase B — tutors reach only their allocated learners', () => {
  // ID routes that a tutor may call; a non-allocated tutor must get 404 on each, with nothing written.
  const TUTOR_ID_ROUTES = ID_ROUTES.filter((r) => STAFF_ROUTES.includes(r));
  for (const r of TUTOR_ID_ROUTES) {
    it(`${r.method} ${r.path.replace('/apprenticeship', '').slice(0, 60)}: non-allocated tutor → 404, nothing written`, async () => {
      expect((await call(r, 'tutor')).status).toBe(404);
      expect(q.insertApprEvidence).not.toHaveBeenCalled();
      expect(q.updateApprEvidence).not.toHaveBeenCalled();
      expect(q.insertEvidenceNote).not.toHaveBeenCalled();
      expect(q.upsertEnrolmentUnitDates).not.toHaveBeenCalled();
    });
  }
  it('the learners table and marking queue are limited to the tutor allocations', async () => {
    expect((await call(ENROLMENT_ROUTES[0], 'tutor')).status).toBe(200);
    expect(vi.mocked(q.listEnrolmentRows).mock.calls[0][0]).toMatchObject({
      organizationId: ORG,
      restrictToTutorId: 'u-tutor'
    });
    expect((await call({ method: 'GET', path: '/apprenticeship/evidence/to-mark' }, 'tutor')).status).toBe(200);
    expect(vi.mocked(q.listToMark).mock.calls[0][0]).toMatchObject({
      organizationId: ORG,
      restrictToTutorId: 'u-tutor'
    });
  });
  it('an allocated tutor opens the portfolio, adds a note and marks submitted evidence', async () => {
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(true);
    expect((await call({ method: 'GET', path: `/apprenticeship/enrolments/${ENR}/portfolio` }, 'tutor')).status).toBe(
      200
    );
    expect((await call(EVIDENCE_ROUTES[9], 'tutor')).status).toBe(201);
    expect((await call(EVIDENCE_ROUTES[8], 'tutor')).status).toBe(200);
    expect(vi.mocked(q.updateApprEvidence).mock.calls[0][2]).toMatchObject({
      status: 'ACCEPTED',
      reviewedBy: 'u-tutor'
    });
  });
  it('an allocated tutor cannot reopen accepted evidence (admin only)', async () => {
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(true);
    vi.mocked(q.getApprEvidence).mockResolvedValue({ ...EVIDENCE, status: 'ACCEPTED' } as never);
    const refer = {
      method: 'POST',
      path: `/apprenticeship/evidence/${EV}/review`,
      body: { decision: 'REFER', criterionIds: [] }
    };
    expect((await call(refer, 'tutor')).status).toBe(403);
    expect(q.updateApprEvidence).not.toHaveBeenCalled();
  });
  it('an allocated tutor still cannot change programme dates / hours or enrol a learner', async () => {
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(true);
    for (const r of ADMIN_ONLY_ROUTES) expect((await call(r, 'tutor')).status).toBe(403);
    expect(q.updateApprEnrolment).not.toHaveBeenCalled();
    expect(q.insertApprEnrolment).not.toHaveBeenCalled();
  });
});

describe('Phase C — an apprentice reaches only their own portfolio', () => {
  const self = 'self';
  const selfActor = { ...ACTORS.learner, userId: LRN } as Actor;
  function callAs(r: Route, actor: Actor) {
    ACTORS[self] = actor;
    return call(r, self);
  }
  // Every learner-open ID route on SOMEONE ELSE's enrolment/evidence → 404, nothing written.
  const LEARNER_ID_ROUTES = ID_ROUTES.filter((r) => LEARNER_ROUTES.includes(r));
  for (const r of LEARNER_ID_ROUTES) {
    it(`${r.method} ${r.path.replace('/apprenticeship', '').slice(0, 60)}: another learner → 404, nothing written`, async () => {
      expect((await call(r, 'learner')).status).toBe(404);
      expect(q.insertApprEvidence).not.toHaveBeenCalled();
      expect(q.updateApprEvidence).not.toHaveBeenCalled();
      expect(q.insertEvidenceNote).not.toHaveBeenCalled();
    });
  }
  it('the learners list is limited to the apprentice themselves', async () => {
    expect((await call(ENROLMENT_ROUTES[0], 'learner')).status).toBe(200);
    expect(vi.mocked(q.listEnrolmentRows).mock.calls[0][0]).toMatchObject({
      organizationId: ORG,
      restrictToLearnerId: 'u-learner'
    });
  });
  it('the apprentice opens their portfolio and adds evidence — always SUBMITTED, even if they ask for ACCEPTED', async () => {
    expect(
      (await callAs({ method: 'GET', path: `/apprenticeship/enrolments/${ENR}/portfolio` }, selfActor)).status
    ).toBe(200);
    const body = { ...CREATE_BODY, status: 'ACCEPTED' };
    expect((await callAs({ ...EVIDENCE_ROUTES[1], body }, selfActor)).status).toBe(201);
    expect(vi.mocked(q.insertApprEvidence).mock.calls[0][1]).toMatchObject({ status: 'SUBMITTED', reviewedBy: null });
  });
  it('the apprentice cannot review, see the marking queue or set unit dates', async () => {
    for (const r of STAFF_ONLY_ROUTES) expect((await callAs(r, selfActor)).status).toBe(403);
    expect(q.updateApprEvidence).not.toHaveBeenCalled();
    expect(q.upsertEnrolmentUnitDates).not.toHaveBeenCalled();
  });
  it('the apprentice cannot edit ACCEPTED evidence but resubmits REFERRED evidence', async () => {
    vi.mocked(q.getApprEvidence).mockResolvedValue({ ...EVIDENCE, status: 'ACCEPTED' } as never);
    expect((await callAs(EVIDENCE_ROUTES[7], selfActor)).status).toBe(403);
    vi.mocked(q.getApprEvidence).mockResolvedValue({ ...EVIDENCE, status: 'REFERRED' } as never);
    expect((await callAs(EVIDENCE_ROUTES[7], selfActor)).status).toBe(200);
    expect(vi.mocked(q.updateApprEvidence).mock.calls[0][2]).toMatchObject({ status: 'SUBMITTED' });
  });
  it("an apprentice's note is always a GENERAL comment", async () => {
    expect((await callAs({ ...EVIDENCE_ROUTES[9], body: { kind: 'AUDIT', body: 'x' } }, selfActor)).status).toBe(201);
    expect(vi.mocked(q.insertEvidenceNote).mock.calls[0][1]).toMatchObject({ kind: 'GENERAL' });
  });
});

describe('services scope TUTOR (allocated only) and LEARNER (self) for the later phases', () => {
  it('a non-allocated tutor gets 404 on a portfolio and on evidence', async () => {
    await expect(getPortfolio(ACTORS.tutor, ENR)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getEvidenceDetail(ACTORS.tutor, EV)).rejects.toMatchObject({ statusCode: 404 });
  });
  it('an allocated tutor can read the portfolio', async () => {
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(true);
    const data = await getPortfolio(ACTORS.tutor, ENR);
    expect(data.learner.id).toBe(LRN);
    expect(data.summary).toMatchObject({ overdueTaskCount: 0, nextReview: null, reviewOverdue: false });
  });
  it('the portfolio summary carries overdue tasks and the next review (overdue computed on read)', async () => {
    vi.mocked(q.getEnrolmentOverview).mockResolvedValue({
      ...OVERVIEW,
      overdueTaskCount: 2,
      nextReview: { id: 'r1', scheduledDate: '2020-01-01', status: 'SCHEDULED' }
    } as never);
    const data = await getPortfolio(ACTORS.admin, ENR);
    expect(data.summary).toMatchObject({
      overdueTaskCount: 2,
      nextReview: { id: 'r1', scheduledDate: '2020-01-01', status: 'SCHEDULED' },
      reviewOverdue: true
    });
  });
  it("a learner cannot read a classmate's portfolio or evidence", async () => {
    vi.mocked(q.getEnrolmentOverview).mockResolvedValue({
      ...OVERVIEW,
      enrolment: { ...ENROLMENT, learnerId: OTHER_LRN }
    } as never);
    vi.mocked(q.getApprEvidence).mockResolvedValue({ ...EVIDENCE, learnerId: OTHER_LRN } as never);
    await expect(getPortfolio({ ...ACTORS.learner, userId: LRN } as Actor, ENR)).rejects.toMatchObject({
      statusCode: 404
    });
    await expect(getEvidenceDetail({ ...ACTORS.learner, userId: LRN } as Actor, EV)).rejects.toMatchObject({
      statusCode: 404
    });
  });
  it('a learner adds evidence for themselves as SUBMITTED even if they ask for ACCEPTED', async () => {
    const self = { ...ACTORS.learner, userId: LRN } as Actor;
    await createEvidence(self, ENR, { ...CREATE_BODY, files: [], status: 'ACCEPTED' } as never);
    expect(vi.mocked(q.insertApprEvidence).mock.calls[0][1]).toMatchObject({ status: 'SUBMITTED', reviewedBy: null });
    expect(vi.mocked(q.replaceEvidenceCriteria).mock.calls[0][3]).toBe('LEARNER');
  });
  it('a learner cannot edit ACCEPTED evidence, but resubmits REFERRED evidence', async () => {
    const self = { ...ACTORS.learner, userId: LRN } as Actor;
    vi.mocked(q.getApprEvidence).mockResolvedValue({ ...EVIDENCE, status: 'ACCEPTED' } as never);
    await expect(updateEvidence(self, EV, { title: 'x' })).rejects.toMatchObject({ statusCode: 403 });
    vi.mocked(q.getApprEvidence).mockResolvedValue({ ...EVIDENCE, status: 'REFERRED' } as never);
    await updateEvidence(self, EV, { title: 'x' });
    expect(vi.mocked(q.updateApprEvidence).mock.calls[0][2]).toMatchObject({ status: 'SUBMITTED' });
  });
});

describe('evidence notifications fire at each step of the loop (and never break it)', () => {
  const selfActor = { ...ACTORS.learner, userId: LRN } as Actor;
  function callAs(r: Route, actor: Actor) {
    ACTORS.self = actor;
    return call(r, 'self');
  }
  it("the apprentice's new evidence → their tutors are told", async () => {
    expect((await callAs(EVIDENCE_ROUTES[1], selfActor)).status).toBe(201);
    expect(notifyEvidenceSubmitted).toHaveBeenCalledWith({ evidenceId: expect.any(String), learnerId: LRN });
    expect(notifyEvidenceReviewed).not.toHaveBeenCalled();
  });
  it('staff evidence added as Submitted tells nobody; added as Accepted tells the apprentice', async () => {
    expect((await call(EVIDENCE_ROUTES[1], 'admin')).status).toBe(201);
    expect(notifyEvidenceSubmitted).not.toHaveBeenCalled();
    expect(notifyEvidenceReviewed).not.toHaveBeenCalled();
    vi.mocked(q.insertApprEvidence).mockResolvedValue({ ...EVIDENCE, status: 'ACCEPTED' } as never);
    expect((await call({ ...EVIDENCE_ROUTES[1], body: { ...CREATE_BODY, status: 'ACCEPTED' } }, 'admin')).status).toBe(
      201
    );
    expect(notifyEvidenceReviewed).toHaveBeenCalledWith(
      expect.objectContaining({ learnerId: LRN, outcome: 'ACCEPTED' })
    );
  });
  it('a review tells the apprentice (accepted / referred)', async () => {
    expect((await call(EVIDENCE_ROUTES[8], 'admin')).status).toBe(200);
    expect(notifyEvidenceReviewed).toHaveBeenCalledWith({ evidenceId: EV, learnerId: LRN, outcome: 'ACCEPTED' });
    vi.mocked(notifyEvidenceReviewed).mockClear();
    const refer = {
      method: 'POST',
      path: `/apprenticeship/evidence/${EV}/review`,
      body: { decision: 'REFER', criterionIds: [] }
    };
    expect((await call(refer, 'admin')).status).toBe(200);
    expect(notifyEvidenceReviewed).toHaveBeenCalledWith({ evidenceId: EV, learnerId: LRN, outcome: 'REFERRED' });
  });
  it('fixing referred evidence → the tutors are told again; a plain edit tells nobody', async () => {
    vi.mocked(q.getApprEvidence).mockResolvedValue({ ...EVIDENCE, status: 'REFERRED' } as never);
    expect((await callAs(EVIDENCE_ROUTES[7], selfActor)).status).toBe(200);
    expect(notifyEvidenceSubmitted).toHaveBeenCalledWith({ evidenceId: EV, learnerId: LRN });
    vi.mocked(notifyEvidenceSubmitted).mockClear();
    vi.mocked(q.getApprEvidence).mockResolvedValue({ ...EVIDENCE, status: 'SUBMITTED' } as never);
    expect((await callAs(EVIDENCE_ROUTES[7], selfActor)).status).toBe(200);
    expect(notifyEvidenceSubmitted).not.toHaveBeenCalled();
  });
  it('a notification failure never fails the save', async () => {
    vi.mocked(notifyEvidenceSubmitted).mockRejectedValueOnce(new Error('db down'));
    expect((await callAs(EVIDENCE_ROUTES[1], selfActor)).status).toBe(201);
  });
});

describe('Add-learner pickers (admin only, full names)', () => {
  const options: Route = { method: 'GET', path: '/apprenticeship/enrolments/options' };
  it('anon 401; learner / tutor / manager 403; nothing read', async () => {
    expect((await call(options, 'anon')).status).toBe(401);
    for (const who of ['learner', 'tutor', 'manager']) expect((await call(options, who)).status).toBe(403);
    expect(q.listApprPickerPeople).not.toHaveBeenCalled();
  });
  it("an admin gets their own org's tutors + learners", async () => {
    vi.mocked(q.listApprPickerPeople).mockResolvedValueOnce({
      tutors: [{ id: 't', name: 'Tina Tutor', email: 't@x.test' }],
      learners: [{ id: 'l', name: 'Amy Apprentice', email: 'a@x.test' }]
    } as never);
    const res = await call(options, 'admin');
    expect(res.status).toBe(200);
    expect(q.listApprPickerPeople).toHaveBeenCalledWith(ORG);
    expect((await res.json()).data.learners[0].name).toBe('Amy Apprentice');
  });
});

describe('evidence detail carries the enrolment (files can be added outside a portfolio)', () => {
  it('returns enrolmentId', async () => {
    const res = await call({ method: 'GET', path: `/apprenticeship/evidence/${EV}` }, 'admin');
    expect(res.status).toBe(200);
    expect((await res.json()).data.enrolmentId).toBe(ENR);
  });
});
