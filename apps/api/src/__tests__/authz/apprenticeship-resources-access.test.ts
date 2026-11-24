import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { Readable } from 'node:stream';
import type { Actor } from '@cio/db/actor';
import type { AuthSession } from '@api/types/auth';

// Gecko Apprenticeships — resources API access matrix. Real router + real service, DB/S3 mocked.
// Proves: anon 401, manager 403; admin-only writes; learner sees ACTIVE resources of their own non-withdrawn halves only
// (withdrawn half / archived / other learner / other org = 404); LEARNING is view-only (download 403) but streams inline with
// private/no-store/nosniff; the S3 key always comes from the stored resource (never the client).

vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  isProgrammeTutorOfLinked: vi.fn(async () => false),
  getLinkedEnrolment: vi.fn(async () => null),
  getApprEnrolment: vi.fn(),
  getApprEnrolmentByProgrammeLearner: vi.fn(async () => null),
  getApprProgramme: vi.fn(),
  getResource: vi.fn(),
  insertResource: vi.fn(),
  listResourcesForProgrammes: vi.fn(async () => []),
  countEvidenceForResource: vi.fn(async () => 0),
  countResourcesByScope: vi.fn(async () => ({})),
  listResourceActivityForLearner: vi.fn(async () => []),
  latestEvidenceByResource: vi.fn(async () => new Map()),
  recordResourceActivity: vi.fn(async () => ({})),
  updateResource: vi.fn(async () => ({})),
  deleteResource: vi.fn(),
  markUploadsRemoved: vi.fn(async () => undefined),
  filterUploadKeysInOrg: vi.fn(async (_o: string, keys: string[]) => keys),
  insertApprUploads: vi.fn(async () => undefined),
  listProgrammeUnits: vi.fn(async () => [])
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
  notifyResourcesAdded: vi.fn(async () => undefined),
  notifySafely: async (_l: string, fn: () => Promise<void>) => fn().catch(() => undefined)
}));
vi.mock('@cio/core/config/storage', () => ({ getStorageConfig: () => ({ bucketDocuments: 'docs-bucket' }) }));
vi.mock('@cio/core/config/upload-limits', () => ({
  getUploadLimits: () => ({ documentBytes: 10_000_000, imageBytes: 10_000_000, videoBytes: 100_000_000 })
}));
vi.mock('@cio/core/utils/s3', () => ({
  generateDocumentUploadPresignedUrl: vi.fn(async () => 'https://upload.test/put'),
  generateDocumentDownloadPresignedUrls: vi.fn(async () => ({})),
  generateAttachmentPresignedUrl: vi.fn(async (key: string) => `https://dl.test/${key}`),
  getS3ObjectStream: vi.fn()
}));

import * as q from '@cio/db/queries/apprenticeship';
import { isTutorAllocatedToLearner } from '@cio/db/queries/allocation';
import { generateAttachmentPresignedUrl, getS3ObjectStream } from '@cio/core/utils/s3';
import { apprenticeshipRouter } from '@api/routes/apprenticeship';

const ORG = 'org-1';
const PROG = '11111111-1111-4111-8111-111111111111';
const PROG_S = '12121212-1212-4212-8212-121212121212';
const LRN = '22222222-2222-4222-8222-222222222222';
const ENR = '33333333-3333-4333-8333-333333333333';
const ENR_S = '34343434-3434-4434-8434-343434343434';
const RID = '99999999-9999-4999-8999-999999999999';
const KEY = `apprenticeship/resources/${PROG}/${RID}/abc-guide.pdf`;

