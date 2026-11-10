import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Actor } from '@cio/db/actor';
import type { AuthSession } from '@api/types/auth';

// Gecko Apprenticeships Phase A1 — admin-only programme/structure/settings API. Real routers + real services with the
// DB reads mocked: non-admins are stopped by the guard before any query runs; an admin of ANOTHER org gets 404 on a
// programme id; a nested id that does not chain up to the programme gets 404.

vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  getApprProgramme: vi.fn(),
  getApprQualificationInProgramme: vi.fn(async () => null),
  getApprUnitInProgramme: vi.fn(async () => null),
  getApprCriterionInProgramme: vi.fn(async () => null),
  getApprProgrammeStructure: vi.fn(async () => ({ qualifications: [], units: [], criteria: [] })),
  listApprProgrammesWithCounts: vi.fn(async () => []),
  listApprQualificationIds: vi.fn(async () => []),
  insertApprProgrammeWithQualification: vi.fn(),
  insertApprQualification: vi.fn(),
  insertApprUnit: vi.fn(),
  insertApprCriterion: vi.fn(),
  insertApprUnits: vi.fn(),
  insertApprCriteria: vi.fn(),
  updateApprProgramme: vi.fn(),
  updateApprQualification: vi.fn(),
  updateApprUnit: vi.fn(),
  updateApprCriterion: vi.fn(),
  deleteApprQualification: vi.fn(),
  deleteApprUnit: vi.fn(),
  deleteApprCriterion: vi.fn(),
  listChildIds: vi.fn(async () => []),
  writeSortOrder: vi.fn(),
  listCriterionIdsForQualification: vi.fn(async () => []),
  listCriterionIdsForUnit: vi.fn(async () => []),
  countEvidenceMappingsForCriteria: vi.fn(async () => 0),
  listEnrolmentIdsForProgramme: vi.fn(async () => []),
  getApprSettings: vi.fn(async () => ({ concernGapPct: 15, otjFactor: 0.2, otjWeeklyCapHours: 30 })),
  listApprEvidenceTypes: vi.fn(async () => []),
  upsertApprSettings: vi.fn(),
  insertApprEvidenceType: vi.fn(),
  updateApprEvidenceType: vi.fn(async () => null)
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', () => ({ runInTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@api/services/apprenticeship/progress', () => ({ recomputeEnrolment: vi.fn(async () => null) }));
// The enrolment service (mounted on the same router) provisions accounts + allocations; neither is exercised here.
vi.mock('@api/services/organization/users', () => ({ createOrgUser: vi.fn() }));
vi.mock('@api/services/organization/allocation', () => ({ createTutorAllocation: vi.fn() }));

import * as q from '@cio/db/queries/apprenticeship';
import { apprenticeshipRouter } from '@api/routes/apprenticeship';

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

const P = '11111111-1111-4111-8111-111111111111';
const QID = '22222222-2222-4222-8222-222222222222';
const UID = '33333333-3333-4333-8333-333333333333';
const CID = '44444444-4444-4444-8444-444444444444';
const base = `/apprenticeship/programmes/${P}`;
const nested = `${base}/qualifications/${QID}`;

type Route = { method: string; path: string; body?: unknown };
// Every route, with a body that passes validation so a 4xx can only come from the guard / ownership checks.
const PROGRAMME_ROUTES: Route[] = [
  { method: 'GET', path: base },
  { method: 'PATCH', path: base, body: { title: 'New' } },
  { method: 'PUT', path: `${base}/reorder`, body: { kind: 'qualification', parentId: P, orderedIds: [QID] } },
  { method: 'POST', path: `${base}/import`, body: { csv: 'unit_code\nU1', mode: 'preview' } },
  { method: 'POST', path: `${base}/qualifications`, body: { title: 'Q' } }
];
const NESTED_ROUTES: Route[] = [
  { method: 'PATCH', path: nested, body: { title: 'Q' } },
  { method: 'DELETE', path: nested },
  { method: 'POST', path: `${nested}/units`, body: { title: 'U' } },
  { method: 'PATCH', path: `${nested}/units/${UID}`, body: { title: 'U' } },
  { method: 'DELETE', path: `${nested}/units/${UID}` },
  { method: 'POST', path: `${nested}/units/${UID}/criteria`, body: { code: '1.1', text: 'T', requiredCount: 1 } },
  { method: 'PATCH', path: `${nested}/units/${UID}/criteria/${CID}`, body: { text: 'T' } },
  { method: 'DELETE', path: `${nested}/units/${UID}/criteria/${CID}` }
];
const COLLECTION_ROUTES: Route[] = [
  { method: 'GET', path: '/apprenticeship/programmes' },
  { method: 'POST', path: '/apprenticeship/programmes', body: { title: 'P' } },
  { method: 'GET', path: '/apprenticeship/settings' },
  {
    method: 'PUT',
    path: '/apprenticeship/settings',
    body: { concernGapPct: 10, otjFactor: 0.2, otjWeeklyCapHours: 30 }
  },
  { method: 'POST', path: '/apprenticeship/settings/evidence-types', body: { label: 'Poster' } },
  { method: 'PATCH', path: `/apprenticeship/settings/evidence-types/${CID}`, body: { active: false } }
];
const ALL_ROUTES = [...COLLECTION_ROUTES, ...PROGRAMME_ROUTES, ...NESTED_ROUTES];

