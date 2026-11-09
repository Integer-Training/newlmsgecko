import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// Gecko Apprenticeships Phase A2 — the evidence review state machine and the learners-table status computation,
// with the DB queries mocked (the rules module is the real one).

vi.mock('@cio/db/queries/apprenticeship', () => ({
  getApprEnrolment: vi.fn(),
  getApprEnrolmentByProgrammeLearner: vi.fn(),
  getApprEvidence: vi.fn(),
  updateApprEvidence: vi.fn(),
  replaceEvidenceCriteria: vi.fn(),
  insertEvidenceNote: vi.fn(async () => ({})),
  filterCriterionIdsInProgramme: vi.fn(async (_p: string, ids: string[]) => ids),
  listEnrolmentRows: vi.fn(),
  getApprSettings: vi.fn(async () => ({ concernGapPct: 15, otjFactor: 0.2, otjWeeklyCapHours: 30 }))
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
  recomputeEnrolment: vi.fn(async () => ({
    actualPct: 10,
    expectedPct: 50,
    status: 'CONCERN',
    otjTargetMinutes: null,
    otjExpectedMinutes: null,
    otjMinutes: 0,
    otjStatus: 'NOT_SET',
    totals: { submitted: 0, accepted: 1, referred: 0, otjMinutes: 0 }
  }))
}));
vi.mock('@api/services/organization/users', () => ({ createOrgUser: vi.fn() }));
vi.mock('@api/services/organization/allocation', () => ({ createTutorAllocation: vi.fn() }));

import * as q from '@cio/db/queries/apprenticeship';
import { recordAudit } from '@cio/db/audit';
import { isTutorAllocatedToLearner } from '@cio/db/queries/allocation';
import { recomputeEnrolment } from '@api/services/apprenticeship/progress';
import { computeRowProgress, listEnrolments, STATUS_RANK } from '@api/services/apprenticeship/enrolment';
import { reviewEvidence, reviewTransition, statusAfterEdit } from '@api/services/apprenticeship/evidence';
import { computeEnrolmentProgress } from '@cio/utils/functions/apprenticeship-progress';
import { APPR_DEFAULT_SETTINGS } from '@cio/utils/constants/apprenticeship';

const ORG = 'org-1';
const PROG = '11111111-1111-4111-8111-111111111111';
const LRN = '22222222-2222-4222-8222-222222222222';
const EV = '44444444-4444-4444-8444-444444444444';
const CRIT = '55555555-5555-4555-8555-555555555555';
const admin = { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG } as Actor;
const tutor = { authenticated: true, userId: 'u-tutor', role: 'TUTOR', status: 'ACTIVE', orgId: ORG } as Actor;
const evidence = (status: string) => ({
  id: EV,
  organizationId: ORG,
  programmeId: PROG,
  learnerId: LRN,
  status,
  files: []
});

describe('reviewTransition (pure state machine)', () => {
  it('SUBMITTED → ACCEPTED / REFERRED for any reviewer', () => {
    expect(reviewTransition('SUBMITTED', 'ACCEPT', 'TUTOR')).toBe('ACCEPTED');
    expect(reviewTransition('SUBMITTED', 'REFER', 'TUTOR')).toBe('REFERRED');
    expect(reviewTransition('SUBMITTED', 'REFER', 'ADMIN')).toBe('REFERRED');
  });
  it('ACCEPTED can be reopened only by an admin, and cannot be accepted again', () => {
    expect(reviewTransition('ACCEPTED', 'REFER', 'ADMIN')).toBe('REFERRED');
    expect(() => reviewTransition('ACCEPTED', 'REFER', 'TUTOR')).toThrow(/Only an admin/);
    expect(() => reviewTransition('ACCEPTED', 'ACCEPT', 'ADMIN')).toThrow(/already accepted/);
  });
  it('REFERRED waits for the learner: no review either way', () => {
    expect(() => reviewTransition('REFERRED', 'ACCEPT', 'ADMIN')).toThrow(/resubmit/);
    expect(() => reviewTransition('REFERRED', 'REFER', 'ADMIN')).toThrow(/resubmit/);
  });
  it('a learner edit resubmits REFERRED; a staff edit never changes status', () => {
    expect(statusAfterEdit('REFERRED', true)).toBe('SUBMITTED');
    expect(statusAfterEdit('REFERRED', false)).toBe('REFERRED');
    expect(statusAfterEdit('SUBMITTED', true)).toBe('SUBMITTED');
    expect(statusAfterEdit('ACCEPTED', false)).toBe('ACCEPTED');
  });
});

