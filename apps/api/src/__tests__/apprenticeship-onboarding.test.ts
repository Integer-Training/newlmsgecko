import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// Gecko Apprenticeships — onboarding documents: access matrix (admin / learner self / tutor status-only / strangers),
// first-read seeding, the key-injection guard, review races and the once-only "complete" alert.

const tx = { tx: true, execute: vi.fn(async () => undefined) };

vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  getApprEnrolment: vi.fn(),
  countOnboardingTypes: vi.fn(async () => 3),
  insertOnboardingTypes: vi.fn(async (rows: unknown[]) => rows.map((r, i) => ({ id: `new-${i}`, ...(r as object) }))),
  listOnboardingTypes: vi.fn(async () => []),
  listOnboardingDocs: vi.fn(async () => []),
  getOnboardingType: vi.fn(),
  getOnboardingDoc: vi.fn(async () => null),
  upsertOnboardingDoc: vi.fn(async (row: Record<string, unknown>) => ({ id: 'doc-1', status: 'SUBMITTED', ...row })),
  reviewOnboardingDoc: vi.fn(),
  deleteOnboardingDoc: vi.fn(async () => undefined),
  deleteOnboardingType: vi.fn(async () => undefined),
  updateOnboardingType: vi.fn(async () => ({ id: 'type-1' })),
  reorderOnboardingTypes: vi.fn(async () => undefined),
  isOnboardingTypeInUse: vi.fn(async () => false),
  listOnboardingFileKeysForEnrolments: vi.fn(async () => ['k1']),
  filterProgrammeIdsInOrg: vi.fn(async (_o: string, ids: string[]) => ids),
  filterUploadKeysInOrg: vi.fn(async (_o: string, keys: string[]) => keys),
  insertApprUploads: vi.fn(async () => undefined),
  markUploadsAttached: vi.fn(async () => undefined),
  markUploadsRemoved: vi.fn(async () => undefined),
  lockApprEnrolment: vi.fn(async () => ({})),
  listOrgAdminIds: vi.fn(async () => ['u-admin', 'u-admin2'])
}));
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => false),
  isCourseTutorForLearner: vi.fn(async () => false),
  isCourseTutor: vi.fn(async () => false),
  listTutorsForLearnerInOrg: vi.fn(async () => [{ tutorId: 'u-tutor', email: null }])
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', () => ({
  runInTransaction: (fn: (t: unknown) => unknown) => fn(tx),
  sql: (strings: TemplateStringsArray) => strings.join('?')
}));
vi.mock('@api/services/comms/notify', () => ({ emitNotification: vi.fn(async () => undefined) }));
vi.mock('@api/services/apprenticeship/checks', () => ({ assertAllowedFile: vi.fn() }));
vi.mock('@cio/core/utils/s3', () => ({
  generateDocumentUploadPresignedUrl: vi.fn(async (key: string) => `https://s3/put/${key}`),
  generateDocumentDownloadPresignedUrls: vi.fn(async (keys: string[]) => keys.map((k) => `https://s3/get/${k}`))
}));

import * as q from '@cio/db/queries/apprenticeship';
import { isTutorAllocatedToLearner } from '@cio/db/queries/allocation';
import { recordAudit } from '@cio/db/audit';
import { emitNotification } from '@api/services/comms/notify';
import {
  createOnboardingType,
  deleteOnboardingTypeAdmin,
  getOnboarding,
  listOnboardingTypesAdmin,
  markOnboardingFilesRemovedForEnrolments,
  presignOnboardingUploads,
  reorderOnboardingTypesAdmin,
  reviewOnboardingDocument,
  saveOnboardingDoc,
  signOnboardingDownloads,
  withdrawOnboardingDoc
} from '@api/services/apprenticeship/onboarding';
import { AppError } from '@api/utils/errors';
import { ZOnboardingDocReview, ZOnboardingDocSave } from '@cio/utils/validation/apprenticeship';
import { APPR_DEFAULT_ONBOARDING_DOC_TYPES, APPR_ONBOARDING_TYPES_MAX } from '@cio/utils/constants/apprenticeship';