const ACTORS: Record<string, Actor> = {
  anon: { authenticated: false, reason: 'anonymous' },
  learner: { authenticated: true, userId: LRN, role: 'LEARNER', status: 'ACTIVE', orgId: ORG },
  otherLearner: {
    authenticated: true,
    userId: '77777777-7777-4777-8777-777777777777',
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

function call(method: string, path: string, as: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'x-test-actor': as, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function resource(over: Record<string, unknown> = {}) {
  return {
    id: RID,
    organizationId: ORG,
    programmeId: PROG,
    unitId: null,
    kind: 'LEARNING',
    title: 'Guide',
    description: '',
    file: { key: KEY, name: 'guide.pdf', size: 100, type: 'application/pdf' },
    version: 1,
    sort: 0,
    status: 'ACTIVE',
    evidenceTypeKey: null,
    createdBy: null,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    unitTitle: null,
    unitCode: null,
    programmeTitle: 'Diploma',
    criterionIds: [],
    ...over
  };
}
const ENROLMENT = {
  id: ENR,
  organizationId: ORG,
  programmeId: PROG,
  learnerId: LRN,
  withdrawnAt: null,
  primaryEnrolmentId: null
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.getApprProgramme).mockImplementation((async (id: string) => ({
    id,
    organizationId: ORG,
    title: 'P',
    type: id === PROG ? 'DIPLOMA' : 'STANDARD',
    status: 'ACTIVE'
  })) as never);
  vi.mocked(q.getApprEnrolment).mockResolvedValue(ENROLMENT as never);
  vi.mocked(q.getApprEnrolmentByProgrammeLearner).mockResolvedValue(ENROLMENT as never);
  vi.mocked(q.getLinkedEnrolment).mockResolvedValue(null);
  vi.mocked(q.isProgrammeTutor).mockResolvedValue(false);
  vi.mocked(q.getResource).mockImplementation((async (id: string, org: string) =>
    id === RID && org === ORG ? resource() : null) as never);
  vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(false);
  vi.mocked(getS3ObjectStream).mockImplementation((async () => ({
    body: Readable.from([Buffer.from('%PDF-1.4 hello')]),
    contentType: 'application/octet-stream',
    contentLength: 14
  })) as never);
});

describe('route guards', () => {
  const routes: [string, string][] = [
    ['GET', `/apprenticeship/resources/${RID}/content`],
    ['POST', `/apprenticeship/resources/${RID}/download`],
    ['GET', `/apprenticeship/resources/enrolment/${ENR}`],
    ['GET', `/apprenticeship/resources/programme/${PROG}`]
  ];
  it.each(routes)('%s %s: anon 401, manager 403 (no query runs)', async (m, p) => {
    expect((await call(m, p, 'anon')).status).toBe(401);
    expect((await call(m, p, 'manager')).status).toBe(403);
    expect(q.getResource).not.toHaveBeenCalled();
  });

  const writes: [string, string, unknown?][] = [
    [
      'POST',
      '/apprenticeship/resources/presign',
      { programmeId: PROG, kind: 'LEARNING', fileName: 'a.pdf', contentType: 'a', size: 1 }
    ],
    ['PATCH', `/apprenticeship/resources/${RID}`, { title: 'x' }],
    ['DELETE', `/apprenticeship/resources/${RID}`],
    ['POST', `/apprenticeship/resources/${RID}/archive`],
    ['POST', `/apprenticeship/resources/${RID}/restore`],
    ['POST', `/apprenticeship/resources/programme/${PROG}/reorder`, { ids: [RID] }],
    ['POST', `/apprenticeship/resources/programme/${PROG}/notify`, { resourceIds: [RID] }]
  ];
  it.each(writes)('%s %s is admin only (tutor/learner 403)', async (m, p, b) => {
    expect((await call(m, p, 'tutor', b)).status).toBe(403);
    expect((await call(m, p, 'learner', b)).status).toBe(403);
    expect(q.updateResource).not.toHaveBeenCalled();
    expect(q.deleteResource).not.toHaveBeenCalled();
  });
  it('an admin of another org gets 404 on a resource id', async () => {
    expect((await call('PATCH', `/apprenticeship/resources/${RID}`, 'otherAdmin', { title: 'x' })).status).toBe(404);
    expect((await call('GET', `/apprenticeship/resources/${RID}/content`, 'otherAdmin')).status).toBe(404);
  });
});

describe('content (inline stream)', () => {
  it('learner streams a LEARNING resource inline with private/no-store/nosniff; the key is the stored one', async () => {
    const res = await call(
      'GET',
      `/apprenticeship/resources/${RID}/content?enrolmentId=${ENR}&key=evil/other.pdf`,
      'learner'
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    expect(await res.text()).toContain('%PDF');
    expect(getS3ObjectStream).toHaveBeenCalledWith(KEY, 'docs-bucket');
    expect(q.recordResourceActivity).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: RID, enrolmentId: ENR, learnerId: LRN, type: 'view' })
    );
  });
  it('a docx is served with its canonical MIME whatever S3 reports', async () => {
    vi.mocked(q.getResource).mockResolvedValue(
      resource({ file: { key: KEY, name: 'brief.docx', size: 5, type: 'x' } }) as never
    );
    const res = await call('GET', `/apprenticeship/resources/${RID}/content`, 'learner');
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
  });
  it('a learner without a programme enrolment, another learner and an archived resource are 404', async () => {
    vi.mocked(q.getApprEnrolmentByProgrammeLearner).mockResolvedValue(null as never);
    expect((await call('GET', `/apprenticeship/resources/${RID}/content`, 'learner')).status).toBe(404);
    vi.mocked(q.getApprEnrolmentByProgrammeLearner).mockResolvedValue(ENROLMENT as never);
    // another learner passing someone else's enrolment id
    expect(
      (await call('GET', `/apprenticeship/resources/${RID}/content?enrolmentId=${ENR}`, 'otherLearner')).status
    ).toBe(404);
    vi.mocked(q.getResource).mockResolvedValue(resource({ status: 'ARCHIVED' }) as never);
    expect((await call('GET', `/apprenticeship/resources/${RID}/content?enrolmentId=${ENR}`, 'learner')).status).toBe(
      404
    );
    expect(getS3ObjectStream).not.toHaveBeenCalled();
  });
  it('archived stays viewable for an admin (preview)', async () => {
    vi.mocked(q.getResource).mockResolvedValue(resource({ status: 'ARCHIVED' }) as never);
    expect((await call('GET', `/apprenticeship/resources/${RID}/content`, 'admin')).status).toBe(200);
    expect(q.recordResourceActivity).not.toHaveBeenCalled();
  });
  it('withdrawn half: the learner gets 404 for that half resources, but the active half still works', async () => {
    const standard = {
      ...ENROLMENT,
      id: ENR_S,
      programmeId: PROG_S,
      primaryEnrolmentId: ENR,
      withdrawnAt: '2026-05-01'
    };
    vi.mocked(q.getLinkedEnrolment).mockResolvedValue(standard as never);
    // resource on the withdrawn Standard
    vi.mocked(q.getResource).mockResolvedValue(resource({ programmeId: PROG_S }) as never);
    expect((await call('GET', `/apprenticeship/resources/${RID}/content?enrolmentId=${ENR}`, 'learner')).status).toBe(
      404
    );
    expect(
      (await call('POST', `/apprenticeship/resources/${RID}/download`, 'learner', { enrolmentId: ENR })).status
    ).toBe(404);
    // staff still preview it
    expect((await call('GET', `/apprenticeship/resources/${RID}/content?enrolmentId=${ENR}`, 'admin')).status).toBe(
      200
    );
    // resource on the active Diploma half
    vi.mocked(q.getResource).mockResolvedValue(resource() as never);
    expect((await call('GET', `/apprenticeship/resources/${RID}/content?enrolmentId=${ENR}`, 'learner')).status).toBe(
      200
    );
  });
  it('tutor: 404 without reach; 200 as programme tutor; 200 with an allocated learner enrolment', async () => {
    expect((await call('GET', `/apprenticeship/resources/${RID}/content`, 'tutor')).status).toBe(404);
    vi.mocked(q.isProgrammeTutor).mockResolvedValue(true);
    expect((await call('GET', `/apprenticeship/resources/${RID}/content`, 'tutor')).status).toBe(200);
    vi.mocked(q.isProgrammeTutor).mockResolvedValue(false);
    expect((await call('GET', `/apprenticeship/resources/${RID}/content?enrolmentId=${ENR}`, 'tutor')).status).toBe(
      404
    );
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(true);
    expect((await call('GET', `/apprenticeship/resources/${RID}/content?enrolmentId=${ENR}`, 'tutor')).status).toBe(
      200
    );
  });
});

