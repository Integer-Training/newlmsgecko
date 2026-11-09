import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// Gecko Apprenticeships round 2 — progress review lifecycle: scheduling, edit rules, the lock once anyone has signed,
// who may sign as whom, completion (snapshot + next review), and optimistic-concurrency 409s. DB queries mocked.

vi.mock('@cio/db/queries/apprenticeship', () => ({
  getApprEnrolment: vi.fn(),
  getApprProgramme: vi.fn(),
  getApprReview: vi.fn(),
  insertApprReview: vi.fn(),
  listReviewsForEnrolment: vi.fn(async () => []),
  updateApprReviewIfUnchanged: vi.fn(),
  countOpenReviewsFrom: vi.fn(async () => 0),
  insertFirstReviewIfNone: vi.fn(async () => true)
}));
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => true),
  isCourseTutorForLearner: vi.fn(async () => false),
  isCourseTutor: vi.fn(async () => false),
  getOrgMemberRoleId: vi.fn(async () => null)
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', () => ({ runInTransaction: (fn: (tx: unknown) => unknown) => fn({ tx: true }) }));
vi.mock('@api/services/apprenticeship/progress', () => ({
  todayIso: (now: Date = new Date()) => now.toISOString().slice(0, 10),
  buildEnrolmentProgress: vi.fn(async () => ({
    actualPct: 40,
    expectedPct: 50,
    status: 'BEHIND',
    otjTargetMinutes: 1000,
    otjExpectedMinutes: 500,
    otjMinutes: 300,
    otjStatus: 'BEHIND',
    units: [{ status: 'COMPLETE' }, { status: 'ON_TARGET' }, { status: 'COMPLETE' }],
    totals: { submitted: 1, accepted: 4, referred: 0, otjMinutes: 300 }
  }))
}));
vi.mock('@api/services/apprenticeship/enrolment', () => ({
  toProgressSummary: (d: { actualPct: number; expectedPct: number; status: string }) => ({
    actualPct: d.actualPct,
    expectedPct: d.expectedPct,
    status: d.status
  })
}));
vi.mock('@api/services/apprenticeship/notifications', () => ({
  notifyReviewReadyToSign: vi.fn(async () => undefined),
  notifySafely: async (_label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch {
      /* non-fatal */
    }
  }
}));

import * as q from '@cio/db/queries/apprenticeship';
import { isTutorAllocatedToLearner } from '@cio/db/queries/allocation';
import { notifyReviewReadyToSign } from '@api/services/apprenticeship/notifications';
import {
  cancelReview,
  createReview,
  listReviews,
  signReview,
  updateReview
} from '@api/services/apprenticeship/reviews';

const ORG = 'org-1';
const PROG = '11111111-1111-4111-8111-111111111111';
const LRN = '22222222-2222-4222-8222-222222222222';
const LRN2 = '23232323-2323-4232-8232-232323232323';
const ENR = '33333333-3333-4333-8333-333333333333';
const REV = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const admin = { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG } as Actor;
const tutor = { authenticated: true, userId: 'u-tutor', role: 'TUTOR', status: 'ACTIVE', orgId: ORG } as Actor;
const self = { authenticated: true, userId: LRN, role: 'LEARNER', status: 'ACTIVE', orgId: ORG } as Actor;
const otherLearner = { authenticated: true, userId: LRN2, role: 'LEARNER', status: 'ACTIVE', orgId: ORG } as Actor;
const otherOrgAdmin = { authenticated: true, userId: 'u-a2', role: 'ADMIN', status: 'ACTIVE', orgId: 'org-2' } as Actor;

const UPDATED = '2026-05-01T10:00:00.000Z';
const review = (over: Record<string, unknown> = {}) => ({
  id: REV,
  organizationId: ORG,
  enrolmentId: ENR,
  scheduledDate: '2026-06-01',
  heldDate: null,
  status: 'SCHEDULED',
  targets: [],
  tutorSignedAt: null,
  learnerSignedAt: null,
  employerSignedAt: null,
  learnerComment: null,
  updatedAt: UPDATED,
  ...over
});
const NOW = new Date('2026-06-10T09:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.getApprEnrolment).mockResolvedValue({
    id: ENR,
    organizationId: ORG,
    programmeId: PROG,
    learnerId: LRN,
    startDate: '2026-01-01'
  } as never);
  vi.mocked(q.getApprProgramme).mockResolvedValue({ id: PROG, reviewIntervalWeeks: 12 } as never);
  givenReview(review());
  vi.mocked(q.insertApprReview).mockImplementation((async (_tx: unknown, v: object) => ({
    id: 'new-rev',
    ...v
  })) as never);
});

