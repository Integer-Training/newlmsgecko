import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// Gecko Apprenticeships — Summary dashboard + PDF portfolio report: role scoping, counts shape (derived with the same
// rules as the learners list), the report access matrix, and that the report carries no IQA data or file keys/URLs.

vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  getApprEnrolment: vi.fn(),
  getApprSettings: vi.fn(async () => ({ concernGapPct: 15, otjFactor: 0.2, otjWeeklyCapHours: 30 })),
  listEnrolmentRows: vi.fn(async () => []),
  countEvidenceByStatus: vi.fn(async () => new Map()),
  countTasksByStatus: vi.fn(async () => new Map()),
  listOverdueTasks: vi.fn(async () => []),
  countIqaOpen: vi.fn(async () => ({ pending: 2, awaitingAck: 1 })),
  getEnrolmentOverview: vi.fn(),
  getApprProgrammeStructure: vi.fn(),
  countEvidenceByCriterion: vi.fn(async () => new Map()),
  getEvidenceTotals: vi.fn(async () => ({ submitted: 0, accepted: 0, referred: 0, otjMinutes: 0 })),
  listEnrolmentUnitRows: vi.fn(async () => []),
  sumGlhLogMinutes: vi.fn(async () => 0),
  listTasksForEnrolment: vi.fn(async () => []),
  listTaskCriteria: vi.fn(async () => []),
  listEvidenceForTasks: vi.fn(async () => []),
  listEvidenceForReport: vi.fn(async () => []),
  listReviewsForEnrolment: vi.fn(async () => []),
  listProfileDisplayNames: vi.fn(async () => new Map())
}));
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => false),
  isCourseTutorForLearner: vi.fn(async () => false),
  isCourseTutor: vi.fn(async () => false)
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', () => ({
  runInTransaction: (fn: (t: unknown) => unknown) => fn({}),
  sql: (strings: TemplateStringsArray) => strings.join('?')
}));
vi.mock('@api/services/apprenticeship/onboarding', () => ({ ensureOnboardingTypes: vi.fn(async () => undefined) }));
vi.mock('@api/services/organization/users', () => ({ createOrgUser: vi.fn() }));
vi.mock('@api/services/organization/allocation', () => ({ createTutorAllocation: vi.fn() }));
vi.mock('@api/services/apprenticeship/notifications', () => ({ notifyGatewayReadyOrRelease: vi.fn() }));
vi.mock('@api/middlewares/guards/ownership', () => ({ isAllocatedTutor: vi.fn(async () => false) }));

import * as q from '@cio/db/queries/apprenticeship';
import { isAllocatedTutor } from '@api/middlewares/guards/ownership';
import { recordAudit } from '@cio/db/audit';
import { getSummary } from '@api/services/apprenticeship/summary';
import { getPortfolioReport } from '@api/services/apprenticeship/report';
import { AppError } from '@api/utils/errors';

const ORG = 'org-1';
const PROG = '11111111-1111-4111-8111-111111111111';
const LRN = '22222222-2222-4222-8222-222222222222';
const ENR = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-11T10:00:00Z');

const admin = { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG } as Actor;
const tutor = { authenticated: true, userId: 'u-tutor', role: 'TUTOR', status: 'ACTIVE', orgId: ORG } as Actor;
const self = { authenticated: true, userId: LRN, role: 'LEARNER', status: 'ACTIVE', orgId: ORG } as Actor;
const otherLearner = { ...self, userId: '22222222-2222-4222-8222-999999999999' } as Actor;
const otherOrgAdmin = { ...admin, orgId: 'org-2' } as Actor;

const row = (o: Record<string, unknown> = {}) => ({
  id: ENR,
  programmeId: PROG,
  programmeTitle: 'Adult Care L2',
  learnerId: LRN,
  learnerName: 'Amy Apprentice',
  learnerEmail: 'amy@example.com',
  startDate: '2026-01-01',
  plannedEndDate: '2027-01-01',
  contractedHoursWeek: 30,
  otjTargetMinutesOverride: 1000,
  achievedAt: null,
  actualPct: 10,
  otjMinutes: 100,
  tutors: [],
  onboarding: { required: 3, approved: 3, submitted: 0, rejected: 0 },
  nextReview: null,
  glhMinutes: 0,
  glhTargetMinutes: null,
  unitsTotal: 2,
  unitsComplete: 0,
  gatewayItems: {},
  gatewayPassedAt: null,
  epaBookedDate: null,
  epaResult: null,
  epaResultDate: null,
  gatewayChecklist: null,
  ...o
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.listEnrolmentRows).mockResolvedValue([]);
  vi.mocked(q.countEvidenceByStatus).mockResolvedValue(new Map());
  vi.mocked(q.countTasksByStatus).mockResolvedValue(new Map());
  vi.mocked(q.listOverdueTasks).mockResolvedValue([]);
  vi.mocked(isAllocatedTutor).mockResolvedValue(false);
  vi.mocked(q.isProgrammeTutor).mockResolvedValue(false);
});