const ORG = 'org-1';
const PROG_A = '11111111-1111-4111-8111-111111111111';
const PROG_B = '11111111-1111-4111-8111-222222222222';
const LRN = '22222222-2222-4222-8222-222222222222';
const OTHER = '22222222-2222-4222-8222-999999999999';
const ENR = '33333333-3333-4333-8333-333333333333';
const T1 = '44444444-4444-4444-8444-000000000001';
const T2 = '44444444-4444-4444-8444-000000000002';
const T3 = '44444444-4444-4444-8444-000000000003';

const admin = { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG } as Actor;
const tutor = { authenticated: true, userId: 'u-tutor', role: 'TUTOR', status: 'ACTIVE', orgId: ORG } as Actor;
const self = { authenticated: true, userId: LRN, role: 'LEARNER', status: 'ACTIVE', orgId: ORG } as Actor;
const other = { ...self, userId: OTHER } as Actor;
const otherOrgAdmin = { ...admin, orgId: 'org-2' } as Actor;

const enrolment = { id: ENR, organizationId: ORG, programmeId: PROG_A, learnerId: LRN };
const prefix = (docTypeId: string) => `apprenticeship/${PROG_A}/${LRN}/onboarding/${ENR}/${docTypeId}/`;

const type = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  organizationId: ORG,
  programmeId: null,
  label: `Doc ${id.slice(-1)}`,
  description: null,
  required: true,
  allowNotHeld: false,
  sequence: 0,
  active: true,
  ...o
});
const doc = (docTypeId: string, o: Record<string, unknown> = {}) => ({
  id: `doc-${docTypeId.slice(-1)}`,
  enrolmentId: ENR,
  docTypeId,
  status: 'SUBMITTED',
  notHeld: false,
  learnerNote: null,
  reviewNote: null,
  reviewedAt: null,
  submittedAt: '2026-11-01T00:00:00Z',
  files: [{ key: `${prefix(docTypeId)}a.pdf`, name: 'a.pdf', size: 10, type: 'application/pdf' }],
  ...o
});
const row = (d: ReturnType<typeof doc>) => ({ doc: d, reviewedByName: null, submittedByName: 'Lee' });

async function status(p: Promise<unknown>) {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof AppError ? e.statusCode : 500;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment as never);
  vi.mocked(q.isProgrammeTutor).mockResolvedValue(false);
  vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(false);
  vi.mocked(q.countOnboardingTypes).mockResolvedValue(3);
  vi.mocked(q.listOnboardingTypes).mockResolvedValue([type(T1)] as never);
  vi.mocked(q.listOnboardingDocs).mockResolvedValue([]);
  vi.mocked(q.getOnboardingType).mockResolvedValue(type(T1) as never);
  vi.mocked(q.getOnboardingDoc).mockResolvedValue(null);
  vi.mocked(q.filterUploadKeysInOrg).mockImplementation(async (_o, keys) => keys);
  vi.mocked(q.isOnboardingTypeInUse).mockResolvedValue(false);
});

describe('GET access matrix', () => {
  it('admin and learner self see files; a reaching tutor sees status only', async () => {
    vi.mocked(q.listOnboardingDocs).mockResolvedValue([row(doc(T1))] as never);
    const a = await getOnboarding(admin, ENR);
    expect(a.canSeeFiles).toBe(true);
    expect(a.items[0]!.doc!.files).toHaveLength(1);
    expect((await getOnboarding(self, ENR)).canSeeFiles).toBe(true);

    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(true);
    const t = await getOnboarding(tutor, ENR);
    expect(t.canSeeFiles).toBe(false);
    expect(t.items[0]!.doc!.files).toEqual([]);
    expect(t.items[0]!.doc!.fileCount).toBe(1);
  });

  it('a tutor with no reach, another learner and another org all get 404', async () => {
    expect(await status(getOnboarding(tutor, ENR))).toBe(404);
    expect(await status(getOnboarding(other, ENR))).toBe(404);
    expect(await status(getOnboarding(otherOrgAdmin, ENR))).toBe(404);
  });
});