/** The "database" holds this row; the conditional UPDATE ... RETURNING echoes the patch onto it. */
function givenReview(row: Record<string, unknown>) {
  vi.mocked(q.getApprReview).mockResolvedValue(row as never);
  vi.mocked(q.updateApprReviewIfUnchanged).mockImplementation((async (
    _tx: unknown,
    _id: string,
    _expected: string,
    patch: object
  ) => ({ ...row, ...patch })) as never);
}

describe('scheduling + reading', () => {
  it('staff schedule a review for an accessible learner; a learner cannot; a tutor needs the allocation', async () => {
    await expect(createReview(admin, ENR, { scheduledDate: '2026-07-01' })).resolves.toBeTruthy();
    expect(q.insertApprReview).toHaveBeenCalledWith(
      { tx: true },
      expect.objectContaining({ enrolmentId: ENR, scheduledDate: '2026-07-01', organizationId: ORG })
    );
    await expect(createReview(self, ENR, { scheduledDate: '2026-07-01' })).rejects.toMatchObject({ statusCode: 403 });
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValueOnce(false);
    await expect(createReview(tutor, ENR, { scheduledDate: '2026-07-01' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('the list flags overdue reviews on read (never stored) and shows who has signed', async () => {
    vi.mocked(q.listReviewsForEnrolment).mockResolvedValue([
      review({ scheduledDate: '2026-06-01', status: 'DRAFT', tutorSignedAt: null }),
      review({ id: 'r2', scheduledDate: '2026-05-01', status: 'COMPLETE', tutorSignedAt: UPDATED })
    ] as never);
    const res = await listReviews(self, ENR, NOW);
    expect(res.items.map((r) => r.overdue)).toEqual([true, false]);
    expect(res.items[1].locked).toBe(true);
    expect(res.counts).toEqual({ total: 2, overdue: 1 });
    await expect(listReviews(otherLearner, ENR, NOW)).rejects.toMatchObject({ statusCode: 404 });
    await expect(listReviews(otherOrgAdmin, ENR, NOW)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('lazy first review on read', () => {
  it('staff viewing an enrolment ensure its first review (idempotent insert); a learner never triggers it', async () => {
    await listReviews(admin, ENR, NOW);
    expect(q.insertFirstReviewIfNone).toHaveBeenCalledWith(
      expect.objectContaining({ enrolmentId: ENR, organizationId: ORG, scheduledDate: '2026-06-17' })
    );
    await listReviews(tutor, ENR, NOW);
    expect(q.insertFirstReviewIfNone).toHaveBeenCalledTimes(2);
    vi.mocked(q.insertFirstReviewIfNone).mockClear();
    await listReviews(self, ENR, NOW);
    expect(q.insertFirstReviewIfNone).not.toHaveBeenCalled();
  });

  it('is skipped for an enrolment with no start date or already achieved', async () => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue({
      id: ENR,
      organizationId: ORG,
      programmeId: PROG,
      learnerId: LRN,
      startDate: null
    } as never);
    await listReviews(admin, ENR, NOW);
    vi.mocked(q.getApprEnrolment).mockResolvedValue({
      id: ENR,
      organizationId: ORG,
      programmeId: PROG,
      learnerId: LRN,
      startDate: '2026-01-01',
      achievedAt: '2026-05-01'
    } as never);
    await listReviews(admin, ENR, NOW);
    expect(q.insertFirstReviewIfNone).not.toHaveBeenCalled();
  });
});

describe('updateReview', () => {
  it('editing content on a SCHEDULED review moves it to DRAFT; skipping DRAFT is refused', async () => {
    await updateReview(tutor, REV, { progressSummary: 'Going well' });
    expect(vi.mocked(q.updateApprReviewIfUnchanged).mock.calls[0][3]).toMatchObject({
      progressSummary: 'Going well',
      status: 'DRAFT'
    });
    await expect(
      updateReview(tutor, REV, { status: 'AWAITING_SIGNATURES', heldDate: '2026-06-02' })
    ).rejects.toMatchObject({
      statusCode: 400
    });
  });

  it('asking for signatures needs a held date, then tells the apprentice exactly once', async () => {
    givenReview(review({ status: 'DRAFT' }));
    await expect(updateReview(tutor, REV, { status: 'AWAITING_SIGNATURES' })).rejects.toMatchObject({
      statusCode: 400
    });
    await updateReview(tutor, REV, { status: 'AWAITING_SIGNATURES', heldDate: '2026-06-02' });
    expect(notifyReviewReadyToSign).toHaveBeenCalledTimes(1);
    expect(notifyReviewReadyToSign).toHaveBeenCalledWith({ reviewId: REV, learnerId: LRN });

    // an edit while already awaiting does not notify again
    givenReview(review({ status: 'AWAITING_SIGNATURES', heldDate: '2026-06-02' }));
    await updateReview(tutor, REV, { tutorComment: 'Typo fixed' });
    expect(notifyReviewReadyToSign).toHaveBeenCalledTimes(1);
  });

  it('rescheduling re-arms the review-due reminder', async () => {
    await updateReview(admin, REV, { scheduledDate: '2026-09-01' });
    expect(vi.mocked(q.updateApprReviewIfUnchanged).mock.calls[0][3]).toMatchObject({
      scheduledDate: '2026-09-01',
      dueNotifiedAt: null
    });
  });

  it('LOCKS for staff once ANY signature exists; the apprentice can still comment until they sign', async () => {
    givenReview(review({ status: 'AWAITING_SIGNATURES', heldDate: '2026-06-02', employerSignedAt: UPDATED }));
    await expect(updateReview(tutor, REV, { tutorComment: 'changed my mind' })).rejects.toMatchObject({
      statusCode: 409
    });
    await expect(updateReview(admin, REV, { scheduledDate: '2026-12-01' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(updateReview(self, REV, { learnerComment: 'I agree' })).resolves.toBeTruthy();

    givenReview(
      review({
        status: 'AWAITING_SIGNATURES',
        heldDate: '2026-06-02',
        employerSignedAt: UPDATED,
        learnerSignedAt: UPDATED
      })
    );
    await expect(updateReview(self, REV, { learnerComment: 'too late' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('the apprentice can write ONLY their own comment; staff cannot write it; others cannot touch the review', async () => {
    givenReview(review({ status: 'DRAFT' }));
    await expect(updateReview(self, REV, { tutorComment: 'sneaky' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(updateReview(self, REV, { status: 'AWAITING_SIGNATURES' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(updateReview(tutor, REV, { learnerComment: 'forged' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(updateReview(otherLearner, REV, { learnerComment: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(updateReview(otherOrgAdmin, REV, { tutorComment: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    // a SCHEDULED review has nothing for the apprentice to comment on yet
    givenReview(review({ status: 'SCHEDULED' }));
    await expect(updateReview(self, REV, { learnerComment: 'early' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('COMPLETE and CANCELLED reviews are closed (409)', async () => {
    for (const status of ['COMPLETE', 'CANCELLED']) {
      givenReview(review({ status }));
      await expect(updateReview(admin, REV, { tutorComment: 'x' })).rejects.toMatchObject({ statusCode: 409 });
    }
  });

  it('a stale editor (expectedUpdatedAt) or a lost race on the conditional update is a 409', async () => {
    await expect(
      updateReview(tutor, REV, { tutorComment: 'x', expectedUpdatedAt: '2026-05-01T09:00:00.000Z' })
    ).rejects.toMatchObject({ statusCode: 409 });
    vi.mocked(q.updateApprReviewIfUnchanged).mockResolvedValueOnce(null as never);
    await expect(updateReview(tutor, REV, { tutorComment: 'x' })).rejects.toMatchObject({ statusCode: 409 });
    // same instant in a different format is NOT stale
    await expect(
      updateReview(tutor, REV, { tutorComment: 'x', expectedUpdatedAt: '2026-05-01 10:00:00+00' })
    ).resolves.toBeTruthy();
  });
});

describe('signReview', () => {
  const awaiting = (over: Record<string, unknown> = {}) =>
    review({ status: 'AWAITING_SIGNATURES', heldDate: '2026-06-02', ...over });

  it('the apprentice signs only as themselves; staff cannot sign as the apprentice; a learner cannot sign as tutor/employer', async () => {
    givenReview(awaiting());
    await expect(signReview(self, REV, { role: 'LEARNER', name: 'Lee Learner' }, NOW)).resolves.toBeTruthy();
    await expect(signReview(tutor, REV, { role: 'LEARNER', name: 'Tina' }, NOW)).rejects.toMatchObject({
      statusCode: 403
    });
    await expect(signReview(admin, REV, { role: 'LEARNER', name: 'Ada' }, NOW)).rejects.toMatchObject({
      statusCode: 403
    });
    await expect(signReview(self, REV, { role: 'TUTOR', name: 'Lee' }, NOW)).rejects.toMatchObject({ statusCode: 403 });
    await expect(signReview(self, REV, { role: 'EMPLOYER', name: 'Lee' }, NOW)).rejects.toMatchObject({
      statusCode: 403
    });
    await expect(signReview(otherLearner, REV, { role: 'LEARNER', name: 'Mo' }, NOW)).rejects.toMatchObject({
      statusCode: 404
    });
    await expect(signReview(otherOrgAdmin, REV, { role: 'TUTOR', name: 'X' }, NOW)).rejects.toMatchObject({
      statusCode: 404
    });
  });

  it('tutor signature stores who signed; the employer is recorded by staff "on behalf"', async () => {
    givenReview(awaiting());
    await signReview(tutor, REV, { role: 'TUTOR', name: 'Tina Tutor' }, NOW);
    expect(vi.mocked(q.updateApprReviewIfUnchanged).mock.calls[0][3]).toMatchObject({
      tutorSignedName: 'Tina Tutor',
      tutorSignedBy: 'u-tutor'
    });
    expect(vi.mocked(q.updateApprReviewIfUnchanged).mock.calls[0][4]).toBe('tutorSignedAt');
    vi.mocked(q.updateApprReviewIfUnchanged).mockClear();
    await signReview(tutor, REV, { role: 'EMPLOYER', name: 'Eve Employer' }, NOW);
    expect(vi.mocked(q.updateApprReviewIfUnchanged).mock.calls[0][3]).toMatchObject({
      employerSignedName: 'Eve Employer',
      employerRecordedBy: 'u-tutor'
    });
  });

  it('a partial signature does NOT complete the review', async () => {
    givenReview(awaiting({ tutorSignedAt: UPDATED }));
    const res = await signReview(self, REV, { role: 'LEARNER', name: 'Lee' }, NOW);
    expect(res.status).toBe('AWAITING_SIGNATURES');
    expect(q.insertApprReview).not.toHaveBeenCalled();
  });

  it('the LAST signature completes it in the same transaction: snapshot stored, next review scheduled', async () => {
    givenReview(awaiting({ tutorSignedAt: UPDATED, employerSignedAt: UPDATED }));
    const res = await signReview(self, REV, { role: 'LEARNER', name: 'Lee' }, NOW);
    expect(res.status).toBe('COMPLETE');
    const patch = vi.mocked(q.updateApprReviewIfUnchanged).mock.calls[0][3] as Record<string, unknown>;
    expect(patch.status).toBe('COMPLETE');
    expect(patch.snapshot).toMatchObject({
      actualPct: 40,
      expectedPct: 50,
      status: 'BEHIND',
      units: { total: 3, complete: 2 }
    });
    // held 2026-06-02 + 12 weeks
    expect(patch.nextReviewDate).toBe('2026-08-25');
    expect(q.insertApprReview).toHaveBeenCalledWith(
      { tx: true },
      expect.objectContaining({ enrolmentId: ENR, scheduledDate: '2026-08-25' })
    );
    expect(res.scheduledNext).toBe(true);
  });

  it('does not double-schedule when an open review already lies ahead; uses the programme interval', async () => {
    vi.mocked(q.getApprProgramme).mockResolvedValue({ id: PROG, reviewIntervalWeeks: 6 } as never);
    vi.mocked(q.countOpenReviewsFrom).mockResolvedValueOnce(1);
    givenReview(awaiting({ tutorSignedAt: UPDATED, employerSignedAt: UPDATED }));
    const res = await signReview(self, REV, { role: 'LEARNER', name: 'Lee' }, NOW);
    expect(res.status).toBe('COMPLETE');
    expect(res.scheduledNext).toBe(false);
    expect(q.insertApprReview).not.toHaveBeenCalled();
    expect(vi.mocked(q.updateApprReviewIfUnchanged).mock.calls[0][3]).toMatchObject({ nextReviewDate: '2026-07-14' });
  });

  it('refuses a review that is not awaiting signatures, a repeated signature, and a lost race (409)', async () => {
    givenReview(review({ status: 'DRAFT' }));
    await expect(signReview(tutor, REV, { role: 'TUTOR', name: 'T' }, NOW)).rejects.toMatchObject({ statusCode: 409 });
    givenReview(awaiting({ tutorSignedAt: UPDATED }));
    await expect(signReview(tutor, REV, { role: 'TUTOR', name: 'T' }, NOW)).rejects.toMatchObject({ statusCode: 409 });
    givenReview(awaiting());
    vi.mocked(q.updateApprReviewIfUnchanged).mockResolvedValueOnce(null as never);
    await expect(signReview(tutor, REV, { role: 'TUTOR', name: 'T' }, NOW)).rejects.toMatchObject({ statusCode: 409 });
    expect(q.insertApprReview).not.toHaveBeenCalled();
  });
});

describe('cancelReview', () => {
  it('staff cancel an open review; closed ones and learners are refused', async () => {
    await expect(cancelReview(tutor, REV)).resolves.toMatchObject({ status: 'CANCELLED' });
    await expect(cancelReview(self, REV)).rejects.toMatchObject({ statusCode: 403 });
    givenReview(review({ status: 'COMPLETE' }));
    await expect(cancelReview(admin, REV)).rejects.toMatchObject({ statusCode: 409 });
  });
});