describe('getSummary', () => {
  it('scopes an admin to the org and a tutor to their reach; learners get 403', async () => {
    await getSummary(admin, {}, NOW);
    expect(vi.mocked(q.listEnrolmentRows).mock.calls[0]![0]).toMatchObject({
      organizationId: ORG,
      restrictToTutorId: undefined
    });
    expect(vi.mocked(q.countIqaOpen).mock.calls[0]![0]).toMatchObject({ assessorId: undefined });

    const t = await getSummary(tutor, { programmeId: PROG }, NOW);
    expect(t.scope).toBe('TUTOR');
    expect(vi.mocked(q.listEnrolmentRows).mock.calls[1]![0]).toMatchObject({
      restrictToTutorId: 'u-tutor',
      programmeId: PROG
    });
    expect(vi.mocked(q.countEvidenceByStatus).mock.calls[1]![0]).toMatchObject({ restrictToTutorId: 'u-tutor' });
    expect(vi.mocked(q.countTasksByStatus).mock.calls[1]![0]).toMatchObject({ restrictToTutorId: 'u-tutor' });
    expect(vi.mocked(q.listOverdueTasks).mock.calls[1]![0]).toMatchObject({ restrictToTutorId: 'u-tutor' });
    expect(vi.mocked(q.countIqaOpen).mock.calls[1]![0]).toMatchObject({ assessorId: 'u-tutor' });

    await expect(getSummary(self, {}, NOW)).rejects.toMatchObject({ statusCode: 403 });
    await expect(getSummary({ authenticated: false } as Actor, {}, NOW)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('returns the full shape, with zero-filled status maps when nothing exists', async () => {
    const s = await getSummary(admin, {}, NOW);
    expect(s).toMatchObject({
      scope: 'ORG',
      learners: { total: 0, byStatus: { ON_TARGET: 0, BEHIND: 0, CONCERN: 0, NOT_SET: 0, COMPLETE: 0 } },
      otj: { byStatus: { ON_TARGET: 0, BEHIND: 0, CONCERN: 0, NOT_SET: 0 }, minutesDone: 0, minutesTarget: 0 },
      toMark: 0,
      evidence: { SUBMITTED: 0, ACCEPTED: 0, REFERRED: 0 },
      tasks: { byStatus: { PLANNED: 0, SUBMITTED: 0, REFERRED: 0, COMPLETE: 0 }, overdue: 0, overdueList: [] },
      reviews: { overdueTotal: 0, overdue: [], upcomingTotal: 0, upcoming: [] },
      gateway: { ready: 0, atGateway: 0, epaBooked: 0, achieved: 0 },
      onboardingIncomplete: 0,
      iqa: { pending: 2, awaitingAck: 1 }
    });
  });

  it('derives learner / OTJ / review / onboarding counts with the learners-list rules', async () => {
    vi.mocked(q.listEnrolmentRows).mockResolvedValue([
      // ~86% through the year, 10% done: a big gap -> CONCERN; OTJ 100/1000 vs ~860 expected -> CONCERN
      row({ id: 'e1', onboarding: { required: 3, approved: 1, submitted: 1, rejected: 0 } }),
      // no dates -> NOT_SET; review overdue
      row({
        id: 'e2',
        startDate: null,
        plannedEndDate: null,
        nextReview: { id: 'r2', scheduledDate: '2026-11-01', status: 'SCHEDULED' }
      }),
      // finished -> COMPLETE (excluded from the OTJ split); review in 5 days
      row({ id: 'e3', actualPct: 100, nextReview: { id: 'r3', scheduledDate: '2026-11-16', status: 'DRAFT' } }),
      // ahead of plan; review far away -> in neither list
      row({
        id: 'e4',
        actualPct: 95,
        otjMinutes: 900,
        nextReview: { id: 'r4', scheduledDate: '2026-12-31', status: 'SCHEDULED' }
      })
    ] as never);
    vi.mocked(q.countEvidenceByStatus).mockResolvedValue(
      new Map([
        ['SUBMITTED', 4],
        ['ACCEPTED', 9]
      ])
    );
    vi.mocked(q.countTasksByStatus).mockResolvedValue(
      new Map([
        ['PLANNED', 3],
        ['COMPLETE', 1]
      ])
    );
    vi.mocked(q.listOverdueTasks).mockResolvedValue([
      {
        id: 't1',
        title: 'Reflective account',
        dueDate: '2026-11-01',
        status: 'PLANNED',
        enrolmentId: 'e1',
        learnerId: LRN,
        learnerName: 'Amy Apprentice',
        programmeTitle: 'Adult Care L2',
        total: 7
      }
    ] as never);

    const s = await getSummary(admin, {}, NOW);
    expect(s.learners).toEqual({
      total: 4,
      byStatus: { ON_TARGET: 1, BEHIND: 0, CONCERN: 1, NOT_SET: 1, COMPLETE: 1 }
    });
    expect(s.otj.byStatus).toEqual({ ON_TARGET: 1, BEHIND: 0, CONCERN: 1, NOT_SET: 1 });
    expect(s.otj.minutesDone).toBe(100 + 100 + 100 + 900);
    expect(s.onboardingIncomplete).toBe(1);
    expect(s.toMark).toBe(4);
    expect(s.evidence).toMatchObject({ SUBMITTED: 4, ACCEPTED: 9, REFERRED: 0 });
    expect(s.tasks.byStatus).toEqual({ PLANNED: 3, SUBMITTED: 0, REFERRED: 0, COMPLETE: 1 });
    expect(s.tasks.overdue).toBe(7);
    expect(s.tasks.overdueList[0]).toMatchObject({ taskId: 't1', daysOverdue: 10, learnerName: 'Amy Apprentice' });
    expect(s.reviews.overdue.map((r) => r.reviewId)).toEqual(['r2']);
    expect(s.reviews.upcoming.map((r) => r.reviewId)).toEqual(['r3']);
    expect(s.reviews.overdueTotal).toBe(1);
  });

  it('counts the gateway stages from the same view the list uses', async () => {
    const passed = { gatewayPassedAt: '2026-10-01T00:00:00Z' };
    vi.mocked(q.listEnrolmentRows).mockResolvedValue([
      row({
        id: 'g1',
        gatewayChecklist: [{ key: 'm', label: 'Manual', kind: 'MANUAL' }],
        gatewayItems: { m: { done: true } }
      }),
      row({ id: 'g2', ...passed }),
      row({ id: 'g3', ...passed, epaBookedDate: '2026-12-01' }),
      row({ id: 'g4', ...passed, epaResult: 'PASS', achievedAt: '2026-11-01T00:00:00Z' })
    ] as never);
    const s = await getSummary(admin, {}, NOW);
    expect(s.gateway).toEqual({ ready: 1, atGateway: 1, epaBooked: 1, achieved: 1, epaFailed: 0 });
  });
});

describe('getPortfolioReport', () => {
  const overview = () => ({
    enrolment: {
      id: ENR,
      organizationId: ORG,
      programmeId: PROG,
      learnerId: LRN,
      startDate: '2026-01-01',
      plannedEndDate: '2027-01-01',
      contractedHoursWeek: 30,
      otjTargetMinutesOverride: 1000,
      achievedAt: null,
      recomputedAt: null,
      gatewayItems: {},
      gatewayPassedAt: null,
      gatewayPassedBy: null,
      epaBookedDate: null,
      epaResult: null,
      epaResultDate: null
    },
    learnerName: 'Amy Apprentice',
    learnerEmail: 'amy@example.com',
    programmeTitle: 'Adult Care L2',
    programmeReference: 'AC2',
    programmeLevel: '2',
    tutors: [{ id: 't1', name: 'Tina Tutor', kind: 'NAMED' }],
    overdueTaskCount: 0,
    nextReview: null,
    gatewayChecklist: null
  });
  const structure = {
    qualifications: [{ id: 'q1', title: 'Diploma', reference: '603/1', awardingBody: 'NCFE', level: '2' }],
    units: [{ id: 'u1', qualificationId: 'q1', code: 'U1', title: 'Communication', glh: 20 }],
    criteria: [{ id: 'c1', unitId: 'u1', code: '1.1', text: 'Explain', groupLabel: null, requiredCount: 1 }]
  };

  beforeEach(() => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue({
      id: ENR,
      organizationId: ORG,
      programmeId: PROG,
      learnerId: LRN
    } as never);
    vi.mocked(q.getEnrolmentOverview).mockResolvedValue(overview() as never);
    vi.mocked(q.getApprProgrammeStructure).mockResolvedValue(structure as never);
    vi.mocked(q.listEvidenceForReport).mockResolvedValue([
      {
        id: 'ev1',
        title: 'Observation',
        typeLabel: 'Observation',
        status: 'ACCEPTED',
        minutes: 30,
        includeOtj: true,
        createdAt: '2026-03-01T00:00:00Z',
        reviewedAt: '2026-03-02T00:00:00Z',
        reviewedByName: 'Tina Tutor',
        criteriaRefs: ['1.1'],
        fileNames: ['obs.pdf']
      }
    ] as never);
    vi.mocked(q.listReviewsForEnrolment).mockResolvedValue([
      {
        id: 'rv1',
        scheduledDate: '2026-04-01',
        heldDate: '2026-04-01',
        status: 'COMPLETE',
        progressSummary: 'Good',
        targets: [{ text: 'Do X', due: null }],
        tutorComment: 'ok',
        learnerComment: null,
        employerComment: null,
        tutorSignedName: 'Tina Tutor',
        tutorSignedAt: '2026-04-01T10:00:00Z',
        learnerSignedName: 'Amy Apprentice',
        learnerSignedAt: '2026-04-01T11:00:00Z',
        employerSignedName: 'Boss',
        employerSignedAt: '2026-04-01T12:00:00Z',
        nextReviewDate: '2026-07-01'
      }
    ] as never);
  });

  it('builds the payload for an admin, with names only for files and no IQA', async () => {
    const r = await getPortfolioReport(admin, ENR, NOW);
    expect(r.generatedAt).toBe(NOW.toISOString());
    expect(r.learner).toEqual({ id: LRN, name: 'Amy Apprentice', email: 'amy@example.com' });
    expect(r.programme).toMatchObject({ title: 'Adult Care L2', awardingBody: 'NCFE' });
    expect(r.units[0]).toMatchObject({ ref: 'U1', glh: 20, criteria: [{ ref: '1.1', title: 'Explain', met: false }] });
    expect(r.evidence[0]).toMatchObject({
      fileNames: ['obs.pdf'],
      criteriaRefs: ['1.1'],
      reviewedByName: 'Tina Tutor'
    });
    expect(r.reviews[0]!.signatures.tutor.name).toBe('Tina Tutor');
    expect(r.tutors).toEqual([{ id: 't1', name: 'Tina Tutor', kind: 'NAMED' }]);
    expect(r.otj).toMatchObject({ minutesTarget: 1000, minutesDone: 0 });
    expect(q.countIqaOpen).not.toHaveBeenCalled();
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/iqa/i);
    expect(json).not.toMatch(/https?:\/\//);
    expect(json).not.toMatch(/"key"/);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'appr.portfolio.report' }));
  });

  it('access matrix: admin / tutor in reach / learner self yes; the rest 404', async () => {
    await expect(getPortfolioReport(admin, ENR, NOW)).resolves.toBeTruthy();
    await expect(getPortfolioReport(self, ENR, NOW)).resolves.toBeTruthy();

    // tutor not in reach (no allocation, not a programme tutor)
    await expect(getPortfolioReport(tutor, ENR, NOW)).rejects.toMatchObject({ statusCode: 404 });
    // tutor allocated to the learner
    vi.mocked(isAllocatedTutor).mockResolvedValue(true);
    await expect(getPortfolioReport(tutor, ENR, NOW)).resolves.toBeTruthy();
    vi.mocked(isAllocatedTutor).mockResolvedValue(false);
    // tutor assigned to the programme
    vi.mocked(q.isProgrammeTutor).mockResolvedValue(true);
    await expect(getPortfolioReport(tutor, ENR, NOW)).resolves.toBeTruthy();

    await expect(getPortfolioReport(otherLearner, ENR, NOW)).rejects.toBeInstanceOf(AppError);
    await expect(getPortfolioReport(otherOrgAdmin, ENR, NOW)).rejects.toMatchObject({ statusCode: 404 });
    vi.mocked(q.getApprEnrolment).mockResolvedValue(null as never);
    await expect(getPortfolioReport(admin, ENR, NOW)).rejects.toMatchObject({ statusCode: 404 });
  });
});
