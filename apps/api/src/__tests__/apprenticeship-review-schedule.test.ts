import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// Gecko Apprenticeships round 2 — the first progress review is scheduled automatically when a learner is enrolled
// (start date + the programme's review interval), in the same transaction; the interval is tunable per programme.

vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  getApprProgramme: vi.fn(),
  getApprEnrolmentByProgrammeLearner: vi.fn(async () => null),
  getApprProgrammeStructure: vi.fn(async () => ({ qualifications: [], units: [{ id: 'u1' }], criteria: [] })),
  insertApprEnrolment: vi.fn(async (_tx: unknown, v: object) => ({ id: 'enr-new', ...v })),
  insertEnrolmentUnits: vi.fn(async () => undefined),
  insertApprReview: vi.fn(async (_tx: unknown, v: object) => ({ id: 'rev-new', ...v })),
  getApprEnrolment: vi.fn(),
  getEnrolmentOverview: vi.fn(async () => null),
  updateApprEnrolment: vi.fn(async () => undefined),
  listReviewsForEnrolment: vi.fn(),
  updateApprReviewIfUnchanged: vi.fn(async () => ({})),
  listPlannedPlanTasksForEnrolment: vi.fn(),
  updateApprTask: vi.fn(async () => ({}))
}));
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => false),
  getOrgMemberRoleId: vi.fn(async () => 'TUTOR-ROLE')
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', () => ({ runInTransaction: (fn: (tx: unknown) => unknown) => fn({ tx: true }) }));
vi.mock('@api/services/apprenticeship/progress', () => ({
  todayIso: () => '2026-06-01',
  recomputeEnrolment: vi.fn(async () => null)
}));
vi.mock('@api/services/organization/users', () => ({ createOrgUser: vi.fn() }));
vi.mock('@api/services/organization/allocation', () => ({ createTutorAllocation: vi.fn(async () => undefined) }));
vi.mock('@cio/utils/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cio/utils/constants')>();
  return { ...actual, ROLE: { ...actual.ROLE, TUTOR: 'TUTOR-ROLE', STUDENT: 'TUTOR-ROLE' } };
});

import * as q from '@cio/db/queries/apprenticeship';
import { createEnrolment, updateEnrolment } from '@api/services/apprenticeship/enrolment';
import { ZProgrammeUpdate } from '@cio/utils/validation/apprenticeship';

const ORG = 'org-1';
const PROG = '11111111-1111-4111-8111-111111111111';
const LRN = '22222222-2222-4222-8222-222222222222';
const TUTOR = '88888888-8888-4888-8888-888888888888';
const admin = { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG } as Actor;

beforeEach(() => vi.clearAllMocks());

describe('first review on enrolment', () => {
  const enrol = (interval: number, startDate = '2026-01-05') => {
    vi.mocked(q.getApprProgramme).mockResolvedValue({
      id: PROG,
      organizationId: ORG,
      status: 'ACTIVE',
      reviewIntervalWeeks: interval
    } as never);
    return createEnrolment(admin, {
      programmeId: PROG,
      learner: { learnerId: LRN },
      tutorId: TUTOR,
      startDate,
      plannedEndDate: '2027-12-31'
    } as never);
  };

  it('schedules start + 12 weeks by default, inside the enrolment transaction', async () => {
    await enrol(12, '2026-06-01');
    expect(q.insertApprReview).toHaveBeenCalledWith(
      { tx: true },
      expect.objectContaining({ enrolmentId: 'enr-new', organizationId: ORG, scheduledDate: '2026-08-24' })
    );
  });

  it('a start + interval already in the past becomes today + 7 days (same rule as back-fill and re-base)', async () => {
    await enrol(12); // 2026-01-05 + 12 weeks = 2026-03-30, before the mocked today 2026-06-01
    expect(vi.mocked(q.insertApprReview).mock.calls[0][1]).toMatchObject({ scheduledDate: '2026-06-08' });
  });

  it('uses the programme interval (6 weeks → 2026-07-13)', async () => {
    await enrol(6, '2026-06-01');
    expect(vi.mocked(q.insertApprReview).mock.calls[0][1]).toMatchObject({ scheduledDate: '2026-07-13' });
  });
});

