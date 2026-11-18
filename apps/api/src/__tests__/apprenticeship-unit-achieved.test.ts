import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// Gecko Apprenticeships — unit / criterion "achieved on" dates and unit schedule order on the portfolio + PDF report
// payloads. The dates come from the accepted-evidence dates (listCriterionAcceptedDates); nothing is stored.

vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  isProgrammeTutorOfLinked: vi.fn(async () => false),
  getLinkedEnrolment: vi.fn(async () => null),
  sumValidatedOtjLogMinutes: vi.fn(async () => 0),
  lockApprEnrolment: vi.fn(async () => null),
  getApprEnrolment: vi.fn(),
  getLinkedEnrolment: vi.fn(async () => null),
  listOtjLogsForReport: vi.fn(async () => []),
  getApprSettings: vi.fn(async () => ({ concernGapPct: 15, otjFactor: 0.2, otjWeeklyCapHours: 30 })),
  getEnrolmentOverview: vi.fn(),
  getApprProgrammeStructure: vi.fn(),
  countEvidenceByCriterion: vi.fn(async () => new Map()),
  listCriterionAcceptedDates: vi.fn(async () => new Map()),
  getEvidenceTotals: vi.fn(async () => ({ submitted: 0, accepted: 0, referred: 0, otjMinutes: 0 })),
  listEnrolmentUnitRows: vi.fn(async () => []),
  upsertEnrolmentUnitDates: vi.fn(async () => undefined),
  sumGlhLogMinutes: vi.fn(async () => 0),
  listAcceptedEvidenceTitles: vi.fn(async () => new Map()),
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
import { getPortfolio, setUnitDates } from '@api/services/apprenticeship/enrolment';
import { getPortfolioReport } from '@api/services/apprenticeship/report';

const ORG = 'org-1';
const PROG = '11111111-1111-4111-8111-111111111111';
const LRN = '22222222-2222-4222-8222-222222222222';
const ENR = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-11T10:00:00Z');
const admin = { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG } as Actor;

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
  tutors: [],
  overdueTaskCount: 0,
  nextReview: null,
  gatewayChecklist: null
});

// Programme order: u1, u2, u3 (one qualification). u1 has two criteria (the second needs 2 pieces), u2 one, u3 none.
const structure = {
  qualifications: [{ id: 'q1', title: 'Diploma', reference: '603/1', awardingBody: 'NCFE', level: '2' }],
  units: [
    { id: 'u1', qualificationId: 'q1', code: 'U1', title: 'Communication', glh: 20 },
    { id: 'u2', qualificationId: 'q1', code: 'U2', title: 'Safety', glh: 10 },
    { id: 'u3', qualificationId: 'q1', code: 'U3', title: 'Empty', glh: null }
  ],
  criteria: [
    { id: 'c11', unitId: 'u1', code: '1.1', text: 'Explain', groupLabel: null, requiredCount: 1 },
    { id: 'c12', unitId: 'u1', code: '1.2', text: 'Listen', groupLabel: null, requiredCount: 2 },
    { id: 'c21', unitId: 'u2', code: '2.1', text: 'Hazards', groupLabel: null, requiredCount: 1 }
  ]
};

const accepted = (entries: Record<string, number>) =>
  new Map(Object.entries(entries).map(([id, n]) => [id, { accepted: n, submitted: 0 }]));
const dates = (entries: Record<string, string[]>) => new Map(Object.entries(entries));

const unitsOf = async () => (await getPortfolio(admin, ENR)).qualifications[0]!.units;
const byId = <T extends { id: string }>(list: T[], id: string) => list.find((x) => x.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.getApprEnrolment).mockResolvedValue({
    id: ENR,
    organizationId: ORG,
    programmeId: PROG,
    learnerId: LRN
  } as never);
  vi.mocked(q.getEnrolmentOverview).mockResolvedValue(overview() as never);
  vi.mocked(q.getApprProgrammeStructure).mockResolvedValue(structure as never);
  vi.mocked(q.countEvidenceByCriterion).mockResolvedValue(new Map());
  vi.mocked(q.listCriterionAcceptedDates).mockResolvedValue(new Map());
  vi.mocked(q.listEnrolmentUnitRows).mockResolvedValue([]);
});

