import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Actor } from '@cio/db/actor';
import type { AuthSession } from '@api/types/auth';

// Gecko Standard Deploy 1 — programme type + diploma→Standard pairing rules (real router + service, DB mocked).

vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  isProgrammeTutorOfLinked: vi.fn(async () => false),
  countOpenLinkedPairs: vi.fn(async () => 0),
  getApprProgramme: vi.fn(),
  getApprProgrammeStructure: vi.fn(async () => ({ qualifications: [], units: [], criteria: [] })),
  listApprProgrammesWithCounts: vi.fn(async () => []),
  listDiplomasPairedTo: vi.fn(async () => []),
  listActiveStandards: vi.fn(async () => []),
  listApprQualificationIds: vi.fn(async () => []),
  insertApprProgrammeWithQualification: vi.fn(),
  updateApprProgramme: vi.fn(),
  updateApprQualification: vi.fn()
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', () => ({ runInTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@api/services/apprenticeship/progress', () => ({ recomputeEnrolment: vi.fn(async () => null) }));
vi.mock('@api/services/organization/users', () => ({ createOrgUser: vi.fn() }));
vi.mock('@api/services/organization/allocation', () => ({ createTutorAllocation: vi.fn() }));

import * as q from '@cio/db/queries/apprenticeship';
import { apprenticeshipRouter } from '@api/routes/apprenticeship';

const ORG = 'org-1';
const ACTORS: Record<string, Actor> = {
  tutor: { authenticated: true, userId: 'u-tutor', role: 'TUTOR', status: 'ACTIVE', orgId: ORG },
  admin: { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG }
};
const app = new Hono<AuthSession>()
  .use('*', async (c, next) => {
    c.set('actor', ACTORS[c.req.header('x-test-actor') ?? 'admin']);
    await next();
  })
  .route('/apprenticeship', apprenticeshipRouter as unknown as Hono);

const DIP = '11111111-1111-4111-8111-111111111111';
const STD = '22222222-2222-4222-8222-222222222222';
const base = '/apprenticeship/programmes';

const diploma = {
  id: DIP,
  organizationId: ORG,
  title: 'L3 Diploma',
  level: 'Level 3',
  status: 'ACTIVE',
  type: 'DIPLOMA',
  pairedProgrammeId: null
};
const standard = {
  id: STD,
  organizationId: ORG,
  title: 'L3 Standard',
  level: '3',
  status: 'ACTIVE',
  type: 'STANDARD',
  pairedProgrammeId: null
};

function req(method: string, path: string, body?: unknown, actor = 'admin') {
  return app.request(path, {
    method,
    headers: { 'x-test-actor': actor, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}
function lookup(...rows: Record<string, unknown>[]) {
  vi.mocked(q.getApprProgramme).mockImplementation(
    (async (id: string) => rows.find((r) => r.id === id) ?? null) as never
  );
}
const pairedDiploma = [{ id: DIP, title: 'L3 Diploma', level: '3', status: 'ACTIVE' }] as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.updateApprProgramme).mockResolvedValue(diploma as never);
  vi.mocked(q.insertApprProgrammeWithQualification).mockResolvedValue({
    programme: diploma,
    qualification: { id: 'q1' }
  } as never);
  lookup(diploma, standard);
});

describe('list', () => {
  it('passes status + type and adds levelNumber', async () => {
    vi.mocked(q.listApprProgrammesWithCounts).mockResolvedValueOnce([{ id: DIP, level: 'Level 4' }] as never);
    const res = await req('GET', `${base}?status=ALL&type=STANDARD`, undefined, 'tutor');
    expect(res.status).toBe(200);
    expect(q.listApprProgrammesWithCounts).toHaveBeenCalledWith(ORG, 'ALL', 'STANDARD');
    expect((await res.json()).data[0].levelNumber).toBe(4);
  });
});

