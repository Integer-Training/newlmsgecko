import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// Gecko Apprenticeships Deploy 2 — the learner overview payload: carrier resolution, roll-up, breakdown, canAddPair.
// DB queries and the per-enrolment portfolio builder are mocked; access.ts and the rules module are real.

vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(() => false),
  getApprEnrolment: vi.fn(),
  getApprProgramme: vi.fn(),
  getComponentEnrolment: vi.fn(),
  getOnboardingCountsForEnrolment: vi.fn(async () => ({ required: 3, approved: 2, submitted: 1, rejected: 0 })),
  getOverviewBreakdown: vi.fn(async () => ({
    tasks: { PLANNED: 2, SUBMITTED: 0, REFERRED: 0, COMPLETE: 1, overdue: 1 },
    evidence: { SUBMITTED: 1, ACCEPTED: 4, REFERRED: 0 },
    otj: { SUBMITTED: 0, VALIDATED: 2, REJECTED: 0 }
  }))
}));
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => false)
}));
vi.mock('@api/services/apprenticeship/enrolment', () => ({ getPortfolio: vi.fn() }));

import * as q from '@cio/db/queries/apprenticeship';
import { getPortfolio } from '@api/services/apprenticeship/enrolment';
import { getOverview } from '@api/services/apprenticeship/overview';
import { AppError } from '@api/utils/errors';

const ORG = 'org-1';
const LRN = 'lrn-1';
const CARRIER = 'enr-carrier';
const COMP = 'enr-comp';
const DIP = 'prog-dip';
const STD = 'prog-std';

const admin = { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG } as Actor;
const tutor = { authenticated: true, userId: 'u-tutor', role: 'TUTOR', status: 'ACTIVE', orgId: ORG } as Actor;
const self = { authenticated: true, userId: LRN, role: 'LEARNER', status: 'ACTIVE', orgId: ORG } as Actor;
const otherLearner = { ...self, userId: 'lrn-2' } as Actor;

const enrolment = (id: string, programmeId: string, primary: string | null = null) => ({
  id,
  organizationId: ORG,
  learnerId: LRN,
  programmeId,
  primaryEnrolmentId: primary
});

const portfolio = (id: string, programmeId: string, title: string, actualPct: number | null, status: string) => ({
  enrolment: { id, programmeId, startDate: '2026-01-01', plannedEndDate: '2026-12-31', achievedAt: null },
  learner: { id: LRN, name: 'Liam', email: 'l@x.test' },
  programme: { id: programmeId, title, level: '3' },
  tutors: [{ id: 't1', name: 'Tina' }],
  summary: {
    actualPct,
    expectedPct: 50,
    status,
    otj: { targetMinutes: 1000, expectedMinutes: 500, minutes: 250, status: 'ON_TARGET' },
    nextReview: { id: 'r1', scheduledDate: '2026-12-01', status: 'SCHEDULED' },
    stage: 'LEARNING'
  },
  qualifications: [
    {
      units: [
        { id: 'u1', title: 'Unit 1', actualPct: 100, status: 'COMPLETE' },
        { id: 'u2', title: 'Unit 2', actualPct: 40, status: 'BEHIND' }
      ]
    }
  ]
});

function pairSetup() {
  const rows: Record<string, ReturnType<typeof enrolment>> = {
    [CARRIER]: enrolment(CARRIER, DIP),
    [COMP]: enrolment(COMP, STD, CARRIER)
  };
  vi.mocked(q.getApprEnrolment).mockImplementation((async (id: string) => rows[id] ?? null) as never);
  vi.mocked(q.getComponentEnrolment).mockResolvedValue(rows[COMP] as never);
  vi.mocked(q.getApprProgramme).mockImplementation((async (id: string) =>
    id === DIP
      ? { id: DIP, organizationId: ORG, type: 'DIPLOMA', title: 'Diploma', pairedProgrammeId: STD, status: 'ACTIVE' }
      : {
          id: STD,
          organizationId: ORG,
          type: 'STANDARD',
          title: 'Standard',
          pairedProgrammeId: null,
          status: 'ACTIVE'
        }) as never);
  vi.mocked(getPortfolio).mockImplementation((async (_a: Actor, id: string) =>
    id === CARRIER
      ? portfolio(CARRIER, DIP, 'Diploma', 80, 'ON_TARGET')
      : portfolio(COMP, STD, 'Standard', 40, 'BEHIND')) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOverview', () => {
  it('returns the frozen shape with one card per enrolment and a rolled-up overall', async () => {
    pairSetup();
    const o = await getOverview(admin, CARRIER);
    expect(o.cards.map((c) => [c.enrolmentId, c.role, c.type])).toEqual([
      [CARRIER, 'CARRIER', 'DIPLOMA'],
      [COMP, 'COMPONENT', 'STANDARD']
    ]);
    expect(o.cards[0]).toMatchObject({ unitsTotal: 2, unitsComplete: 1, withdrawnAt: null, achievedAt: null });
    expect(o.overall).toEqual({ actualPct: 60, status: 'BEHIND' });
    expect(o.otj).toEqual({
      doneMinutes: 250,
      expectedMinutes: 500,
      targetMinutes: 1000,
      completionPct: 25,
      status: 'ON_TARGET'
    });
    expect(o.breakdown.tasks.overdue).toBe(1);
    expect(o.onboarding).toEqual({ approved: 2, required: 3 });
    expect(o.nextReview?.id).toBe('r1');
    expect(o.learner.id).toBe(LRN);
    expect(o.canAddPair).toBeNull(); // already paired
  });

  it('resolves to the carrier when given the component id', async () => {
    pairSetup();
    const o = await getOverview(admin, COMP);
    expect(o.cards[0].enrolmentId).toBe(CARRIER);
    expect(o.cards).toHaveLength(2);
  });

  it('offers canAddPair to an admin for a lone diploma with an ACTIVE paired standard only', async () => {
    pairSetup();
    vi.mocked(q.getComponentEnrolment).mockResolvedValue(null);
    const o = await getOverview(admin, CARRIER);
    expect(o.cards).toHaveLength(1);
    expect(o.cards[0].role).toBe('STANDALONE');
    expect(o.canAddPair).toEqual({ programmeId: STD, title: 'Standard' });
  });

  it('gives canAddPair = null to tutors and learners, and when the standard is not ACTIVE', async () => {
    pairSetup();
    vi.mocked(q.getComponentEnrolment).mockResolvedValue(null);
    vi.mocked(q.isProgrammeTutor).mockReturnValue(true as never);
    expect((await getOverview(tutor, CARRIER)).canAddPair).toBeNull();
    expect((await getOverview(self, CARRIER)).canAddPair).toBeNull();
    vi.mocked(q.getApprProgramme).mockImplementation((async (id: string) =>
      id === DIP
        ? { id: DIP, organizationId: ORG, type: 'DIPLOMA', title: 'D', pairedProgrammeId: STD, status: 'ACTIVE' }
        : { id: STD, organizationId: ORG, type: 'STANDARD', title: 'S', status: 'ARCHIVED' }) as never);
    expect((await getOverview(admin, CARRIER)).canAddPair).toBeNull();
  });

  it('404s for another learner and for an unknown enrolment', async () => {
    pairSetup();
    await expect(getOverview(otherLearner, CARRIER)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getOverview(admin, 'nope')).rejects.toBeInstanceOf(AppError);
    expect(getPortfolio).not.toHaveBeenCalled();
  });
});