describe('start date change re-bases what was derived from it', () => {
  const ENR = '33333333-3333-4333-8333-333333333333';
  const rev = (over: Record<string, unknown> = {}) => ({
    id: 'r1',
    scheduledDate: '2026-04-01',
    status: 'SCHEDULED',
    heldDate: null,
    tutorSignedAt: null,
    learnerSignedAt: null,
    employerSignedAt: null,
    updatedAt: 'u1',
    ...over
  });
  const change = async (startDate: string) => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue({
      id: ENR,
      organizationId: ORG,
      programmeId: PROG,
      learnerId: LRN,
      startDate: '2026-01-05',
      plannedEndDate: '2026-12-31'
    } as never);
    vi.mocked(q.getApprProgramme).mockResolvedValue({
      id: PROG,
      organizationId: ORG,
      status: 'ACTIVE',
      reviewIntervalWeeks: 12
    } as never);
    await updateEnrolment(admin, ENR, { startDate }).catch(() => undefined); // the portfolio reload is not under test
  };

  it('moves an untouched first review to new start + interval, clearing its due reminder', async () => {
    vi.mocked(q.listReviewsForEnrolment).mockResolvedValue([rev()] as never);
    vi.mocked(q.listPlannedPlanTasksForEnrolment).mockResolvedValue([]);
    await change('2026-05-04');
    expect(q.updateApprReviewIfUnchanged).toHaveBeenCalledWith({ tx: true }, 'r1', 'u1', {
      scheduledDate: '2026-07-27',
      dueNotifiedAt: null
    });
  });

  it('a date already past becomes today + 7 days', async () => {
    vi.mocked(q.listReviewsForEnrolment).mockResolvedValue([rev()] as never);
    vi.mocked(q.listPlannedPlanTasksForEnrolment).mockResolvedValue([]);
    await change('2025-01-06');
    expect(vi.mocked(q.updateApprReviewIfUnchanged).mock.calls[0][3]).toMatchObject({ scheduledDate: '2026-06-08' });
  });

  it('leaves the review alone when it is held / signed / not the untouched first, or any review completed', async () => {
    vi.mocked(q.listPlannedPlanTasksForEnrolment).mockResolvedValue([]);
    for (const list of [
      [rev({ heldDate: '2026-04-01' })],
      [rev({ tutorSignedAt: 'x' })],
      [rev({ status: 'DRAFT' })],
      [rev(), rev({ id: 'r0', scheduledDate: '2026-03-01', status: 'COMPLETE' })],
      []
    ]) {
      vi.mocked(q.listReviewsForEnrolment).mockResolvedValue(list as never);
      await change('2026-02-02');
    }
    expect(q.updateApprReviewIfUnchanged).not.toHaveBeenCalled();
  });

  it('re-dates only PLANNED plan tasks (conditional on PLANNED) and re-arms their overdue alert', async () => {
    vi.mocked(q.listReviewsForEnrolment).mockResolvedValue([] as never);
    vi.mocked(q.listPlannedPlanTasksForEnrolment).mockResolvedValue([
      { id: 't-moved', dueDate: '2026-01-05', monthOffset: 0 },
      { id: 't-same', dueDate: '2026-04-30', monthOffset: 3 }
    ] as never);
    await change('2026-01-31');
    // t-same already has 2026-01-31 + 3 months = 2026-04-30, so only t-moved is written
    expect(q.updateApprTask).toHaveBeenCalledTimes(1);
    expect(q.updateApprTask).toHaveBeenCalledWith(
      { tx: true },
      't-moved',
      { dueDate: '2026-01-31', overdueNotifiedAt: null },
      'PLANNED'
    );
  });

  it('does nothing when the start date is not what changed', async () => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue({
      id: ENR,
      organizationId: ORG,
      programmeId: PROG,
      learnerId: LRN,
      startDate: '2026-01-05',
      plannedEndDate: '2026-12-31'
    } as never);
    await updateEnrolment(admin, ENR, { contractedHoursWeek: 20 }).catch(() => undefined);
    expect(q.listReviewsForEnrolment).not.toHaveBeenCalled();
    expect(q.listPlannedPlanTasksForEnrolment).not.toHaveBeenCalled();
  });
});

describe('programme review interval validation', () => {
  it('accepts 1..52 whole weeks and rejects anything else', () => {
    expect(ZProgrammeUpdate.safeParse({ reviewIntervalWeeks: 12 }).success).toBe(true);
    expect(ZProgrammeUpdate.safeParse({ reviewIntervalWeeks: 1 }).success).toBe(true);
    expect(ZProgrammeUpdate.safeParse({ reviewIntervalWeeks: 52 }).success).toBe(true);
    for (const bad of [0, 53, -4, 6.5, '12']) {
      expect(ZProgrammeUpdate.safeParse({ reviewIntervalWeeks: bad }).success, String(bad)).toBe(false);
    }
  });
});