describe('create', () => {
  it('pairs a diploma to a same-level active Standard', async () => {
    const res = await req('POST', base, { title: 'D', level: '3', type: 'DIPLOMA', pairedProgrammeId: STD });
    expect(res.status).toBe(201);
    expect(q.insertApprProgrammeWithQualification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'DIPLOMA', pairedProgrammeId: STD })
    );
  });
  it('rejects a level mismatch with 400', async () => {
    expect((await req('POST', base, { title: 'D', level: '4', pairedProgrammeId: STD })).status).toBe(400);
    expect(q.insertApprProgrammeWithQualification).not.toHaveBeenCalled();
  });
  it('a Standard cannot set pairedProgrammeId', async () => {
    const body = { title: 'S', level: '3', type: 'STANDARD', pairedProgrammeId: STD };
    expect((await req('POST', base, body)).status).toBe(400);
  });
  it('a Standard from another org → 400', async () => {
    lookup(diploma, { ...standard, organizationId: 'org-2' });
    expect((await req('POST', base, { title: 'D', level: '3', pairedProgrammeId: STD })).status).toBe(400);
  });
});

describe('patch', () => {
  it('sets and clears pairedProgrammeId on a diploma', async () => {
    expect((await req('PATCH', `${base}/${DIP}`, { pairedProgrammeId: STD })).status).toBe(200);
    expect(q.updateApprProgramme).toHaveBeenCalledWith(DIP, { pairedProgrammeId: STD }, expect.anything());
    lookup({ ...diploma, pairedProgrammeId: STD }, standard);
    expect((await req('PATCH', `${base}/${DIP}`, { pairedProgrammeId: null })).status).toBe(200);
  });
  it('a Standard cannot be given a pair', async () => {
    expect((await req('PATCH', `${base}/${STD}`, { pairedProgrammeId: DIP })).status).toBe(400);
  });
  it('a level change that breaks the pair → 400 (diploma side)', async () => {
    lookup({ ...diploma, pairedProgrammeId: STD }, standard);
    expect((await req('PATCH', `${base}/${DIP}`, { level: '4' })).status).toBe(400);
    expect(q.updateApprProgramme).not.toHaveBeenCalled();
  });
  it('a level change that keeps the number is fine', async () => {
    lookup({ ...diploma, pairedProgrammeId: STD }, standard);
    expect((await req('PATCH', `${base}/${DIP}`, { level: 'L3' })).status).toBe(200);
  });
  it('a level change that breaks the pair → 400 (Standard side)', async () => {
    vi.mocked(q.listDiplomasPairedTo).mockResolvedValueOnce(pairedDiploma);
    expect((await req('PATCH', `${base}/${STD}`, { level: '5' })).status).toBe(400);
  });
  it('archiving a Standard that diplomas point at → 409 listing them', async () => {
    vi.mocked(q.listDiplomasPairedTo).mockResolvedValueOnce(pairedDiploma);
    const res = await req('PATCH', `${base}/${STD}`, { status: 'ARCHIVED' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('L3 Diploma');
  });
  it('archiving an unpaired Standard is fine', async () => {
    expect((await req('PATCH', `${base}/${STD}`, { status: 'ARCHIVED' })).status).toBe(200);
  });
});

describe('pair-candidates', () => {
  it('diploma: active Standards of the same level number only', async () => {
    vi.mocked(q.listActiveStandards).mockResolvedValueOnce([
      { id: STD, title: 'S3', level: 'Level 3', reference: null },
      { id: 'x', title: 'S4', level: '4', reference: null }
    ] as never);
    const res = await req('GET', `${base}/${DIP}/pair-candidates`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.map((s: { id: string }) => s.id)).toEqual([STD]);
    expect(q.listActiveStandards).toHaveBeenCalledWith(ORG);
  });
  it('standard → []', async () => {
    const res = await req('GET', `${base}/${STD}/pair-candidates`);
    expect((await res.json()).data).toEqual([]);
  });
  it('tutor → 403', async () => {
    expect((await req('GET', `${base}/${DIP}/pair-candidates`, undefined, 'tutor')).status).toBe(403);
  });
});

describe('tree', () => {
  it('gains pairing fields and counts', async () => {
    lookup({ ...diploma, pairedProgrammeId: STD }, standard);
    const data = (await (await req('GET', `${base}/${DIP}`)).json()).data;
    expect(data).toMatchObject({
      levelNumber: 3,
      pairedProgramme: { id: STD, title: 'L3 Standard', level: '3' },
      pairedDiplomas: [],
      unitCount: 0,
      criterionCount: 0
    });
  });
});
