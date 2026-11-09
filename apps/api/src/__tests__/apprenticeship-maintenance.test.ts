import { beforeEach, describe, expect, it, vi } from 'vitest';

// Gecko Apprenticeships round 2 — the daily maintenance jobs (upload clean-up, overdue-task scan, review-due scan).
// Proves: the clean-up selects with the 24 h grace, deletes tracking rows ONLY after the storage delete succeeded and
// never touches a key a live record still lists; the scans claim before notifying so a rerun notifies nobody twice.

vi.mock('@cio/db/queries/apprenticeship', () => ({
  listUploadsForCleanup: vi.fn(),
  listReferencedUploadKeys: vi.fn(async () => new Set<string>()),
  markUploadsAttached: vi.fn(async () => undefined),
  deleteUploadRows: vi.fn(async (ids: string[]) => ids.length),
  claimOverdueTasks: vi.fn(),
  claimDueReviews: vi.fn(),
  getEnrolmentLearnerIds: vi.fn(async () => new Map()),
  listEnrolmentsNeedingFirstReview: vi.fn(async () => []),
  insertFirstReviewIfNone: vi.fn(async () => true)
}));
vi.mock('@cio/db/queries/allocation', () => ({ listTutorsForLearner: vi.fn(async () => []) }));
vi.mock('@cio/db/queries/comms', () => ({ insertNotification: vi.fn(async () => ({ id: 'n' })) }));
vi.mock('@cio/core/utils/s3', () => ({ deleteFromS3: vi.fn(async () => ({ success: true })) }));
vi.mock('@cio/core/config/storage', () => ({ getStorageConfig: () => ({ bucketDocuments: 'docs-bucket' }) }));

import * as q from '@cio/db/queries/apprenticeship';
import { listTutorsForLearner } from '@cio/db/queries/allocation';
import { insertNotification } from '@cio/db/queries/comms';
import { deleteFromS3 } from '@cio/core/utils/s3';
import {
  ensureFirstReview,
  runApprReviewDueScan,
  runApprTaskOverdueScan,
  runApprUploadCleanup
} from '@cio/core/services/apprenticeship/maintenance';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const row = (id: string, key = `apprenticeship/p/l/e/${id}.pdf`) => ({ id, key });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.listReferencedUploadKeys).mockResolvedValue(new Set());
  vi.mocked(deleteFromS3).mockResolvedValue({ success: true });
  vi.mocked(q.deleteUploadRows).mockImplementation((async (ids: string[]) => ids.length) as never);
});