describe('tutor reach is status-only: every other action is 404', () => {
  beforeEach(() => {
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(true);
  });

  it('presign / save / withdraw / review / download', async () => {
    const file = { key: `${prefix(T1)}a.pdf`, name: 'a.pdf' };
    const presign = { docTypeId: T1, files: [{ name: 'a.pdf', type: 'application/pdf' }] };
    expect(await status(presignOnboardingUploads(tutor, ENR, presign))).toBe(404);
    expect(await status(saveOnboardingDoc(tutor, ENR, T1, { files: [file], notHeld: false }))).toBe(404);
    expect(await status(withdrawOnboardingDoc(tutor, ENR, T1))).toBe(404);
    const review = { decision: 'APPROVE' as const, expectedStatus: 'SUBMITTED' as const };
    expect(await status(reviewOnboardingDocument(tutor, ENR, T1, review))).toBe(404);
    expect(await status(signOnboardingDownloads(tutor, ENR, T1, ['k']))).toBe(404);
  });
});

describe('seeding', () => {
  it('seeds the defaults once under an advisory lock when the org has no types', async () => {
    vi.mocked(q.countOnboardingTypes).mockResolvedValue(0);
    await getOnboarding(admin, ENR);
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(q.insertOnboardingTypes).toHaveBeenCalledTimes(1);
    const rows = vi.mocked(q.insertOnboardingTypes).mock.calls[0]![0] as { sequence: number }[];
    expect(rows).toHaveLength(APPR_DEFAULT_ONBOARDING_DOC_TYPES.length);
    expect(rows.map((r) => r.sequence)).toEqual(rows.map((_, i) => i));
  });

  it('a concurrent first read that loses the race (count > 0 under the lock) inserts nothing', async () => {
    vi.mocked(q.countOnboardingTypes).mockResolvedValueOnce(0).mockResolvedValue(9);
    await getOnboarding(admin, ENR);
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(q.insertOnboardingTypes).not.toHaveBeenCalled();
  });

  it('does not take the lock when types already exist', async () => {
    await getOnboarding(admin, ENR);
    expect(tx.execute).not.toHaveBeenCalled();
  });
});

describe('complete computation', () => {
  it('counts only active required applicable types; an approved notHeld doc counts', async () => {
    vi.mocked(q.listOnboardingTypes).mockResolvedValue([
      type(T1),
      type(T2, { allowNotHeld: true }),
      type(T3, { required: false })
    ] as never);
    vi.mocked(q.listOnboardingDocs).mockResolvedValue([
      row(doc(T1, { status: 'APPROVED' })),
      row(doc(T2, { status: 'APPROVED', notHeld: true, files: [] }))
    ] as never);
    const v = await getOnboarding(admin, ENR);
    expect(v.counts).toEqual({ required: 2, approved: 2, submitted: 0, rejected: 0 });
    expect(v.complete).toBe(true);
  });

  it('an inactive type with a doc is listed (active=false) but never counts', async () => {
    vi.mocked(q.listOnboardingTypes).mockResolvedValue([type(T1), type(T2, { active: false })] as never);
    vi.mocked(q.listOnboardingDocs).mockResolvedValue([
      row(doc(T1, { status: 'APPROVED' })),
      row(doc(T2, { status: 'REJECTED' }))
    ] as never);
    const v = await getOnboarding(admin, ENR);
    expect(v.counts).toEqual({ required: 1, approved: 1, submitted: 0, rejected: 0 });
    expect(v.complete).toBe(true);
    expect(v.items.find((i) => i.type.id === T2)!.type.active).toBe(false);
  });

  it('an inactive type without a doc is hidden', async () => {
    vi.mocked(q.listOnboardingTypes).mockResolvedValue([type(T1), type(T2, { active: false })] as never);
    expect((await getOnboarding(admin, ENR)).items.map((i) => i.type.id)).toEqual([T1]);
  });

  it('programme-scoped types apply to their own programme only', async () => {
    vi.mocked(q.listOnboardingTypes).mockResolvedValue([
      type(T1),
      type(T2, { programmeId: PROG_A }),
      type(T3, { programmeId: PROG_B })
    ] as never);
    const v = await getOnboarding(admin, ENR);
    expect(v.items.map((i) => i.type.id)).toEqual([T1, T2]);
    expect(v.counts.required).toBe(2);
    expect(v.complete).toBe(false);
  });
});

