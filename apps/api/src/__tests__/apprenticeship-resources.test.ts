import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// Gecko Apprenticeships — resources SERVICE rules (staff writes, learner status, notify, evidence workbook link).
// DB queries + S3 mocked; the services and rule modules are real.

vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  isProgrammeTutorOfLinked: vi.fn(async () => false),
  getLinkedEnrolment: vi.fn(async () => null),
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
  filterUploadKeysInOrg: vi.fn(async (_o: string, keys: string[]) => keys),
  insertApprUploads: vi.fn(async () => undefined),
  markUploadsAttached: vi.fn(async () => undefined),
  markUploadsRemoved: vi.fn(async () => undefined),
  lockApprEnrolment: vi.fn(async () => null),
  // resources
  getResource: vi.fn(),
  insertResource: vi.fn(async (v: unknown) => v),
  updateResource: vi.fn(async () => ({})),
  replaceResourceFile: vi.fn(async () => ({})),
  deleteResource: vi.fn(async () => ({})),
  setSuggestedCriteria: vi.fn(async () => undefined),
  nextResourceSort: vi.fn(async () => 3),
  countEvidenceForResource: vi.fn(async () => 0),
  countResourcesByScope: vi.fn(async () => ({ general: 1 })),
  listResourcesForProgrammes: vi.fn(async () => []),
  reorderResources: vi.fn(async () => undefined),
  listProgrammeUnits: vi.fn(async () => [{ unitId: '66666666-6666-4666-8666-666666666666' }]),
  listResourceActivityForLearner: vi.fn(async () => []),
  latestEvidenceByResource: vi.fn(async () => new Map()),
  recordResourceActivity: vi.fn(async () => ({})),
  listApprEnrolmentsByIds: vi.fn(async () => []),
  listEnrolmentIdsForProgramme: vi.fn(async () => [])
}));
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => false),
  isCourseTutorForLearner: vi.fn(async () => false),
  isCourseTutor: vi.fn(async () => false),
  getOrgMemberRoleId: vi.fn(async () => null)
}));
const redisSet = vi.hoisted(() => vi.fn(async () => 'OK' as string | null));
vi.mock('@cio/core/utils/redis/redis', () => ({ redis: { set: redisSet } }));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', () => ({ runInTransaction: (fn: (tx: unknown) => unknown) => fn({ tx: true }) }));
vi.mock('@api/services/apprenticeship/progress', () => ({
  todayIso: () => '2026-06-01',
  recomputeEnrolment: vi.fn(async () => null)
}));
vi.mock('@api/services/apprenticeship/notifications', () => ({
  notifyEvidenceSubmitted: vi.fn(async () => undefined),
  notifyEvidenceReviewed: vi.fn(async () => undefined),
  notifyGatewayReadyOrRelease: vi.fn(async () => undefined),
  notifyResourcesAdded: vi.fn(async () => undefined),
  notifySafely: async (_label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch {
      /* non-fatal */
    }
  }
}));
vi.mock('@api/services/apprenticeship/tasks', () => ({
  assertTaskForEvidence: vi.fn(async () => undefined),
  syncTaskStatuses: vi.fn(async () => undefined)
}));
vi.mock('@api/services/organization/users', () => ({ createOrgUser: vi.fn() }));
vi.mock('@api/services/organization/allocation', () => ({ createTutorAllocation: vi.fn() }));
vi.mock('@cio/core/config/storage', () => ({ getStorageConfig: () => ({ bucketDocuments: 'docs-bucket' }) }));
vi.mock('@cio/core/config/upload-limits', () => ({
  getUploadLimits: () => ({ documentBytes: 10_000_000, imageBytes: 10_000_000, videoBytes: 100_000_000 })
}));
vi.mock('@cio/core/utils/s3', () => ({
  generateDocumentUploadPresignedUrl: vi.fn(async () => 'https://upload.test/put'),
  generateDocumentDownloadPresignedUrls: vi.fn(async () => ({})),
  generateAttachmentPresignedUrl: vi.fn(async (key: string) => `https://dl.test/${key}`),
  getS3ObjectStream: vi.fn(async () => null)
}));

import * as q from '@cio/db/queries/apprenticeship';
import { recordAudit } from '@cio/db/audit';
import { generateAttachmentPresignedUrl, generateDocumentUploadPresignedUrl } from '@cio/core/utils/s3';
import { notifyResourcesAdded } from '@api/services/apprenticeship/notifications';
import {
  createResource,
  deleteResourceById,
  downloadResource,
  listResourcesForEnrolment,
  notifyProgrammeResources,
  presignResourceUpload,
  updateResourceById
} from '@api/services/apprenticeship/resources';
import { createEvidence, updateEvidence } from '@api/services/apprenticeship/evidence';