describe('download', () => {
  it('learner + LEARNING -> 403 view only; learner + WORKBOOK -> 200 signed from the stored key', async () => {
    const denied = await call('POST', `/apprenticeship/resources/${RID}/download`, 'learner', { enrolmentId: ENR });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain('view only');
    expect(generateAttachmentPresignedUrl).not.toHaveBeenCalled();

    vi.mocked(q.getResource).mockResolvedValue(resource({ kind: 'WORKBOOK' }) as never);
    const ok = await call('POST', `/apprenticeship/resources/${RID}/download`, 'learner', { enrolmentId: ENR });
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toEqual({ url: `https://dl.test/${KEY}`, fileName: 'guide.pdf' });
  });
  it('an empty body is accepted (learner resolves their own enrolment)', async () => {
    vi.mocked(q.getResource).mockResolvedValue(resource({ kind: 'WORKBOOK' }) as never);
    const res = await app.request(`/apprenticeship/resources/${RID}/download`, {
      method: 'POST',
      headers: { 'x-test-actor': 'learner' }
    });
    expect(res.status).toBe(200);
  });
  it('staff (admin) may download a LEARNING resource', async () => {
    expect((await call('POST', `/apprenticeship/resources/${RID}/download`, 'admin', {})).status).toBe(200);
  });
});

describe('enrolment list + programme list', () => {
  it('the learner lists their own enrolment; another learner gets 404', async () => {
    expect((await call('GET', `/apprenticeship/resources/enrolment/${ENR}`, 'learner')).status).toBe(200);
    expect((await call('GET', `/apprenticeship/resources/enrolment/${ENR}`, 'otherLearner')).status).toBe(404);
    expect((await call('GET', `/apprenticeship/resources/enrolment/${ENR}`, 'otherAdmin')).status).toBe(404);
  });
  it('programme list: admin ok (ACTIVE+ARCHIVED by default), another org 404, learner 403', async () => {
    expect((await call('GET', `/apprenticeship/resources/programme/${PROG}?status=ALL`, 'admin')).status).toBe(200);
    expect(vi.mocked(q.listResourcesForProgrammes).mock.calls[0][0].status).toBeUndefined();
    expect((await call('GET', `/apprenticeship/resources/programme/${PROG}`, 'learner')).status).toBe(403);
    expect((await call('GET', `/apprenticeship/resources/programme/${PROG}`, 'otherAdmin')).status).toBe(404);
  });
});