describe('reviewEvidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(true);
    vi.mocked(q.getApprEvidence).mockResolvedValue(evidence('SUBMITTED') as never);
    vi.mocked(q.getApprEnrolmentByProgrammeLearner).mockResolvedValue({ id: 'enr-1' } as never);
    vi.mocked(q.updateApprEvidence).mockImplementation(
      async (_tx, _id, patch) => ({ ...evidence('x'), ...patch }) as never
    );
    vi.mocked(q.filterCriterionIdsInProgramme).mockImplementation(async (_p, ids) => ids);
  });

  it('ACCEPT writes status + reviewer, replaces the mapping as STAFF, adds the audit note and recomputes in the same tx', async () => {
    const res = await reviewEvidence(tutor, EV, {
      decision: 'ACCEPT',
      criterionIds: [CRIT],
      note: { body: 'Well done', kind: 'GENERAL' }
    });
    const [tx, , patch, expected] = vi.mocked(q.updateApprEvidence).mock.calls[0];
    expect(tx).toEqual({ tx: true });
    expect(patch).toMatchObject({ status: 'ACCEPTED', reviewedBy: 'u-tutor' });
    expect(expected).toBe('SUBMITTED'); // conditional on the status we read
    expect(vi.mocked(q.replaceEvidenceCriteria).mock.calls[0].slice(2)).toEqual([[CRIT], 'STAFF']);
    const notes = vi.mocked(q.insertEvidenceNote).mock.calls.map((c) => c[1]);
    expect(notes[0]).toMatchObject({ kind: 'AUDIT', body: 'Evidence accepted', statusAtTime: 'ACCEPTED' });
    expect(notes[1]).toMatchObject({ kind: 'GENERAL', body: 'Well done' });
    expect(recomputeEnrolment).toHaveBeenCalledWith({ tx: true }, 'enr-1');
    expect(res.summary?.status).toBe('CONCERN');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'appr.evidence.reviewed',
        metadata: expect.objectContaining({ from: 'SUBMITTED', to: 'ACCEPTED' })
      })
    );
  });

  it('REFER without criteria keeps the learner mapping and writes "Evidence referred"', async () => {
    await reviewEvidence(admin, EV, {
      decision: 'REFER',
      criterionIds: [],
      note: { body: 'Add dates', kind: 'GENERAL' }
    });
    expect(q.replaceEvidenceCriteria).not.toHaveBeenCalled();
    expect(vi.mocked(q.insertEvidenceNote).mock.calls[0][1]).toMatchObject({
      body: 'Evidence referred',
      statusAtTime: 'REFERRED'
    });
  });

  it('ACCEPT with no confirmed criterion → 400, nothing written', async () => {
    await expect(reviewEvidence(admin, EV, { decision: 'ACCEPT', criterionIds: [] })).rejects.toMatchObject({
      statusCode: 400
    });
    expect(q.updateApprEvidence).not.toHaveBeenCalled();
  });

  it('REFERRED evidence cannot be reviewed (409); accepted evidence is reopened by an admin only', async () => {
    vi.mocked(q.getApprEvidence).mockResolvedValue(evidence('REFERRED') as never);
    await expect(reviewEvidence(admin, EV, { decision: 'ACCEPT', criterionIds: [CRIT] })).rejects.toMatchObject({
      statusCode: 409
    });
    vi.mocked(q.getApprEvidence).mockResolvedValue(evidence('ACCEPTED') as never);
    await expect(reviewEvidence(tutor, EV, { decision: 'REFER', criterionIds: [] })).rejects.toMatchObject({
      statusCode: 403
    });
    await expect(reviewEvidence(admin, EV, { decision: 'REFER', criterionIds: [] })).resolves.toBeTruthy();
    expect(vi.mocked(q.updateApprEvidence).mock.calls[0][2]).toMatchObject({ status: 'REFERRED' });
  });

  it('a concurrent review (status changed under us) → 409, no note, no recompute', async () => {
    vi.mocked(q.updateApprEvidence).mockResolvedValue(null);
    await expect(reviewEvidence(admin, EV, { decision: 'ACCEPT', criterionIds: [CRIT] })).rejects.toMatchObject({
      statusCode: 409
    });
    expect(q.insertEvidenceNote).not.toHaveBeenCalled();
    expect(recomputeEnrolment).not.toHaveBeenCalled();
  });

  it('a learner cannot review, and a non-allocated tutor cannot even see the evidence', async () => {
    const learner = { authenticated: true, userId: LRN, role: 'LEARNER', status: 'ACTIVE', orgId: ORG } as Actor;
    await expect(reviewEvidence(learner, EV, { decision: 'ACCEPT', criterionIds: [CRIT] })).rejects.toMatchObject({
      statusCode: 403
    });
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(false);
    await expect(reviewEvidence(tutor, EV, { decision: 'ACCEPT', criterionIds: [CRIT] })).rejects.toMatchObject({
      statusCode: 404
    });
    expect(q.updateApprEvidence).not.toHaveBeenCalled();
  });
});