function call(r: Route, actor: string) {
  return app.request(r.path, {
    method: r.method,
    headers: { 'x-test-actor': actor, 'content-type': 'application/json' },
    body: r.body === undefined ? undefined : JSON.stringify(r.body)
  });
}

const PROGRAMME = { id: P, organizationId: ORG, title: 'Programme', status: 'ACTIVE' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.getApprProgramme).mockResolvedValue(PROGRAMME as never);
});

// Phase B: tutors may READ the programme list (learners-table filter) and the settings bundle (evidence types for the
// evidence form) and one programme's structure (the criteria picker when marking from To mark); every write stays
// admin-only.
const TUTOR_READABLE = [COLLECTION_ROUTES[0], COLLECTION_ROUTES[2], PROGRAMME_ROUTES[0]];

describe('apprenticeship admin API — ADMIN only (tutor read of list + settings)', () => {
  for (const r of ALL_ROUTES) {
    // Phase C: the settings bundle (evidence types) is also read by the apprentice's own evidence form.
    const blocked =
      r === COLLECTION_ROUTES[2]
        ? ['manager']
        : TUTOR_READABLE.includes(r)
          ? ['learner', 'manager']
          : ['learner', 'tutor', 'manager'];
    it(`${r.method} ${r.path.replace('/apprenticeship', '')}: anon 401, ${blocked.join('/').toUpperCase()} 403, no query runs`, async () => {
      expect((await call(r, 'anon')).status).toBe(401);
      for (const who of blocked) expect((await call(r, who)).status).toBe(403);
      expect(q.getApprProgramme).not.toHaveBeenCalled();
      expect(q.listApprProgrammesWithCounts).not.toHaveBeenCalled();
      expect(q.upsertApprSettings).not.toHaveBeenCalled();
    });
  }
});

describe('programme ids are bound to the actor org', () => {
  for (const r of [...PROGRAMME_ROUTES, ...NESTED_ROUTES]) {
    it(`${r.method} ${r.path.replace('/apprenticeship/programmes', '')}: admin of another org → 404, nothing written`, async () => {
      expect((await call(r, 'otherAdmin')).status).toBe(404);
      expect(q.updateApprProgramme).not.toHaveBeenCalled();
      expect(q.deleteApprQualification).not.toHaveBeenCalled();
      expect(q.insertApprQualification).not.toHaveBeenCalled();
      expect(q.insertApprUnit).not.toHaveBeenCalled();
      expect(q.insertApprCriterion).not.toHaveBeenCalled();
    });
  }
  it('a missing programme → 404', async () => {
    vi.mocked(q.getApprProgramme).mockResolvedValue(null);
    expect((await call(PROGRAMME_ROUTES[0], 'admin')).status).toBe(404);
  });
});

describe('nested ids must chain up to the programme', () => {
  for (const r of NESTED_ROUTES) {
    it(`${r.method} ${r.path.replace(base, '')}: id from another programme → 404`, async () => {
      // Programme is the admin's own, but the qualification/unit/criterion lookups (bound to the programme) find nothing.
      expect((await call(r, 'admin')).status).toBe(404);
      expect(q.updateApprQualification).not.toHaveBeenCalled();
      expect(q.updateApprUnit).not.toHaveBeenCalled();
      expect(q.updateApprCriterion).not.toHaveBeenCalled();
      expect(q.deleteApprUnit).not.toHaveBeenCalled();
      expect(q.deleteApprCriterion).not.toHaveBeenCalled();
      expect(q.insertApprUnit).not.toHaveBeenCalled();
      expect(q.insertApprCriterion).not.toHaveBeenCalled();
    });
  }
  it('reorder with a parent outside the programme → 404', async () => {
    const r: Route = {
      method: 'PUT',
      path: `${base}/reorder`,
      body: { kind: 'unit', parentId: QID, orderedIds: [UID] }
    };
    expect((await call(r, 'admin')).status).toBe(404);
    expect(q.writeSortOrder).not.toHaveBeenCalled();
  });
  it('reorder naming an item that is not a child of the parent → 404', async () => {
    vi.mocked(q.getApprQualificationInProgramme).mockResolvedValueOnce({ id: QID } as never);
    vi.mocked(q.listChildIds).mockResolvedValueOnce(['someone-else'] as never);
    const r: Route = {
      method: 'PUT',
      path: `${base}/reorder`,
      body: { kind: 'unit', parentId: QID, orderedIds: [UID] }
    };
    expect((await call(r, 'admin')).status).toBe(404);
    expect(q.writeSortOrder).not.toHaveBeenCalled();
  });
});