describe('save', () => {
  const good = { key: `${prefix(T1)}new.pdf`, name: 'new.pdf', type: 'application/pdf' };

  it('learner saves: upserts, attaches new keys, drops old ones, alerts admins, audits', async () => {
    const old = `${prefix(T1)}old.pdf`;
    vi.mocked(q.getOnboardingDoc).mockResolvedValue(
      doc(T1, { status: 'REJECTED', files: [{ key: old, name: 'old.pdf' }] }) as never
    );
    await saveOnboardingDoc(self, ENR, T1, { files: [good], notHeld: false });
    expect(q.upsertOnboardingDoc).toHaveBeenCalledWith(
      expect.objectContaining({ submittedBy: LRN, notHeld: false }),
      tx
    );
    expect(q.markUploadsAttached).toHaveBeenCalledWith([good.key], tx);
    expect(q.markUploadsRemoved).toHaveBeenCalledWith([old], tx);
    expect(emitNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'appr.onboarding.submitted' }));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'appr.onboarding.submit' }));
  });

  it('an admin saving on behalf does not alert admins', async () => {
    await saveOnboardingDoc(admin, ENR, T1, { files: [good], notHeld: false });
    expect(emitNotification).not.toHaveBeenCalled();
  });

  it('another learner and other-org admins get 404', async () => {
    expect(await status(saveOnboardingDoc(other, ENR, T1, { files: [good], notHeld: false }))).toBe(404);
    expect(await status(saveOnboardingDoc(otherOrgAdmin, ENR, T1, { files: [good], notHeld: false }))).toBe(404);
  });

  it('notHeld only when the type allows it', async () => {
    expect(await status(saveOnboardingDoc(self, ENR, T1, { files: [], notHeld: true }))).toBe(400);
    vi.mocked(q.getOnboardingType).mockResolvedValue(type(T1, { allowNotHeld: true }) as never);
    expect(await status(saveOnboardingDoc(self, ENR, T1, { files: [], notHeld: true }))).toBe(200);
  });

  it('rejects a key under a foreign prefix (another learner / slot)', async () => {
    const foreign = { ...good, key: `apprenticeship/${PROG_A}/${OTHER}/onboarding/${ENR}/${T1}/x.pdf` };
    expect(await status(saveOnboardingDoc(self, ENR, T1, { files: [foreign], notHeld: false }))).toBe(400);
    const otherSlot = { ...good, key: `${prefix(T2)}x.pdf` };
    expect(await status(saveOnboardingDoc(self, ENR, T1, { files: [otherSlot], notHeld: false }))).toBe(400);
    expect(q.upsertOnboardingDoc).not.toHaveBeenCalled();
  });

  it('rejects a well-prefixed key that was never issued to this learner', async () => {
    vi.mocked(q.filterUploadKeysInOrg).mockResolvedValue([]);
    expect(await status(saveOnboardingDoc(self, ENR, T1, { files: [good], notHeld: false }))).toBe(400);
    expect(q.filterUploadKeysInOrg).toHaveBeenCalledWith(ORG, [good.key], { learnerId: LRN, notRemoved: true });
    expect(q.upsertOnboardingDoc).not.toHaveBeenCalled();
  });

  it('a learner cannot change an APPROVED doc (409); an admin can', async () => {
    vi.mocked(q.getOnboardingDoc).mockResolvedValue(doc(T1, { status: 'APPROVED' }) as never);
    expect(await status(saveOnboardingDoc(self, ENR, T1, { files: [good], notHeld: false }))).toBe(409);
    const presign = { docTypeId: T1, files: [{ name: 'a.pdf', type: 'application/pdf' }] };
    expect(await status(presignOnboardingUploads(self, ENR, presign))).toBe(409);
    expect(await status(withdrawOnboardingDoc(self, ENR, T1))).toBe(409);
    expect(await status(saveOnboardingDoc(admin, ENR, T1, { files: [good], notHeld: false }))).toBe(200);
  });

  it('inactive or non-applicable types cannot be written', async () => {
    vi.mocked(q.getOnboardingType).mockResolvedValue(type(T1, { active: false }) as never);
    expect(await status(saveOnboardingDoc(self, ENR, T1, { files: [good], notHeld: false }))).toBe(400);
    vi.mocked(q.getOnboardingType).mockResolvedValue(type(T1, { programmeId: PROG_B }) as never);
    expect(await status(saveOnboardingDoc(self, ENR, T1, { files: [good], notHeld: false }))).toBe(404);
  });

  it('validation needs a file unless notHeld', () => {
    expect(ZOnboardingDocSave.safeParse({ files: [], notHeld: false }).success).toBe(false);
    expect(ZOnboardingDocSave.safeParse({ files: [], notHeld: true }).success).toBe(true);
  });
});