const ORG = 'org-1';
const PROG = '11111111-1111-4111-8111-111111111111';
const PROG_S = '12121212-1212-4212-8212-121212121212';
const OTHER_PROG = '13131313-1313-4313-8313-131313131313';
const RID = '99999999-9999-4999-8999-999999999999';
const UNIT = '66666666-6666-4666-8666-666666666666';
const CRIT = '55555555-5555-4555-8555-555555555555';
const LRN = '22222222-2222-4222-8222-222222222222';
const ENR = '33333333-3333-4333-8333-333333333333';
const ENR_S = '34343434-3434-4434-8434-343434343434';
const EV = '44444444-4444-4444-8444-444444444444';

const admin = { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG } as Actor;
const learner = { authenticated: true, userId: LRN, role: 'LEARNER', status: 'ACTIVE', orgId: ORG } as Actor;
const tutor = { authenticated: true, userId: 'u-tutor', role: 'TUTOR', status: 'ACTIVE', orgId: ORG } as Actor;

const KEY = `apprenticeship/resources/${PROG}/${RID}/abc-guide.pdf`;
function resource(over: Record<string, unknown> = {}) {
  return {
    id: RID,
    organizationId: ORG,
    programmeId: PROG,
    unitId: null,
    kind: 'WORKBOOK',
    title: 'Workbook 1',
    description: '',
    file: { key: KEY, name: 'guide.pdf', size: 100, type: 'application/pdf' },
    version: 1,
    sort: 0,
    status: 'ACTIVE',
    evidenceTypeKey: null,
    createdBy: 'u-admin',
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
  primaryEnrolmentId: null,
  gatewayPassedAt: null
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.getApprProgramme).mockImplementation((async (id: string) => ({
    id,
    organizationId: ORG,
    title: id === PROG ? 'Diploma' : 'Standard',
    type: id === PROG ? 'DIPLOMA' : 'STANDARD',
    status: 'ACTIVE'
  })) as never);
  vi.mocked(q.getApprEnrolment).mockResolvedValue(ENROLMENT as never);
  vi.mocked(q.getResource).mockResolvedValue(resource() as never);
  vi.mocked(q.getLinkedEnrolment).mockResolvedValue(null);
  vi.mocked(q.filterUploadKeysInOrg).mockImplementation((async (_o: string, keys: string[]) => keys) as never);
  vi.mocked(q.filterCriterionIdsInProgramme).mockImplementation((async (_p: string, ids: string[]) => ids) as never);
  vi.mocked(q.getApprEvidence).mockResolvedValue({
    id: EV,
    organizationId: ORG,
    programmeId: PROG,
    learnerId: LRN,
    status: 'SUBMITTED',
    files: [],
    resourceId: null
  } as never);
  vi.mocked(q.insertApprEvidence).mockResolvedValue({ id: EV } as never);
  vi.mocked(q.updateApprEvidence).mockResolvedValue({ id: EV } as never);
  vi.mocked(q.getApprEnrolmentByProgrammeLearner).mockResolvedValue(ENROLMENT as never);
});