describe('portfolio achievedAt', () => {
  it('a completed unit is achieved on its latest criterion date; the Nth piece dates a multi-piece criterion', async () => {
    vi.mocked(q.countEvidenceByCriterion).mockResolvedValue(accepted({ c11: 1, c12: 3, c21: 1 }) as never);
    vi.mocked(q.listCriterionAcceptedDates).mockResolvedValue(
      dates({
        c11: ['2026-03-01T09:00:00.000Z'],
        c12: ['2026-02-01T09:00:00.000Z', '2026-04-01T09:00:00.000Z', '2026-05-01T09:00:00.000Z'],
        c21: ['2026-06-01T09:00:00.000Z']
      }) as never
    );
    const units = await unitsOf();
    const u1 = byId(units, 'u1');
    expect(u1.status).toBe('COMPLETE');
    // required 2 -> the 2nd accepted piece (April), not the 1st or the 3rd
    expect(byId(u1.criteria, 'c12').achievedAt).toBe('2026-04-01T09:00:00.000Z');
    expect(byId(u1.criteria, 'c11').achievedAt).toBe('2026-03-01T09:00:00.000Z');
    expect(u1.achievedAt).toBe('2026-04-01T09:00:00.000Z');
    expect(byId(units, 'u2').achievedAt).toBe('2026-06-01T09:00:00.000Z');
  });

  it('a unit with an unmet criterion has no unit date, but its met criterion keeps its own date', async () => {
    vi.mocked(q.countEvidenceByCriterion).mockResolvedValue(accepted({ c11: 1, c12: 1 }) as never);
    vi.mocked(q.listCriterionAcceptedDates).mockResolvedValue(
      dates({ c11: ['2026-03-01T09:00:00.000Z'], c12: ['2026-02-01T09:00:00.000Z'] }) as never
    );
    const u1 = byId(await unitsOf(), 'u1');
    expect(u1.status).not.toBe('COMPLETE');
    expect(u1.achievedAt).toBeNull();
    expect(byId(u1.criteria, 'c11').achievedAt).toBe('2026-03-01T09:00:00.000Z');
    expect(byId(u1.criteria, 'c12').met).toBe(false);
    expect(byId(u1.criteria, 'c12').achievedAt).toBeNull();
  });

  it('a referred / reopened criterion (nothing accepted left) loses its date, and the unit loses its date', async () => {
    // stale dates must not leak: the count says nothing is accepted, so not met => no date
    vi.mocked(q.countEvidenceByCriterion).mockResolvedValue(accepted({ c21: 0 }) as never);
    vi.mocked(q.listCriterionAcceptedDates).mockResolvedValue(dates({ c21: ['2026-06-01T09:00:00.000Z'] }) as never);
    const u2 = byId(await unitsOf(), 'u2');
    expect(u2.criteria[0]!.achievedAt).toBeNull();
    expect(u2.achievedAt).toBeNull();
  });

  it('a unit with zero criteria never gets a date', async () => {
    const u3 = byId(await unitsOf(), 'u3');
    expect(u3.criteria).toEqual([]);
    expect(u3.achievedAt).toBeNull();
  });
});

describe('unit order', () => {
  const rows = (r: Array<[string, string | null, string | null]>) =>
    r.map(([unitId, startDate, targetDate]) => ({ unitId, startDate, targetDate }));

  it('dated units come first by start date; undated keep programme order after them', async () => {
    vi.mocked(q.listEnrolmentUnitRows).mockResolvedValue(
      rows([
        ['u1', null, null],
        ['u3', '2026-02-01', '2026-03-01'],
        ['u2', '2026-01-01', '2026-02-01']
      ]) as never
    );
    expect((await unitsOf()).map((u) => u.id)).toEqual(['u2', 'u3', 'u1']);
  });

  it('with no dates the programme order is unchanged', async () => {
    expect((await unitsOf()).map((u) => u.id)).toEqual(['u1', 'u2', 'u3']);
  });

  it('setUnitDates returns the re-sorted portfolio', async () => {
    vi.mocked(q.listEnrolmentUnitRows).mockResolvedValue(rows([['u3', '2026-01-05', '2026-02-01']]) as never);
    const p = await setUnitDates(admin, ENR, {
      units: [{ unitId: 'u3', startDate: '2026-01-05', targetDate: '2026-02-01' }]
    } as never);
    expect(p.qualifications[0]!.units.map((u) => u.id)).toEqual(['u3', 'u1', 'u2']);
    expect(q.upsertEnrolmentUnitDates).toHaveBeenCalled();
  });
});

describe('report payload', () => {
  it('carries achievedAt on units and criteria, in portfolio (date) order', async () => {
    vi.mocked(q.countEvidenceByCriterion).mockResolvedValue(accepted({ c21: 1 }) as never);
    vi.mocked(q.listCriterionAcceptedDates).mockResolvedValue(dates({ c21: ['2026-06-01T09:00:00.000Z'] }) as never);
    vi.mocked(q.listEnrolmentUnitRows).mockResolvedValue([
      { unitId: 'u2', startDate: '2026-01-01', targetDate: '2026-02-01' }
    ] as never);
    const r = await getPortfolioReport(admin, ENR, NOW);
    expect(r.units.map((u) => u.ref)).toEqual(['U2', 'U1', 'U3']);
    expect(r.units[0]).toMatchObject({
      achievedAt: '2026-06-01T09:00:00.000Z',
      criteria: [{ ref: '2.1', met: true, achievedAt: '2026-06-01T09:00:00.000Z' }]
    });
    expect(r.units[1]!.achievedAt).toBeNull();
    expect(r.units[1]!.criteria[0]).toMatchObject({ met: false, achievedAt: null });
  });
});