describe('presign / download / withdraw', () => {
  it('presign issues keys under the slot prefix and tracks them', async () => {
    const r = await presignOnboardingUploads(self, ENR, {
      docTypeId: T1,
      files: [{ name: 'a.pdf', type: 'application/pdf' }]
    });
    expect(r.files[0]!.key.startsWith(prefix(T1))).toBe(true);
    expect(q.insertApprUploads).toHaveBeenCalledWith([expect.objectContaining({ learnerId: LRN, ownerId: LRN })]);
  });

  it('download: owner/admin only, keys must be on that doc, audit carries no file names', async () => {
    const d = doc(T1);
    vi.mocked(q.getOnboardingDoc).mockResolvedValue(d as never);
    const key = d.files[0]!.key;
    expect(await signOnboardingDownloads(self, ENR, T1, [key])).toHaveLength(1);
    expect(await status(signOnboardingDownloads(self, ENR, T1, ['apprenticeship/other.pdf']))).toBe(403);
    expect(await status(signOnboardingDownloads(other, ENR, T1, [key]))).toBe(404);
    const meta = JSON.stringify(vi.mocked(recordAudit).mock.calls[0]![0]);
    expect(meta).not.toContain('a.pdf');
  });

  it('learner withdraws a rejected doc: keys marked removed, row deleted', async () => {
    vi.mocked(q.getOnboardingDoc).mockResolvedValue(doc(T1, { status: 'REJECTED' }) as never);
    await withdrawOnboardingDoc(self, ENR, T1);
    expect(q.markUploadsRemoved).toHaveBeenCalled();
    expect(q.deleteOnboardingDoc).toHaveBeenCalledWith('doc-1', tx);
  });
});

describe('review', () => {
  const approve = { decision: 'APPROVE' as const, expectedStatus: 'SUBMITTED' as const };

  beforeEach(() => {
    vi.mocked(q.getOnboardingDoc).mockResolvedValue(doc(T1) as never);
    vi.mocked(q.reviewOnboardingDoc).mockResolvedValue({ id: 'doc-1', status: 'APPROVED' } as never);
  });

  it('is admin only: learner 403, stranger 404', async () => {
    expect(await status(reviewOnboardingDocument(self, ENR, T1, approve))).toBe(403);
    expect(await status(reviewOnboardingDocument(other, ENR, T1, approve))).toBe(404);
    expect(await status(reviewOnboardingDocument(otherOrgAdmin, ENR, T1, approve))).toBe(404);
  });

  it('a stale expectedStatus is a 409', async () => {
    vi.mocked(q.reviewOnboardingDoc).mockResolvedValue(null);
    expect(await status(reviewOnboardingDocument(admin, ENR, T1, approve))).toBe(409);
    expect(emitNotification).not.toHaveBeenCalled();
  });

  it('rejecting requires a note', () => {
    expect(ZOnboardingDocReview.safeParse({ decision: 'REJECT', expectedStatus: 'SUBMITTED' }).success).toBe(false);
    expect(
      ZOnboardingDocReview.safeParse({ decision: 'REJECT', note: 'Blurry', expectedStatus: 'SUBMITTED' }).success
    ).toBe(true);
  });

  it('notifies the learner; "complete" fires only on the incomplete to complete transition', async () => {
    // before: T1 submitted (incomplete); after: approved (complete)
    vi.mocked(q.listOnboardingDocs)
      .mockResolvedValueOnce([row(doc(T1))] as never)
      .mockResolvedValueOnce([row(doc(T1, { status: 'APPROVED' }))] as never);
    const r = await reviewOnboardingDocument(admin, ENR, T1, approve);
    expect(r.becameComplete).toBe(true);
    const types = vi.mocked(emitNotification).mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['appr.onboarding.reviewed', 'appr.onboarding.complete']);
    const complete = vi.mocked(emitNotification).mock.calls[1]![0];
    expect(complete.recipients.map((x) => x.userId).sort()).toEqual(['u-admin', 'u-admin2', 'u-tutor']);
    expect(q.lockApprEnrolment).toHaveBeenCalledWith(tx, ENR);
  });

  it('re-approving an already complete enrolment does not fire "complete" again', async () => {
    vi.mocked(q.listOnboardingDocs).mockResolvedValue([row(doc(T1, { status: 'APPROVED' }))] as never);
    const r = await reviewOnboardingDocument(admin, ENR, T1, { decision: 'APPROVE', expectedStatus: 'APPROVED' });
    expect(r.becameComplete).toBe(false);
    expect(vi.mocked(emitNotification).mock.calls.map((c) => c[0].type)).toEqual(['appr.onboarding.reviewed']);
  });

  it('a rejection never fires "complete"', async () => {
    vi.mocked(q.reviewOnboardingDoc).mockResolvedValue({ id: 'doc-1', status: 'REJECTED' } as never);
    vi.mocked(q.listOnboardingDocs).mockResolvedValue([row(doc(T1, { status: 'REJECTED' }))] as never);
    await reviewOnboardingDocument(admin, ENR, T1, { decision: 'REJECT', note: 'Blurry', expectedStatus: 'SUBMITTED' });
    expect(vi.mocked(emitNotification).mock.calls.map((c) => c[0].type)).toEqual(['appr.onboarding.reviewed']);
  });
});