describe('staff writes', () => {
  it('presign: validates the file type per kind (.doc is not learning; .xlsx is a workbook) and tracks the upload', async () => {
    await expect(
      presignResourceUpload(admin, {
        programmeId: PROG,
        kind: 'LEARNING',
        fileName: 'old.doc',
        contentType: 'application/msword',
        size: 10
      })
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('.docx') });
    await expect(
      presignResourceUpload(admin, {
        programmeId: PROG,
        kind: 'LEARNING',
        fileName: 'sheet.xlsx',
        contentType: 'x',
        size: 10
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    const out = await presignResourceUpload(admin, {
      programmeId: PROG,
      kind: 'WORKBOOK',
      fileName: 'sheet.xlsx',
      contentType: 'whatever',
      size: 10
    });
    expect(out.key.startsWith(`apprenticeship/resources/${PROG}/${out.resourceId}/`)).toBe(true);
    // MIME is derived from the extension, not trusted from the client.
    expect(generateDocumentUploadPresignedUrl).toHaveBeenCalledWith(
      out.key,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(q.insertApprUploads).toHaveBeenCalledWith([
      { organizationId: ORG, learnerId: null, ownerId: out.resourceId, key: out.key }
    ]);
  });

  it('presign rejects a file over the size limit and a replace of a resource in another programme', async () => {
    await expect(
      presignResourceUpload(admin, {
        programmeId: PROG,
        kind: 'WORKBOOK',
        fileName: 'a.pdf',
        contentType: 'application/pdf',
        size: 999_999_999
      })
    ).rejects.toMatchObject({ statusCode: 413 });
    vi.mocked(q.getResource).mockResolvedValue(resource({ programmeId: OTHER_PROG }) as never);
    await expect(
      presignResourceUpload(admin, {
        programmeId: PROG,
        resourceId: RID,
        kind: 'WORKBOOK',
        fileName: 'a.pdf',
        contentType: 'application/pdf',
        size: 10
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  const body = (over: Record<string, unknown> = {}) => ({
    id: RID,
    programmeId: PROG,
    unitId: null,
    kind: 'WORKBOOK' as const,
    title: 'Workbook 1',
    file: { key: KEY, name: 'guide.pdf', size: 100, type: 'application/pdf' },
    criterionIds: [] as string[],
    ...over
  });

  it('create: a key not under the resource prefix is refused (a client key is never trusted)', async () => {
    vi.mocked(q.getResource).mockResolvedValue(null as never);
    await expect(
      createResource(
        admin,
        body({
          file: { key: `apprenticeship/resources/${OTHER_PROG}/${RID}/x.pdf`, name: 'x.pdf', size: 1, type: 'a' }
        })
      )
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      createResource(
        admin,
        body({ file: { key: `apprenticeship/${PROG}/${LRN}/e/x.pdf`, name: 'x.pdf', size: 1, type: 'a' } })
      )
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(q.insertResource).not.toHaveBeenCalled();
  });

  it('create: a key with no presign row (appr_upload) is refused', async () => {
    vi.mocked(q.getResource).mockResolvedValue(null as never);
    vi.mocked(q.filterUploadKeysInOrg).mockResolvedValue([]);
    await expect(createResource(admin, body())).rejects.toMatchObject({ statusCode: 400 });
  });

  it('create: suggested criteria from another programme -> 400, nothing saved', async () => {
    vi.mocked(q.getResource).mockResolvedValue(null as never);
    vi.mocked(q.filterCriterionIdsInProgramme).mockResolvedValue([]);
    await expect(createResource(admin, body({ criterionIds: [CRIT] }))).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('criteria')
    });
    expect(q.insertResource).not.toHaveBeenCalled();
  });

  it('create: a unit outside the programme -> 400', async () => {
    vi.mocked(q.getResource).mockResolvedValue(null as never);
    await expect(createResource(admin, body({ unitId: '77777777-7777-4777-8777-777777777777' }))).rejects.toMatchObject(
      {
        statusCode: 400
      }
    );
  });

  it('create: saves with a server-derived MIME, attaches the upload, audits', async () => {
    vi.mocked(q.getResource)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValue(resource() as never);
    await createResource(admin, body({ unitId: UNIT, criterionIds: [CRIT] }));
    expect(vi.mocked(q.insertResource).mock.calls[0][0]).toMatchObject({
      id: RID,
      unitId: UNIT,
      sort: 3,
      file: { key: KEY, type: 'application/pdf' }
    });
    expect(q.setSuggestedCriteria).toHaveBeenCalledWith(RID, [CRIT], expect.anything());
    expect(q.markUploadsAttached).toHaveBeenCalledWith([KEY], expect.anything());
    expect(vi.mocked(recordAudit).mock.calls[0][0]).toMatchObject({ action: 'appr.resource.created' });
  });

  it('only an admin writes (tutor / learner -> 403)', async () => {
    await expect(createResource(tutor, body())).rejects.toMatchObject({ statusCode: 403 });
    await expect(updateResourceById(learner, RID, { title: 'x' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(deleteResourceById(tutor, RID)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('replace: version + 1 via replaceResourceFile, the new upload attached and the OLD one marked removed', async () => {
    const newKey = `apprenticeship/resources/${PROG}/${RID}/new-guide-v2.pdf`;
    await updateResourceById(admin, RID, { file: { key: newKey, name: 'guide-v2.pdf', size: 5, type: 'x' } });
    expect(q.replaceResourceFile).toHaveBeenCalledWith(
      RID,
      ORG,
      { key: newKey, name: 'guide-v2.pdf', size: 5, type: 'application/pdf' },
      expect.anything()
    );
    expect(q.markUploadsAttached).toHaveBeenCalledWith([newKey], expect.anything());
    expect(q.markUploadsRemoved).toHaveBeenCalledWith([KEY], expect.anything());
  });

  it('replace with a key from another resource prefix is refused', async () => {
    await expect(
      updateResourceById(admin, RID, {
        file: { key: `apprenticeship/resources/${PROG}/other-id/x.pdf`, name: 'x.pdf', size: 1, type: 'a' }
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(q.replaceResourceFile).not.toHaveBeenCalled();
  });

  it('changing a workbook (.xlsx) to learning is refused: the file is not allowed for that kind', async () => {
    vi.mocked(q.getResource).mockResolvedValue(
      resource({ file: { key: KEY, name: 'sheet.xlsx', size: 1, type: 'x' } }) as never
    );
    await expect(updateResourceById(admin, RID, { kind: 'LEARNING' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('workbook -> learning is 409 while evidence references it', async () => {
    vi.mocked(q.getResource).mockResolvedValue(resource({ kind: 'WORKBOOK' }) as never);
    vi.mocked(q.countEvidenceForResource).mockResolvedValueOnce(1);
    await expect(updateResourceById(admin, RID, { kind: 'LEARNING' })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('archive it')
    });
    expect(q.updateResource).not.toHaveBeenCalled();
  });

  it('delete: 409 when evidence references it (archive instead); otherwise removes the row and the file', async () => {
    vi.mocked(q.countEvidenceForResource).mockResolvedValueOnce(2);
    await expect(deleteResourceById(admin, RID)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Archive')
    });
    expect(q.deleteResource).not.toHaveBeenCalled();
    await deleteResourceById(admin, RID);
    expect(q.deleteResource).toHaveBeenCalled();
    expect(q.markUploadsRemoved).toHaveBeenCalledWith([KEY], expect.anything());
  });
});

describe('learner list: status, updated badge, withdrawn', () => {
  const self = learner;
  function twoHalves(withdrawnStandard = false) {
    const standard = {
      ...ENROLMENT,
      id: ENR_S,
      programmeId: PROG_S,
      primaryEnrolmentId: ENR,
      withdrawnAt: withdrawnStandard ? '2026-05-01' : null
    };
    vi.mocked(q.getLinkedEnrolment).mockResolvedValue(standard as never);
  }
  it('status ladder + updatedSinceDownload (lastVersion < version) + LEARNING is not downloadable', async () => {
    const book = resource({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 3 });
    const learning = resource({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'LEARNING' });
    const fresh = resource({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    vi.mocked(q.listResourcesForProgrammes).mockResolvedValue([book, learning, fresh] as never);
    vi.mocked(q.listResourceActivityForLearner).mockResolvedValue([
      {
        resourceId: book.id,
        enrolmentId: ENR,
        firstViewedAt: 'a',
        firstDownloadedAt: 'b',
        lastDownloadedAt: 'b',
        downloadCount: 1,
        lastVersion: 2
      },
      {
        resourceId: learning.id,
        enrolmentId: ENR,
        firstViewedAt: 'a',
        firstDownloadedAt: null,
        lastDownloadedAt: null,
        downloadCount: 0,
        lastVersion: 1
      }
    ] as never);
    const out = await listResourcesForEnrolment(self, ENR);
    const byId = Object.fromEntries(out.resources.map((r) => [r.id, r]));
    expect(byId[book.id]).toMatchObject({
      status: 'DOWNLOADED',
      updatedSinceDownload: true,
      downloadable: true,
      enrolmentId: ENR
    });
    expect(byId[learning.id]).toMatchObject({ status: 'VIEWED', updatedSinceDownload: false, downloadable: false });
    expect(byId[fresh.id]).toMatchObject({ status: 'NOT_STARTED', activity: null });
    // ACTIVE only for the list.
    expect(vi.mocked(q.listResourcesForProgrammes).mock.calls[0][0]).toMatchObject({ status: 'ACTIVE' });
  });

  it('evidence status wins: SUBMITTED / REFERRED / ACCEPTED with latestEvidenceId', async () => {
    const book = resource({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    vi.mocked(q.listResourcesForProgrammes).mockResolvedValue([book] as never);
    vi.mocked(q.latestEvidenceByResource).mockResolvedValue(new Map([[book.id, { id: EV, status: 'REFERRED' }]]));
    const out = await listResourcesForEnrolment(self, ENR);
    expect(out.resources[0]).toMatchObject({ status: 'REFERRED', latestEvidenceId: EV });
  });

  it('withdrawn half: hidden from the learner (programmes + resources), flagged for staff', async () => {
    twoHalves(true);
    vi.mocked(q.listResourcesForProgrammes).mockResolvedValue([] as never);
    const asLearner = await listResourcesForEnrolment(self, ENR);
    expect(asLearner.programmes.map((p) => p.programmeId)).toEqual([PROG]);
    expect(vi.mocked(q.listResourcesForProgrammes).mock.calls[0][0].programmeIds).toEqual([PROG]);
    vi.mocked(q.listResourcesForProgrammes).mockClear();
    const asAdmin = await listResourcesForEnrolment(admin, ENR);
    expect(asAdmin.programmes).toEqual([
      expect.objectContaining({ programmeId: PROG, withdrawn: false }),
      expect.objectContaining({ programmeId: PROG_S, withdrawn: true })
    ]);
    expect(vi.mocked(q.listResourcesForProgrammes).mock.calls[0][0].programmeIds).toEqual([PROG, PROG_S]);
  });

  it('a fully withdrawn lone enrolment: the learner sees nothing', async () => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue({ ...ENROLMENT, withdrawnAt: '2026-05-01' } as never);
    const out = await listResourcesForEnrolment(self, ENR);
    expect(out).toEqual({ programmes: [], resources: [] });
    expect(q.listResourcesForProgrammes).not.toHaveBeenCalled();
  });
});

describe('download', () => {
  it('learner + LEARNING -> 403 "This resource is view only" (no URL signed, nothing recorded)', async () => {
    vi.mocked(q.getResource).mockResolvedValue(resource({ kind: 'LEARNING' }) as never);
    await expect(downloadResource(learner, RID, ENR)).rejects.toMatchObject({
      statusCode: 403,
      message: 'This resource is view only'
    });
    expect(generateAttachmentPresignedUrl).not.toHaveBeenCalled();
    expect(q.recordResourceActivity).not.toHaveBeenCalled();
  });
  it('learner + WORKBOOK -> presigned attachment of the STORED key, download recorded with the current version', async () => {
    vi.mocked(q.getResource).mockResolvedValue(resource({ version: 4 }) as never);
    const out = await downloadResource(learner, RID, ENR);
    expect(out).toEqual({ url: `https://dl.test/${KEY}`, fileName: 'guide.pdf' });
    expect(generateAttachmentPresignedUrl).toHaveBeenCalledWith(KEY, 'docs-bucket', 'guide.pdf');
    expect(q.recordResourceActivity).toHaveBeenCalledWith({
      resourceId: RID,
      enrolmentId: ENR,
      learnerId: LRN,
      type: 'download',
      version: 4
    });
    expect(vi.mocked(recordAudit).mock.calls.some((c) => c[0].action === 'appr.resource.download')).toBe(true);
  });
  it('an admin may download a LEARNING resource (preview) and nothing is recorded as learner activity', async () => {
    vi.mocked(q.getResource).mockResolvedValue(resource({ kind: 'LEARNING' }) as never);
    await downloadResource(admin, RID);
    expect(q.recordResourceActivity).not.toHaveBeenCalled();
  });
});

describe('notify', () => {
  it('one notification per ACTIVE learner (withdrawn excluded, deduped); resources must belong to the programme', async () => {
    vi.mocked(q.listResourcesForProgrammes).mockResolvedValue([resource()] as never);
    vi.mocked(q.listEnrolmentIdsForProgramme).mockResolvedValue(['e1', 'e2', 'e3']);
    vi.mocked(q.listApprEnrolmentsByIds).mockResolvedValue([
      { id: 'e1', learnerId: 'l1', withdrawnAt: null },
      { id: 'e2', learnerId: 'l1', withdrawnAt: null },
      { id: 'e3', learnerId: 'l2', withdrawnAt: '2026-05-01' }
    ] as never);
    const out = await notifyProgrammeResources(admin, PROG, [RID, RID]);
    expect(out).toEqual({ notified: 1 });
    expect(notifyResourcesAdded).toHaveBeenCalledWith({ resourceId: RID, learnerIds: ['l1'] });
    await expect(notifyProgrammeResources(admin, PROG, ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])).rejects.toMatchObject(
      { statusCode: 400 }
    );
    await expect(notifyProgrammeResources(tutor, PROG, [RID])).rejects.toMatchObject({ statusCode: 403 });
  });

  it('a second notify for the same resource ids is a no-op (24h cooldown)', async () => {
    vi.mocked(q.listResourcesForProgrammes).mockResolvedValue([resource()] as never);
    vi.mocked(q.listEnrolmentIdsForProgramme).mockResolvedValue(['e1']);
    vi.mocked(q.listApprEnrolmentsByIds).mockResolvedValue([{ id: 'e1', learnerId: 'l1', withdrawnAt: null }] as never);
    vi.mocked(notifyResourcesAdded).mockClear();
    redisSet.mockResolvedValueOnce(null);
    expect(await notifyProgrammeResources(admin, PROG, [RID])).toEqual({ notified: 0 });
    expect(notifyResourcesAdded).not.toHaveBeenCalled();
  });
});

describe('evidence <-> workbook link', () => {
  const CREATE = {
    title: 'Completed',
    details: 'd',
    typeKey: 'assignment',
    minutes: 0,
    includeOtj: false,
    criterionIds: [CRIT],
    files: []
  };
  it('create: a WORKBOOK of the learner programme is accepted and persisted as resourceId', async () => {
    await createEvidence(learner, ENR, { ...CREATE, resourceId: RID } as never);
    expect(vi.mocked(q.insertApprEvidence).mock.calls[0][1]).toMatchObject({ resourceId: RID });
  });
  it('create: without a workbook the column is null', async () => {
    await createEvidence(learner, ENR, CREATE as never);
    expect(vi.mocked(q.insertApprEvidence).mock.calls[0][1]).toMatchObject({ resourceId: null });
  });
  it('create: LEARNING resource, foreign programme, other org and ARCHIVED are all 400', async () => {
    for (const r of [
      resource({ kind: 'LEARNING' }),
      resource({ programmeId: OTHER_PROG }),
      resource({ status: 'ARCHIVED' }),
      null
    ]) {
      vi.mocked(q.getResource).mockResolvedValue(r as never);
      await expect(createEvidence(learner, ENR, { ...CREATE, resourceId: RID } as never)).rejects.toMatchObject({
        statusCode: 400
      });
    }
    expect(q.insertApprEvidence).not.toHaveBeenCalled();
  });
  it('create: a workbook of the linked counterpart programme is accepted', async () => {
    vi.mocked(q.getLinkedEnrolment).mockResolvedValue({
      ...ENROLMENT,
      id: ENR_S,
      programmeId: PROG_S,
      primaryEnrolmentId: ENR
    } as never);
    vi.mocked(q.getResource).mockResolvedValue(resource({ programmeId: PROG_S }) as never);
    await createEvidence(learner, ENR, { ...CREATE, resourceId: RID } as never);
    expect(q.insertApprEvidence).toHaveBeenCalled();
  });
  it('create: a workbook of a WITHDRAWN half is refused for the learner', async () => {
    vi.mocked(q.getLinkedEnrolment).mockResolvedValue({
      ...ENROLMENT,
      id: ENR_S,
      programmeId: PROG_S,
      primaryEnrolmentId: ENR,
      withdrawnAt: '2026-05-01'
    } as never);
    vi.mocked(q.getResource).mockResolvedValue(resource({ programmeId: PROG_S }) as never);
    await expect(createEvidence(learner, ENR, { ...CREATE, resourceId: RID } as never)).rejects.toMatchObject({
      statusCode: 400
    });
  });
  it('edit: an archived workbook may be kept/linked (archived ok on edit); a LEARNING one is still 400', async () => {
    vi.mocked(q.getResource).mockResolvedValue(resource({ status: 'ARCHIVED' }) as never);
    await updateEvidence(learner, EV, { resourceId: RID } as never);
    expect(vi.mocked(q.updateApprEvidence).mock.calls[0][2]).toMatchObject({ resourceId: RID });
    vi.mocked(q.getResource).mockResolvedValue(resource({ kind: 'LEARNING' }) as never);
    await expect(updateEvidence(learner, EV, { resourceId: RID } as never)).rejects.toMatchObject({ statusCode: 400 });
  });
  it('edit: unlinking (null) needs no resource lookup', async () => {
    await updateEvidence(learner, EV, { resourceId: null } as never);
    expect(vi.mocked(q.updateApprEvidence).mock.calls[0][2]).toMatchObject({ resourceId: null });
    expect(q.getResource).not.toHaveBeenCalled();
  });
});