describe('runApprUploadCleanup', () => {
  it('selects with a 24 h cutoff, deletes from the documents bucket, then removes the rows', async () => {
    vi.mocked(q.listUploadsForCleanup).mockResolvedValueOnce([row('a'), row('b')] as never);
    const res = await runApprUploadCleanup({ now: NOW });
    expect(vi.mocked(q.listUploadsForCleanup).mock.calls[0][0]).toBe('2026-06-09T12:00:00.000Z');
    expect(vi.mocked(q.listUploadsForCleanup).mock.calls[0][1]).toBe(200);
    expect(deleteFromS3).toHaveBeenCalledWith({ Bucket: 'docs-bucket', Key: 'apprenticeship/p/l/e/a.pdf' });
    expect(q.deleteUploadRows).toHaveBeenCalledWith(['a', 'b']);
    expect(res).toEqual({ selected: 2, deleted: 2, keptReferenced: 0, failed: 0 });
  });

  it('deletes a row ONLY after its storage delete succeeded; failures stay for the next run and are not retried in-run', async () => {
    vi.mocked(q.listUploadsForCleanup)
      .mockResolvedValueOnce([row('ok1'), row('bad'), row('ok2')] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(deleteFromS3).mockImplementation((async ({ Key }: { Key: string }) =>
      Key.includes('bad') ? { success: false, error: 'boom' } : { success: true }) as never);
    const res = await runApprUploadCleanup({ now: NOW, batchSize: 3 });
    expect(q.deleteUploadRows).toHaveBeenCalledWith(['ok1', 'ok2']);
    expect(res).toMatchObject({ deleted: 2, failed: 1 });
    // the next batch query excludes the failed row so one poisoned object cannot starve the rest
    expect(vi.mocked(q.listUploadsForCleanup).mock.calls[1][2]).toEqual(['bad']);
  });

  it('never deletes a key a live record still lists (re-marks it attached instead)', async () => {
    vi.mocked(q.listUploadsForCleanup).mockResolvedValueOnce([row('shared'), row('orphan')] as never);
    vi.mocked(q.listReferencedUploadKeys).mockResolvedValue(new Set([row('shared').key]));
    const res = await runApprUploadCleanup({ now: NOW });
    expect(deleteFromS3).toHaveBeenCalledTimes(1);
    expect(deleteFromS3).toHaveBeenCalledWith({ Bucket: 'docs-bucket', Key: row('orphan').key });
    expect(q.markUploadsAttached).toHaveBeenCalledWith([row('shared').key]);
    expect(q.deleteUploadRows).toHaveBeenCalledWith(['orphan']);
    expect(res).toMatchObject({ deleted: 1, keptReferenced: 1 });
  });

  it('is idempotent and batched: nothing due → no storage calls; a full batch continues until a short one', async () => {
    vi.mocked(q.listUploadsForCleanup).mockResolvedValueOnce([] as never);
    expect(await runApprUploadCleanup({ now: NOW })).toEqual({ selected: 0, deleted: 0, keptReferenced: 0, failed: 0 });
    expect(deleteFromS3).not.toHaveBeenCalled();

    vi.mocked(q.listUploadsForCleanup)
      .mockResolvedValueOnce([row('1'), row('2')] as never)
      .mockResolvedValueOnce([row('3')] as never);
    const res = await runApprUploadCleanup({ now: NOW, batchSize: 2 });
    expect(res.deleted).toBe(3);
    expect(q.listUploadsForCleanup).toHaveBeenCalledTimes(3); // [] earlier + 2 batches
  });
});

describe('runApprTaskOverdueScan', () => {
  it('tells the apprentice and each allocated tutor once per claimed task, and nothing when nothing is claimed', async () => {
    vi.mocked(q.claimOverdueTasks).mockResolvedValueOnce([{ id: 't1', learnerId: 'lrn', title: 'T' }] as never);
    vi.mocked(listTutorsForLearner).mockResolvedValue([
      { tutorId: 'tut1', email: null },
      { tutorId: 'tut2', email: null },
      { tutorId: 'tut1', email: null }
    ] as never);
    const res = await runApprTaskOverdueScan({ today: '2026-06-10' });
    expect(res).toEqual({ tasks: 1, notifications: 3 });
    const recipients = vi
      .mocked(insertNotification)
      .mock.calls.map((c) => c[0].userId)
      .sort();
    expect(recipients).toEqual(['lrn', 'tut1', 'tut2']);
    expect(vi.mocked(insertNotification).mock.calls[0][0]).toMatchObject({
      type: 'appr.task.overdue',
      entityType: 'appr_task',
      entityId: 't1'
    });

    // second run: the claim (overdue_notified_at) returns nothing → nobody is notified again
    vi.mocked(insertNotification).mockClear();
    vi.mocked(q.claimOverdueTasks).mockResolvedValueOnce([] as never);
    expect(await runApprTaskOverdueScan({ today: '2026-06-10' })).toEqual({ tasks: 0, notifications: 0 });
    expect(insertNotification).not.toHaveBeenCalled();
  });

  it('a failing notification never aborts the scan', async () => {
    vi.mocked(q.claimOverdueTasks).mockResolvedValueOnce([
      { id: 't1', learnerId: 'a', title: 'T' },
      { id: 't2', learnerId: 'b', title: 'T' }
    ] as never);
    vi.mocked(listTutorsForLearner).mockResolvedValue([] as never);
    vi.mocked(insertNotification).mockRejectedValueOnce(new Error('db blip'));
    const res = await runApprTaskOverdueScan({ today: '2026-06-10' });
    expect(res).toEqual({ tasks: 2, notifications: 1 });
  });
});

describe('runApprReviewDueScan', () => {
  it('claims reviews due within the 7-day notice window and tells the learner’s allocated tutors once', async () => {
    vi.mocked(q.claimDueReviews).mockResolvedValueOnce([{ id: 'r1', enrolmentId: 'enr' }] as never);
    vi.mocked(q.getEnrolmentLearnerIds).mockResolvedValue(new Map([['enr', 'lrn']]));
    vi.mocked(listTutorsForLearner).mockResolvedValue([{ tutorId: 'tut1', email: null }] as never);
    const res = await runApprReviewDueScan({ today: '2026-06-10' });
    expect(vi.mocked(q.claimDueReviews).mock.calls[0][0]).toBe('2026-06-17');
    expect(res).toEqual({ reviews: 1, notifications: 1, firstReviewsCreated: 0 });
    expect(vi.mocked(insertNotification).mock.calls[0][0]).toMatchObject({
      userId: 'tut1',
      type: 'appr.review.due',
      entityType: 'appr_review',
      entityId: 'r1'
    });

    vi.mocked(insertNotification).mockClear();
    vi.mocked(q.claimDueReviews).mockResolvedValueOnce([] as never);
    expect(await runApprReviewDueScan({ today: '2026-06-10' })).toEqual({
      reviews: 0,
      notifications: 0,
      firstReviewsCreated: 0
    });
    expect(insertNotification).not.toHaveBeenCalled();
  });
});

describe('first-review back-fill (ensureFirstReview + the daily scan)', () => {
  const enr = { id: 'enr', organizationId: 'o', startDate: '2026-01-05', achievedAt: null };

  it('schedules start + interval when that is still ahead, else today + 7 days', async () => {
    await ensureFirstReview(enr, 12, { today: '2026-02-01' });
    expect(vi.mocked(q.insertFirstReviewIfNone).mock.calls[0][0]).toMatchObject({ scheduledDate: '2026-03-30' });
    await ensureFirstReview(enr, 12, { today: '2026-06-01' });
    expect(vi.mocked(q.insertFirstReviewIfNone).mock.calls[1][0]).toMatchObject({ scheduledDate: '2026-06-08' });
  });

  it('does nothing without a start date or for an achieved learner', async () => {
    expect(await ensureFirstReview({ ...enr, startDate: null }, 12)).toBe(false);
    expect(await ensureFirstReview({ ...enr, achievedAt: '2026-05-01' }, 12)).toBe(false);
    expect(q.insertFirstReviewIfNone).not.toHaveBeenCalled();
  });

  it('is idempotent: the insert is "only if no review exists", so a re-run reports nothing created', async () => {
    vi.mocked(q.listEnrolmentsNeedingFirstReview).mockResolvedValueOnce([
      { id: 'e1', organizationId: 'o', startDate: '2026-01-05', reviewIntervalWeeks: 12 }
    ] as never);
    vi.mocked(q.claimDueReviews).mockResolvedValue([] as never);
    expect((await runApprReviewDueScan({ today: '2026-06-01' })).firstReviewsCreated).toBe(1);
    vi.mocked(q.listEnrolmentsNeedingFirstReview).mockResolvedValueOnce([
      { id: 'e1', organizationId: 'o', startDate: '2026-01-05', reviewIntervalWeeks: 12 }
    ] as never);
    vi.mocked(q.insertFirstReviewIfNone).mockResolvedValueOnce(false);
    expect((await runApprReviewDueScan({ today: '2026-06-01' })).firstReviewsCreated).toBe(0);
  });
});