describe('tutor reads', () => {
  it("a tutor reads one programme's structure (org-bound: another org's id is a 404)", async () => {
    expect((await call(PROGRAMME_ROUTES[0], 'tutor')).status).toBe(200);
    vi.mocked(q.getApprProgramme).mockResolvedValue({ ...PROGRAMME, organizationId: 'org-2' } as never);
    expect((await call(PROGRAMME_ROUTES[0], 'tutor')).status).toBe(404);
  });
  it('a tutor lists programmes and reads the settings bundle for their own org', async () => {
    expect((await call(COLLECTION_ROUTES[0], 'tutor')).status).toBe(200);
    expect(q.listApprProgrammesWithCounts).toHaveBeenCalledWith(ORG, 'ACTIVE');
    expect((await call(COLLECTION_ROUTES[2], 'tutor')).status).toBe(200);
    expect(q.listApprEvidenceTypes).toHaveBeenCalledWith(ORG);
  });
});

describe('admin happy paths', () => {
  it('lists programmes for the actor org (org never read from a header)', async () => {
    const res = await app.request('/apprenticeship/programmes?status=ALL', {
      headers: { 'x-test-actor': 'admin', 'x-organization-id': 'org-evil' }
    });
    expect(res.status).toBe(200);
    expect(q.listApprProgrammesWithCounts).toHaveBeenCalledWith(ORG, 'ALL');
  });
  it('deleting an existing criterion reports removedMappings', async () => {
    vi.mocked(q.getApprCriterionInProgramme).mockResolvedValueOnce({ id: CID } as never);
    vi.mocked(q.countEvidenceMappingsForCriteria).mockResolvedValueOnce(3);
    const res = await call({ method: 'DELETE', path: `${nested}/units/${UID}/criteria/${CID}` }, 'admin');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ removedMappings: 3 });
  });
  it('unknown evidence type id → 404', async () => {
    const res = await call(
      { method: 'PATCH', path: `/apprenticeship/settings/evidence-types/${CID}`, body: { active: false } },
      'admin'
    );
    expect(res.status).toBe(404);
  });
  it('editing the details of a one-course programme mirrors them onto its only qualification', async () => {
    vi.mocked(q.updateApprProgramme).mockResolvedValueOnce(PROGRAMME as never);
    vi.mocked(q.listApprQualificationIds).mockResolvedValueOnce([QID]);
    const body = { title: 'L5 Adult Care', awardingBody: 'NCFE', level: '5', description: 'x' };
    expect((await call({ method: 'PATCH', path: base, body }, 'admin')).status).toBe(200);
    expect(q.updateApprProgramme).toHaveBeenCalledWith(P, body, expect.anything());
    expect(q.updateApprQualification).toHaveBeenCalledWith(
      QID,
      { title: 'L5 Adult Care', awardingBody: 'NCFE', level: '5' },
      expect.anything()
    );
  });
  it('a programme with several qualifications, or a status-only change, leaves qualifications alone', async () => {
    vi.mocked(q.updateApprProgramme).mockResolvedValue(PROGRAMME as never);
    vi.mocked(q.listApprQualificationIds).mockResolvedValueOnce([QID, 'q-2']);
    expect((await call({ method: 'PATCH', path: base, body: { title: 'New' } }, 'admin')).status).toBe(200);
    expect((await call({ method: 'PATCH', path: base, body: { status: 'ARCHIVED' } }, 'admin')).status).toBe(200);
    expect(q.updateApprQualification).not.toHaveBeenCalled();
  });
  it('awarding body is saved on create', async () => {
    vi.mocked(q.insertApprProgrammeWithQualification).mockResolvedValueOnce({
      programme: PROGRAMME,
      qualification: { id: QID }
    } as never);
    const body = { title: 'L3 Adult Care', awardingBody: 'NCFE' };
    expect((await call({ method: 'POST', path: '/apprenticeship/programmes', body }, 'admin')).status).toBeLessThan(
      300
    );
    expect(q.insertApprProgrammeWithQualification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG, title: 'L3 Adult Care', awardingBody: 'NCFE' })
    );
  });
  it('settings validation: out-of-range values → 400', async () => {
    const res = await call(
      {
        method: 'PUT',
        path: '/apprenticeship/settings',
        body: { concernGapPct: 101, otjFactor: 0.2, otjWeeklyCapHours: 30 }
      },
      'admin'
    );
    expect(res.status).toBe(400);
  });
});