describe('types admin', () => {
  const input = { label: 'X', required: true, allowNotHeld: false, active: true } as never;

  it('is admin only', async () => {
    expect(await status(listOnboardingTypesAdmin(self))).toBe(403);
    expect(await status(listOnboardingTypesAdmin(tutor))).toBe(403);
    expect(await status(createOnboardingType(tutor, input))).toBe(403);
  });

  it('delete of an in-use type is a 409; unused deletes', async () => {
    vi.mocked(q.getOnboardingType).mockResolvedValue(type(T1) as never);
    vi.mocked(q.isOnboardingTypeInUse).mockResolvedValue(true);
    expect(await status(deleteOnboardingTypeAdmin(admin, T1))).toBe(409);
    expect(q.deleteOnboardingType).not.toHaveBeenCalled();
    vi.mocked(q.isOnboardingTypeInUse).mockResolvedValue(false);
    expect(await status(deleteOnboardingTypeAdmin(admin, T1))).toBe(200);
  });

  it('create is capped per org and the programme must be the org one', async () => {
    vi.mocked(q.countOnboardingTypes).mockResolvedValue(APPR_ONBOARDING_TYPES_MAX);
    expect(await status(createOnboardingType(admin, input))).toBe(400);
    vi.mocked(q.countOnboardingTypes).mockResolvedValue(3);
    vi.mocked(q.filterProgrammeIdsInOrg).mockResolvedValueOnce([]);
    expect(await status(createOnboardingType(admin, { ...(input as object), programmeId: PROG_B } as never))).toBe(400);
    expect(await status(createOnboardingType(admin, input))).toBe(200);
  });

  it('reorder rejects ids that are not the org ones', async () => {
    vi.mocked(q.listOnboardingTypes).mockResolvedValue([type(T1), type(T2)] as never);
    expect(await status(reorderOnboardingTypesAdmin(admin, [T2, T3]))).toBe(400);
    expect(await status(reorderOnboardingTypesAdmin(admin, [T2, T1]))).toBe(200);
    expect(q.reorderOnboardingTypes).toHaveBeenCalledWith(ORG, [T2, T1], tx);
  });
});

describe('enrolment deletion hook', () => {
  it('marks every onboarding file key removed', async () => {
    await markOnboardingFilesRemovedForEnrolments([ENR], tx as never);
    expect(q.markUploadsRemoved).toHaveBeenCalledWith(['k1'], tx);
  });
});