describe('learners table status computation', () => {
  const NOW = new Date('2026-07-01T10:00:00Z'); // ~50% through a 2026 calendar-year enrolment
  const row = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id,
    programmeId: PROG,
    programmeTitle: 'Adult Care',
    learnerId: `l-${id}`,
    learnerName: name,
    learnerEmail: `${id}@x.test`,
    startDate: '2026-01-01',
    plannedEndDate: '2026-12-31',
    contractedHoursWeek: 30,
    otjTargetMinutesOverride: null,
    achievedAt: null,
    actualPct: 0,
    otjMinutes: 0,
    submittedCount: 0,
    acceptedCount: 0,
    referredCount: 0,
    tutors: [],
    ...over
  });
  const query = { page: 1, pageSize: 25 };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(q.getApprSettings).mockResolvedValue({ ...APPR_DEFAULT_SETTINGS });
    vi.mocked(q.listEnrolmentRows).mockResolvedValue([
      row('ontarget', 'Zed', { actualPct: 60 }),
      row('complete', 'Yan', { actualPct: 100 }),
      row('notset', 'Xia', { startDate: null, plannedEndDate: null, actualPct: 5 }),
      row('behind-b', 'Bea', { actualPct: 40 }),
      row('concern-b', 'Ben', { actualPct: 5 }),
      row('behind-a', 'Abe', { actualPct: 38 }),
      row('concern-a', 'Amy', { actualPct: 0 })
    ] as never);
  });

  it('orders CONCERN first, then BEHIND, then the rest, with name as the tie-break', async () => {
    const res = await listEnrolments(admin, query, NOW);
    expect(res.items.map((i) => i.id)).toEqual([
      'concern-a',
      'concern-b',
      'behind-a',
      'behind-b',
      'notset',
      'ontarget',
      'complete'
    ]);
    expect(res.items.map((i) => i.status)).toEqual([
      'CONCERN',
      'CONCERN',
      'BEHIND',
      'BEHIND',
      'NOT_SET',
      'ON_TARGET',
      'COMPLETE'
    ]);
    expect(STATUS_RANK.CONCERN).toBeLessThan(STATUS_RANK.BEHIND);
  });

  it('filters by status after computing, but status counts cover the whole filtered set; paginates in memory', async () => {
    const behind = await listEnrolments(admin, { ...query, status: 'BEHIND' }, NOW);
    expect(behind.items.map((i) => i.id)).toEqual(['behind-a', 'behind-b']);
    expect(behind.total).toBe(2);
    expect(behind.statusCounts).toEqual({ CONCERN: 2, BEHIND: 2, NOT_SET: 1, ON_TARGET: 1, COMPLETE: 1 });
    const page2 = await listEnrolments(admin, { page: 2, pageSize: 3 }, NOW);
    expect(page2.items.map((i) => i.id)).toEqual(['behind-b', 'notset', 'ontarget']);
    expect(page2.total).toBe(7);
  });

  it('adds overdueTaskCount, nextReview and a computed reviewOverdue to every row (defaults when absent)', async () => {
    vi.mocked(q.listEnrolmentRows).mockResolvedValue([
      row('late', 'Ann', {
        overdueTaskCount: 3,
        nextReview: { id: 'r1', scheduledDate: '2026-05-01', status: 'DRAFT' }
      }),
      row('soon', 'Bob', {
        overdueTaskCount: 0,
        nextReview: { id: 'r2', scheduledDate: '2099-01-01', status: 'SCHEDULED' }
      }),
      row('none', 'Cat', {})
    ] as never);
    const res = await listEnrolments(admin, { page: 1, pageSize: 25 }, NOW);
    const byId = Object.fromEntries(res.items.map((i) => [i.id, i]));
    expect(byId.late).toMatchObject({ overdueTaskCount: 3, reviewOverdue: true, nextReview: { id: 'r1' } });
    expect(byId.soon).toMatchObject({ overdueTaskCount: 0, reviewOverdue: false });
    expect(byId.none).toMatchObject({ overdueTaskCount: 0, nextReview: null, reviewOverdue: false });
    // the day used for "overdue" is passed to the single rows query
    expect(vi.mocked(q.listEnrolmentRows).mock.calls[0][0]).toMatchObject({ today: NOW.toISOString().slice(0, 10) });
  });

  it('runs ONE rows query scoped to the actor (tutor → allocated, learner → self)', async () => {
    await listEnrolments(admin, query, NOW);
    await listEnrolments(tutor, query, NOW);
    await listEnrolments({ ...admin, role: 'LEARNER', userId: LRN } as Actor, query, NOW);
    const scopes = vi.mocked(q.listEnrolmentRows).mock.calls.map((c) => c[0]);
    expect(scopes[0].organizationId).toBe(ORG);
    expect(scopes[0].restrictToTutorId).toBeUndefined();
    expect(scopes[0].restrictToLearnerId).toBeUndefined();
    expect(scopes[1]).toMatchObject({ restrictToTutorId: 'u-tutor' });
    expect(scopes[2]).toMatchObject({ restrictToLearnerId: LRN });
    expect(q.listEnrolmentRows).toHaveBeenCalledTimes(3);
  });

  it('agrees with computeEnrolmentProgress (one rules path for the table and the portfolio)', () => {
    const today = '2026-07-01';
    const r = row('x', 'X', { actualPct: 30, otjMinutes: 600 }) as never as Parameters<typeof computeRowProgress>[0];
    const fromRow = computeRowProgress(r, APPR_DEFAULT_SETTINGS, today);
    // One unit whose actual % is 30 (3 of 10 required accepted) reproduces actualPct 30.
    const full = computeEnrolmentProgress({
      startDate: r.startDate,
      plannedEndDate: r.plannedEndDate,
      contractedHoursWeek: r.contractedHoursWeek,
      otjOverrideMinutes: r.otjTargetMinutesOverride,
      otjMinutes: r.otjMinutes,
      units: [{ unitId: 'u', startDate: null, targetDate: null, criteria: [{ acceptedCount: 3, requiredCount: 10 }] }],
      today,
      settings: APPR_DEFAULT_SETTINGS
    });
    expect(full.actualPct).toBe(30);
    expect(fromRow.expectedPct).toBe(full.expectedPct);
    expect(fromRow.status).toBe(full.status);
    expect(fromRow.otjTargetMinutes).toBe(full.otjTargetMinutes);
    expect(fromRow.otjExpectedMinutes).toBe(full.otjExpectedMinutes);
    expect(fromRow.otjStatus).toBe(full.otjStatus);
  });
});
