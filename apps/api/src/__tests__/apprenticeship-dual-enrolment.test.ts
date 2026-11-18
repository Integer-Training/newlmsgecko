import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// Gecko Apprenticeships — Deploy 2: dual (Diploma + Standard) enrolment, the one-apprenticeship rule, link / unlink,
// learner-check, and the folded learners list. All DB access is mocked; the rules under test live in the service.

vi.mock('@cio/db/queries/apprenticeship', () => ({
  lockApprEnrolment: vi.fn(async () => null),
  moveOtjLogs: vi.fn(async () => 0),
  listLinkedUnitCounts: vi.fn(async () => new Map()),
  sumValidatedOtjLogMinutes: vi.fn(async () => 0),
  isProgrammeTutor: vi.fn(async () => false),
  isProgrammeTutorOfLinked: vi.fn(async () => false),
  getApprProgramme: vi.fn(),
  getApprEnrolment: vi.fn(),
  getApprEnrolmentByProgrammeLearner: vi.fn(async () => null),
  getApprProgrammeStructure: vi.fn(async () => ({ qualifications: [], units: [{ id: 'u1' }], criteria: [] })),
  insertApprEnrolment: vi.fn(),
  insertEnrolmentUnits: vi.fn(async () => undefined),
  insertApprReview: vi.fn(async () => ({ id: 'rev' })),
  listLearnerEnrolments: vi.fn(async () => []),
  lockLearnerEnrolments: vi.fn(async () => undefined),
  countOpenLinkedPairs: vi.fn(async () => 0),
  updateApprProgramme: vi.fn(async (_id: string, patch: object) => ({ id: 'p', ...patch })),
  listApprQualificationIds: vi.fn(async () => []),
  getLinkedEnrolment: vi.fn(async () => null),
  linkApprEnrolments: vi.fn(async () => true),
  unlinkApprEnrolment: vi.fn(async () => undefined),
  countCrossMappedEvidence: vi.fn(async () => 0),
  getOrgLearnerByEmail: vi.fn(async () => null),
  countRegularCourses: vi.fn(async () => 0),
  listEnrolmentRows: vi.fn(async () => []),
  getApprSettings: vi.fn(async () => ({ concernGapPct: 15, otjFactor: 0.2, otjWeeklyCapHours: 30 })),
  getEnrolmentOverview: vi.fn(),
  countEvidenceByCriterion: vi.fn(async () => new Map()),
  listCriterionAcceptedDates: vi.fn(async () => new Map()),
  getEvidenceTotals: vi.fn(async () => ({ submitted: 0, accepted: 0, referred: 0, otjMinutes: 0 })),
  listEnrolmentUnitRows: vi.fn(async () => []),
  sumGlhLogMinutes: vi.fn(async () => 0)
}));
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => false),
  getOrgMemberRoleId: vi.fn(async (_org: string, id: string) => (id === TUTOR ? 2 : 3))
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', () => ({
  runInTransaction: (fn: (tx: unknown) => unknown) => fn({ tx: true }),
  sql: (strings: TemplateStringsArray) => strings.join('?')
}));
vi.mock('@api/services/apprenticeship/progress', () => ({
  todayIso: () => '2026-06-01',
  recomputeEnrolment: vi.fn(async () => null)
}));
vi.mock('@api/services/apprenticeship/onboarding', () => ({ ensureOnboardingTypes: vi.fn(async () => undefined) }));
vi.mock('@api/services/apprenticeship/notifications', () => ({ notifyGatewayReadyOrRelease: vi.fn() }));
vi.mock('@api/services/organization/users', () => ({
  createOrgUser: vi.fn(async () => ({ userId: '99999999-9999-4999-8999-999999999999', temporaryPassword: 'Temp-pw-1' }))
}));
vi.mock('@api/services/organization/allocation', () => ({ createTutorAllocation: vi.fn(async () => undefined) }));
vi.mock('@api/middlewares/guards/ownership', () => ({ isAllocatedTutor: vi.fn(async () => false) }));

import * as q from '@cio/db/queries/apprenticeship';
import { recomputeEnrolment } from '@api/services/apprenticeship/progress';
import { recordAudit } from '@cio/db/audit';
import { createOrgUser } from '@api/services/organization/users';
import { createTutorAllocation } from '@api/services/organization/allocation';
import {
  checkLearner,
  createApprenticeship,
  createEnrolment,
  getPortfolio,
  linkEnrolment,
  listEnrolments,
  planEnrolmentPairing,
  resolveApprenticeship,
  unlinkEnrolment
} from '@api/services/apprenticeship/enrolment';
import { updateProgramme } from '@api/services/apprenticeship/programme';
import { AppError } from '@api/utils/errors';
import { ZApprenticeshipCreate, ZEnrolmentLink } from '@cio/utils/validation/apprenticeship';

const ORG = 'org-1';
const DIP = '11111111-1111-4111-8111-111111111111';
const STD = '11111111-1111-4111-8111-222222222222';
const DIP2 = '11111111-1111-4111-8111-333333333333';
const STD2 = '11111111-1111-4111-8111-444444444444';
const LRN = '22222222-2222-4222-8222-222222222222';
const TUTOR = '88888888-8888-4888-8888-888888888888';
const NOW = new Date('2026-06-01T10:00:00Z');

const admin = { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG } as Actor;
const tutor = { authenticated: true, userId: 'u-tutor', role: 'TUTOR', status: 'ACTIVE', orgId: ORG } as Actor;
const manager = { authenticated: true, userId: 'u-mgr', role: 'MANAGER', status: 'ACTIVE', orgId: ORG } as Actor;
const otherOrgAdmin = { ...admin, orgId: 'org-2' } as Actor;

const programmes: Record<string, Record<string, unknown>> = {
  [DIP]: { id: DIP, title: 'L3 Diploma', type: 'DIPLOMA', level: '3', pairedProgrammeId: STD },
  [STD]: { id: STD, title: 'L3 Standard', type: 'STANDARD', level: '3', pairedProgrammeId: null },
  [DIP2]: { id: DIP2, title: 'L3 Other Diploma', type: 'DIPLOMA', level: '3', pairedProgrammeId: STD2 },
  [STD2]: { id: STD2, title: 'L3 Other Standard', type: 'STANDARD', level: '3', pairedProgrammeId: null }
};

const ref = (o: Record<string, unknown>) => ({
  id: 'e-open',
  programmeId: DIP,
  programmeTitle: 'L3 Diploma',
  type: 'DIPLOMA',
  level: '3',
  pairedProgrammeId: STD,
  pairedProgrammeTitle: 'L3 Standard',
  primaryEnrolmentId: null,
  componentId: null,
  achievedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...o
});

async function status(p: Promise<unknown>) {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof AppError ? e.statusCode : 500;
  }
}

let seq = 0;
beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  vi.mocked(q.getApprProgramme).mockImplementation((async (id: string) => {
    const p = programmes[id];
    return p ? { organizationId: ORG, status: 'ACTIVE', reviewIntervalWeeks: 12, ...p } : null;
  }) as never);
  vi.mocked(q.insertApprEnrolment).mockImplementation((async (_tx: unknown, v: object) => ({
    id: `enr-${++seq}`,
    ...v
  })) as never);
  vi.mocked(q.listLearnerEnrolments).mockResolvedValue([]);
  vi.mocked(q.getApprEnrolmentByProgrammeLearner).mockResolvedValue(null);
  vi.mocked(q.countOpenLinkedPairs).mockResolvedValue(0);
});

const dates = { startDate: '2026-06-01', plannedEndDate: '2027-06-01' };
const pairInput = (over: Record<string, unknown> = {}) =>
  ({
    learner: { learnerId: LRN },
    tutorId: TUTOR,
    contractedHoursWeek: 30,
    otjTargetMinutesOverride: 5000,
    enrolments: [
      { programmeId: STD, ...dates },
      { programmeId: DIP, ...dates }
    ],
    ...over
  }) as never;

describe('planEnrolmentPairing (the one-apprenticeship rule)', () => {
  const diploma = { id: DIP, title: 'L3 Diploma', type: 'DIPLOMA', pairedProgrammeId: STD };
  const standard = { id: STD, title: 'L3 Standard', type: 'STANDARD', pairedProgrammeId: null };

  it('a learner with nothing open links to nothing', () => {
    expect(planEnrolmentPairing([diploma], [])).toEqual({ linkToEnrolmentId: null });
  });

  it('a second open enrolment of the same type is refused', () => {
    const open = [ref({ type: 'DIPLOMA', programmeTitle: 'Other diploma' })] as never;
    expect(planEnrolmentPairing([diploma], open)).toMatchObject({ error: expect.stringContaining('open diploma') });
    const openStd = [ref({ type: 'STANDARD', programmeId: STD2 })] as never;
    expect(planEnrolmentPairing([standard], openStd)).toMatchObject({
      error: expect.stringContaining('open standard')
    });
  });

  it('the paired standard auto-links to the open diploma (which stays the carrier)', () => {
    const open = [ref({ id: 'dip-enr', programmeId: DIP, pairedProgrammeId: STD })] as never;
    expect(planEnrolmentPairing([standard], open)).toEqual({ linkToEnrolmentId: 'dip-enr' });
  });

  it('a standard the diploma is NOT paired to is refused, naming the paired one', () => {
    const open = [
      ref({
        programmeId: DIP2,
        programmeTitle: 'L3 Other Diploma',
        pairedProgrammeId: STD2,
        pairedProgrammeTitle: 'L3 Other Standard'
      })
    ] as never;
    expect(planEnrolmentPairing([standard], open)).toEqual({
      error: 'A learner on L3 Other Diploma can only be on its paired standard, L3 Other Standard'
    });
  });

  it('a diploma paired to another standard is refused when the learner already holds a standard', () => {
    const open = [
      ref({ type: 'STANDARD', programmeId: STD2, programmeTitle: 'L3 Other Standard', pairedProgrammeId: null })
    ] as never;
    expect(planEnrolmentPairing([diploma], open)).toMatchObject({ error: expect.stringContaining('not paired with') });
  });

  it('an open enrolment already in a pair is not linked to again', () => {
    const open = [ref({ id: 'dip-enr', componentId: 'someone' })] as never;
    expect(planEnrolmentPairing([standard], open)).toEqual({ linkToEnrolmentId: null });
  });
});

describe('createApprenticeship', () => {
  it('Diploma + Standard together: the diploma carries, the standard is its component, ONE audit', async () => {
    const res = await createApprenticeship(admin, pairInput());
    expect(res.enrolments).toEqual([
      { id: 'enr-1', programmeId: DIP, role: 'CARRIER' },
      { id: 'enr-2', programmeId: STD, role: 'COMPONENT' }
    ]);
    const [carrierCall, componentCall] = vi.mocked(q.insertApprEnrolment).mock.calls.map((c) => c[1]);
    expect(carrierCall).toMatchObject({
      programmeId: DIP,
      primaryEnrolmentId: null,
      contractedHoursWeek: 30,
      otjTargetMinutesOverride: 5000
    });
    // learner-level targets are on the carrier only
    expect(componentCall).toMatchObject({
      programmeId: STD,
      primaryEnrolmentId: 'enr-1',
      contractedHoursWeek: null,
      otjTargetMinutesOverride: null
    });
    // the first review is on the carrier only
    expect(q.insertApprReview).toHaveBeenCalledTimes(1);
    expect(vi.mocked(q.insertApprReview).mock.calls[0][1]).toMatchObject({ enrolmentId: 'enr-1' });
    expect(q.insertEnrolmentUnits).toHaveBeenCalledTimes(2);
    expect(createTutorAllocation).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordAudit).mock.calls[0][0]).toMatchObject({ action: 'appr.apprenticeship.created' });
  });

  it('a new learner is created once and the temporary password is returned', async () => {
    const res = await createApprenticeship(
      admin,
      pairInput({ learner: { firstName: 'Amy', lastName: 'A', email: 'amy@example.com' } })
    );
    expect(createOrgUser).toHaveBeenCalledTimes(1);
    expect(res.temporaryPassword).toBe('Temp-pw-1');
    expect(res.learnerId).toBe('99999999-9999-4999-8999-999999999999');
  });

  it('diploma only and standard only are standalone', async () => {
    const one = await createApprenticeship(admin, pairInput({ enrolments: [{ programmeId: DIP, ...dates }] }));
    expect(one.enrolments).toEqual([{ id: 'enr-1', programmeId: DIP, role: 'STANDALONE' }]);
    expect(q.insertApprReview).toHaveBeenCalledTimes(1);
    const two = await createApprenticeship(admin, pairInput({ enrolments: [{ programmeId: STD, ...dates }] }));
    expect(two.enrolments[0].role).toBe('STANDALONE');
  });

  it('a diploma and a standard that are not paired together is a 400 BEFORE any account is created', async () => {
    const res = await status(
      createApprenticeship(
        admin,
        pairInput({
          learner: { firstName: 'Amy', lastName: 'A', email: 'amy@example.com' },
          enrolments: [
            { programmeId: DIP, ...dates },
            { programmeId: STD2, ...dates }
          ]
        })
      )
    );
    expect(res).toBe(400);
    expect(createOrgUser).not.toHaveBeenCalled();
    expect(q.insertApprEnrolment).not.toHaveBeenCalled();
  });

  it('two diplomas are a 400', async () => {
    const res = await status(
      createApprenticeship(
        admin,
        pairInput({
          enrolments: [
            { programmeId: DIP, ...dates },
            { programmeId: DIP2, ...dates }
          ]
        })
      )
    );
    expect(res).toBe(400);
  });

  it('adds the paired standard to a learner already on the diploma as its COMPONENT, with no new review or hours', async () => {
    vi.mocked(q.listLearnerEnrolments).mockResolvedValue([ref({ id: 'dip-enr' })] as never);
    const res = await createApprenticeship(admin, pairInput({ enrolments: [{ programmeId: STD, ...dates }] }));
    expect(res.enrolments).toEqual([{ id: 'enr-1', programmeId: STD, role: 'COMPONENT' }]);
    expect(vi.mocked(q.insertApprEnrolment).mock.calls[0][1]).toMatchObject({
      primaryEnrolmentId: 'dip-enr',
      contractedHoursWeek: null,
      otjTargetMinutesOverride: null
    });
    expect(q.insertApprReview).not.toHaveBeenCalled();
  });

  it('adds a diploma to a standard-only learner: the first enrolment stays the carrier', async () => {
    vi.mocked(q.listLearnerEnrolments).mockResolvedValue([
      ref({ id: 'std-enr', type: 'STANDARD', programmeId: STD, programmeTitle: 'L3 Standard', pairedProgrammeId: null })
    ] as never);
    const res = await createApprenticeship(admin, pairInput({ enrolments: [{ programmeId: DIP, ...dates }] }));
    expect(res.enrolments[0].role).toBe('COMPONENT');
    expect(vi.mocked(q.insertApprEnrolment).mock.calls[0][1]).toMatchObject({ primaryEnrolmentId: 'std-enr' });
  });

  it('a second open diploma is refused (400) even for an existing learner; an achieved one does not count', async () => {
    vi.mocked(q.listLearnerEnrolments).mockResolvedValue([ref({ programmeId: DIP2 })] as never);
    expect(await status(createApprenticeship(admin, pairInput({ enrolments: [{ programmeId: DIP, ...dates }] })))).toBe(
      400
    );
    vi.mocked(q.listLearnerEnrolments).mockResolvedValue([
      ref({ programmeId: DIP2, achievedAt: '2026-01-01T00:00:00Z' })
    ] as never);
    expect(await status(createApprenticeship(admin, pairInput({ enrolments: [{ programmeId: DIP, ...dates }] })))).toBe(
      200
    );
  });

  it('already on this programme is 409', async () => {
    vi.mocked(q.getApprEnrolmentByProgrammeLearner).mockResolvedValue({ id: 'x' } as never);
    expect(await status(createApprenticeship(admin, pairInput()))).toBe(409);
  });

  it('a unique-constraint race rolls back as 409', async () => {
    vi.mocked(q.insertApprEnrolment).mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    expect(await status(createApprenticeship(admin, pairInput()))).toBe(409);
  });

  describe('per-learner lock (concurrent enrols)', () => {
    const order = (fn: unknown) => vi.mocked(fn as never).mock.invocationCallOrder;

    it('locks the learner inside the transaction BEFORE the checks and the inserts', async () => {
      await createApprenticeship(admin, pairInput());
      expect(q.lockLearnerEnrolments).toHaveBeenCalledWith({ tx: true }, LRN);
      const lock = order(q.lockLearnerEnrolments)[0];
      // the in-transaction re-checks (they receive the tx client) come after the lock
      const txList = vi.mocked(q.listLearnerEnrolments).mock.calls.findIndex((c) => (c as unknown[])[2] !== undefined);
      expect(txList).toBeGreaterThanOrEqual(0);
      expect(order(q.listLearnerEnrolments)[txList]).toBeGreaterThan(lock);
      expect(order(q.getApprEnrolmentByProgrammeLearner).at(-1)).toBeGreaterThan(lock);
      expect(order(q.insertApprEnrolment)[0]).toBeGreaterThan(lock);
    });

    it('a brand-new learner is locked under the new account id too (one uniform path)', async () => {
      await createApprenticeship(
        admin,
        pairInput({ learner: { firstName: 'Nia', lastName: 'New', email: 'nia@example.com' } })
      );
      expect(q.lockLearnerEnrolments).toHaveBeenCalledWith({ tx: true }, '99999999-9999-4999-8999-999999999999');
    });

    it('a rival enrol that committed between the early check and the lock is caught: 400, nothing inserted', async () => {
      // early (no tx client) read sees nothing; the read under the lock sees the other request's open diploma
      vi.mocked(q.listLearnerEnrolments).mockImplementation((async (_o: string, _l: string, client?: unknown) =>
        client ? [ref({ id: 'rival', programmeId: DIP2 })] : []) as never);
      expect(
        await status(createApprenticeship(admin, pairInput({ enrolments: [{ programmeId: DIP, ...dates }] })))
      ).toBe(400);
      expect(q.insertApprEnrolment).not.toHaveBeenCalled();
    });

    it('a rival that enrolled the same programme under the lock is 409 already enrolled', async () => {
      vi.mocked(q.getApprEnrolmentByProgrammeLearner).mockImplementation((async (
        _p: string,
        _l: string,
        client?: unknown
      ) => (client ? { id: 'rival' } : null)) as never);
      await expect(createApprenticeship(admin, pairInput())).rejects.toMatchObject({
        statusCode: 409,
        message: 'This learner is already enrolled on this programme'
      });
      expect(q.insertApprEnrolment).not.toHaveBeenCalled();
    });

    it('a duplicate carrier link (primary_enrolment_id unique index) is 409 "already has a linked qualification"', async () => {
      vi.mocked(q.listLearnerEnrolments).mockResolvedValue([ref({ id: 'dip-enr' })] as never);
      vi.mocked(q.insertApprEnrolment).mockRejectedValue(
        Object.assign(new Error('dup'), { code: '23505', constraint_name: 'appr_enrolment_primary_unique' })
      );
      await expect(
        createApprenticeship(admin, pairInput({ enrolments: [{ programmeId: STD, ...dates }] }))
      ).rejects.toMatchObject({
        statusCode: 409,
        message: 'This apprenticeship already has a linked qualification'
      });
    });
  });

  it('admin only: tutors and managers 403; an admin of another org cannot see the programme (404)', async () => {
    expect(await status(createApprenticeship(tutor, pairInput()))).toBe(403);
    expect(await status(createApprenticeship(manager, pairInput()))).toBe(403);
    expect(await status(createApprenticeship(otherOrgAdmin, pairInput()))).toBe(404);
  });

  it('an archived programme is a 400', async () => {
    vi.mocked(q.getApprProgramme).mockResolvedValueOnce({
      ...programmes[STD],
      organizationId: ORG,
      status: 'ARCHIVED'
    } as never);
    expect(await status(createApprenticeship(admin, pairInput()))).toBe(400);
  });

  it('validation: 1-2 enrolments, distinct programmes, end on or after start', () => {
    const base = { learner: { learnerId: LRN }, tutorId: TUTOR };
    expect(ZApprenticeshipCreate.safeParse({ ...base, enrolments: [] }).success).toBe(false);
    expect(
      ZApprenticeshipCreate.safeParse({
        ...base,
        enrolments: [
          { programmeId: DIP, ...dates },
          { programmeId: DIP, ...dates }
        ]
      }).success
    ).toBe(false);
    expect(
      ZApprenticeshipCreate.safeParse({
        ...base,
        enrolments: [{ programmeId: DIP, startDate: '2026-06-01', plannedEndDate: '2026-01-01' }]
      }).success
    ).toBe(false);
    expect(ZEnrolmentLink.safeParse({ enrolmentId: 'nope' }).success).toBe(false);
  });
});

describe('legacy createEnrolment', () => {
  it('keeps its response shape and auto-links as the component of an existing open enrolment', async () => {
    vi.mocked(q.listLearnerEnrolments).mockResolvedValue([ref({ id: 'dip-enr' })] as never);
    const res = await createEnrolment(admin, {
      programmeId: STD,
      learner: { learnerId: LRN },
      tutorId: TUTOR,
      ...dates
    } as never);
    expect(res).toEqual({ id: 'enr-1', learnerId: LRN, programmeId: STD });
    expect(vi.mocked(q.insertApprEnrolment).mock.calls[0][1]).toMatchObject({ primaryEnrolmentId: 'dip-enr' });
    expect(vi.mocked(recordAudit).mock.calls[0][0]).toMatchObject({ action: 'appr.enrolment.created' });
  });

  it('applies the pairing rule: an unrelated standard for a learner on a diploma is a 400 on programmeId', async () => {
    vi.mocked(q.listLearnerEnrolments).mockResolvedValue([ref({})] as never);
    const err = await createEnrolment(admin, {
      programmeId: STD2,
      learner: { learnerId: LRN },
      tutorId: TUTOR,
      ...dates
    } as never).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(400);
    expect(err.field).toBe('programmeId');
  });
});

describe('resolveApprenticeship / link / unlink', () => {
  const row = (o: Record<string, unknown>) => ({
    organizationId: ORG,
    learnerId: LRN,
    programmeId: DIP,
    primaryEnrolmentId: null,
    ...o
  });

  it('resolves either half to { carrier, component }', async () => {
    vi.mocked(q.getApprEnrolment).mockImplementation((async (id: string) =>
      id === 'carrier'
        ? row({ id: 'carrier' })
        : id === 'component'
          ? row({ id: 'component', programmeId: STD, primaryEnrolmentId: 'carrier' })
          : null) as never);
    vi.mocked(q.getLinkedEnrolment).mockResolvedValue(
      row({ id: 'component', programmeId: STD, primaryEnrolmentId: 'carrier' }) as never
    );
    const fromCarrier = await resolveApprenticeship('carrier');
    expect([fromCarrier.carrier.id, fromCarrier.component?.id]).toEqual(['carrier', 'component']);
    const fromComponent = await resolveApprenticeship('component');
    expect([fromComponent.carrier.id, fromComponent.component?.id]).toEqual(['carrier', 'component']);
    vi.mocked(q.getLinkedEnrolment).mockResolvedValue(null);
    expect((await resolveApprenticeship('carrier')).component).toBeNull();
    expect(await status(resolveApprenticeship('missing'))).toBe(404);
  });

  describe('link', () => {
    const A = '33333333-3333-4333-8333-333333333333';
    const B = '33333333-3333-4333-8333-444444444444';
    beforeEach(() => {
      vi.mocked(q.getApprEnrolment).mockImplementation((async (id: string) =>
        id === A ? row({ id: A }) : id === B ? row({ id: B, programmeId: STD }) : null) as never);
      vi.mocked(q.listLearnerEnrolments).mockResolvedValue([
        ref({ id: A, programmeId: DIP, createdAt: '2026-01-01T00:00:00Z' }),
        ref({ id: B, type: 'STANDARD', programmeId: STD, pairedProgrammeId: null, createdAt: '2026-02-01T00:00:00Z' })
      ] as never);
    });

    it('links two standalone enrolments; the earlier one carries, whichever id is in the path', async () => {
      expect(await linkEnrolment(admin, B, { enrolmentId: A })).toEqual({ carrierId: A, componentId: B });
      expect(q.linkApprEnrolments).toHaveBeenCalledWith({ tx: true }, A, B);
      expect(vi.mocked(recordAudit).mock.calls[0][0]).toMatchObject({ action: 'appr.enrolment.linked' });
    });

    it('locks both rows in id order, moves the component logs to the carrier and recomputes the pair in the same tx', async () => {
      await linkEnrolment(admin, B, { enrolmentId: A });
      // Lock order is ascending id whichever half the caller named, and happens before the link is written.
      expect(vi.mocked(q.lockApprEnrolment).mock.calls.map((c) => c[1])).toEqual([A, B]);
      expect(vi.mocked(q.lockApprEnrolment).mock.invocationCallOrder[1]).toBeLessThan(
        vi.mocked(q.linkApprEnrolments).mock.invocationCallOrder[0]
      );
      expect(q.moveOtjLogs).toHaveBeenCalledWith({ tx: true }, B, A);
      expect(recomputeEnrolment).toHaveBeenCalledWith({ tx: true }, A, { claimGatewayReady: true });
      const order = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
      expect(order(q.linkApprEnrolments)).toBeLessThan(order(q.moveOtjLogs));
      expect(order(q.moveOtjLogs)).toBeLessThan(order(recomputeEnrolment));
    });

    it('locks the learner inside the transaction before reading the enrolments it checks', async () => {
      await linkEnrolment(admin, A, { enrolmentId: B });
      expect(q.lockLearnerEnrolments).toHaveBeenCalledWith({ tx: true }, LRN);
      const lock = vi.mocked(q.lockLearnerEnrolments).mock.invocationCallOrder[0];
      const txRead = vi.mocked(q.listLearnerEnrolments).mock.calls.findIndex((c) => (c as unknown[])[2] !== undefined);
      expect(txRead).toBeGreaterThanOrEqual(0);
      expect(vi.mocked(q.listLearnerEnrolments).mock.invocationCallOrder[txRead]).toBeGreaterThan(lock);
      expect(vi.mocked(q.linkApprEnrolments).mock.invocationCallOrder[0]).toBeGreaterThan(lock);
    });

    it('a duplicate carrier link is 409 "already has a linked qualification"', async () => {
      vi.mocked(q.linkApprEnrolments).mockRejectedValue(
        Object.assign(new Error('dup'), { code: '23505', constraint_name: 'appr_enrolment_primary_unique' })
      );
      await expect(linkEnrolment(admin, A, { enrolmentId: B })).rejects.toMatchObject({
        statusCode: 409,
        message: 'This apprenticeship already has a linked qualification'
      });
    });

    it('refuses: other learner (400), same enrolment (400), already linked (409), unpaired programmes (400)', async () => {
      vi.mocked(q.getApprEnrolment).mockImplementation((async (id: string) =>
        id === A ? row({ id: A }) : row({ id: B, learnerId: 'someone-else' })) as never);
      expect(await status(linkEnrolment(admin, A, { enrolmentId: B }))).toBe(400);
      expect(await status(linkEnrolment(admin, A, { enrolmentId: A }))).toBe(400);

      vi.mocked(q.getApprEnrolment).mockImplementation((async (id: string) =>
        id === A ? row({ id: A }) : row({ id: B, programmeId: STD })) as never);
      vi.mocked(q.listLearnerEnrolments).mockResolvedValue([
        ref({ id: A, componentId: 'x' }),
        ref({ id: B, type: 'STANDARD', programmeId: STD, pairedProgrammeId: null })
      ] as never);
      expect(await status(linkEnrolment(admin, A, { enrolmentId: B }))).toBe(409);

      vi.mocked(q.listLearnerEnrolments).mockResolvedValue([
        ref({ id: A, programmeId: DIP, pairedProgrammeId: STD2 }),
        ref({ id: B, type: 'STANDARD', programmeId: STD, pairedProgrammeId: null })
      ] as never);
      expect(await status(linkEnrolment(admin, A, { enrolmentId: B }))).toBe(400);
      expect(q.linkApprEnrolments).not.toHaveBeenCalled();
    });

    it('admin only; another org gets 404', async () => {
      expect(await status(linkEnrolment(tutor, A, { enrolmentId: B }))).toBe(403);
      expect(await status(linkEnrolment(otherOrgAdmin, A, { enrolmentId: B }))).toBe(404);
    });
  });

  describe('unlink', () => {
    beforeEach(() => {
      vi.mocked(q.getApprEnrolment).mockImplementation((async (id: string) =>
        id === 'carrier'
          ? row({ id: 'carrier' })
          : row({ id: 'component', programmeId: STD, primaryEnrolmentId: 'carrier' })) as never);
      vi.mocked(q.getLinkedEnrolment).mockResolvedValue(
        row({ id: 'component', programmeId: STD, primaryEnrolmentId: 'carrier' }) as never
      );
    });

    it('splits the pair (either id works)', async () => {
      expect(await unlinkEnrolment(admin, 'component')).toEqual({ carrierId: 'carrier', componentId: 'component' });
      expect(q.unlinkApprEnrolment).toHaveBeenCalledWith({ tx: true }, 'component');
      expect(vi.mocked(recordAudit).mock.calls[0][0]).toMatchObject({ action: 'appr.enrolment.unlinked' });
    });

    it('locks the pair, re-checks cross-mapping in the tx, and re-derives BOTH halves after the split (logs stay on the carrier)', async () => {
      await unlinkEnrolment(admin, 'component');
      expect(vi.mocked(q.lockApprEnrolment).mock.calls.map((c) => c[1])).toEqual(['carrier', 'component']);
      expect(vi.mocked(q.countCrossMappedEvidence).mock.calls[0][2]).toEqual({ tx: true });
      expect(vi.mocked(recomputeEnrolment).mock.calls.map((c) => c[1])).toEqual(['carrier', 'component']);
      const order = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
      expect(order(q.unlinkApprEnrolment)).toBeLessThan(order(recomputeEnrolment));
      expect(q.moveOtjLogs).not.toHaveBeenCalled();
    });

    it('409 while evidence maps across the pair, and nothing is written', async () => {
      vi.mocked(q.countCrossMappedEvidence).mockResolvedValue(3);
      expect(await status(unlinkEnrolment(admin, 'carrier'))).toBe(409);
      expect(q.unlinkApprEnrolment).not.toHaveBeenCalled();
      expect(recomputeEnrolment).not.toHaveBeenCalled();
    });

    it('400 for an enrolment that is not linked; admin only', async () => {
      vi.mocked(q.getLinkedEnrolment).mockResolvedValue(null);
      expect(await status(unlinkEnrolment(admin, 'carrier'))).toBe(400);
      expect(await status(unlinkEnrolment(tutor, 'carrier'))).toBe(403);
    });
  });
});

describe('checkLearner', () => {
  it('describes an existing learner by id: apprenticeships, state and regular courses', async () => {
    vi.mocked(q.listLearnerEnrolments).mockResolvedValue([
      ref({ id: 'e1' }),
      ref({ id: 'e2', type: 'STANDARD', achievedAt: '2026-01-01T00:00:00Z' })
    ] as never);
    vi.mocked(q.countRegularCourses).mockResolvedValue(2);
    expect(await checkLearner(admin, { learnerId: LRN })).toEqual({
      exists: true,
      learnerId: LRN,
      apprenticeship: [
        {
          enrolmentId: 'e1',
          programmeId: expect.any(String),
          programmeTitle: 'L3 Diploma',
          type: 'DIPLOMA',
          level: '3',
          state: 'active'
        },
        {
          enrolmentId: 'e2',
          programmeId: expect.any(String),
          programmeTitle: 'L3 Diploma',
          type: 'STANDARD',
          level: '3',
          state: 'achieved'
        }
      ],
      regularCourses: 2
    });
  });

  it('finds by email; an unknown email (or another org) is simply "does not exist"', async () => {
    vi.mocked(q.getOrgLearnerByEmail).mockResolvedValueOnce({ id: LRN } as never);
    expect((await checkLearner(admin, { email: 'a@b.co' })).exists).toBe(true);
    expect(await checkLearner(admin, { email: 'nobody@b.co' })).toEqual({
      exists: false,
      apprenticeship: [],
      regularCourses: 0
    });
    expect(q.getOrgLearnerByEmail).toHaveBeenCalledWith(ORG, 'a@b.co');
  });

  it('admin only', async () => {
    expect(await status(checkLearner(tutor, { learnerId: LRN }))).toBe(403);
  });
});

describe('learners list folds a pair into one row', () => {
  const listRow = (o: Record<string, unknown> = {}) => ({
    id: 'carrier',
    programmeId: DIP,
    programmeTitle: 'L3 Diploma',
    programmeType: 'DIPLOMA',
    linked: null,
    learnerId: LRN,
    learnerName: 'Amy Apprentice',
    learnerEmail: 'amy@example.com',
    startDate: '2026-01-01',
    plannedEndDate: '2027-01-01',
    contractedHoursWeek: 30,
    otjTargetMinutesOverride: 1000,
    achievedAt: null,
    actualPct: 40,
    otjMinutes: 100,
    tutors: [],
    onboarding: null,
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
  const query = { page: 1, pageSize: 25 };

  it('a linked row carries programmeType, the component as `linked`, and an `overall` roll-up (average, worst status)', async () => {
    vi.mocked(q.listEnrolmentRows).mockResolvedValue([
      listRow({
        linked: {
          id: 'component',
          programmeId: STD,
          programmeTitle: 'L3 Standard',
          programmeType: 'STANDARD',
          startDate: '2026-01-01',
          plannedEndDate: '2027-01-01',
          actualPct: 20,
          achievedAt: null
        }
      })
    ] as never);
    const { items, total } = await listEnrolments(admin, query as never, NOW);
    expect(total).toBe(1);
    const [item] = items;
    expect(item.programmeType).toBe('DIPLOMA');
    expect(item.linked).toMatchObject({ id: 'component', programmeId: STD, type: 'STANDARD', actualPct: 20 });
    expect(item.overall.actualPct).toBe(30);
    expect(item.overall.status).toBe(worst(item.status, item.linked!.status));
  });

  it('a linked pair gateway readiness counts the component units too (AUTO_UNITS across both qualifications)', async () => {
    const unitsOnly = [{ key: 'units', label: 'All units complete', kind: 'AUTO_UNITS' }];
    const carrierRow = listRow({
      id: 'carrier',
      gatewayChecklist: unitsOnly,
      unitsTotal: 2,
      unitsComplete: 2,
      linked: {
        id: 'component',
        programmeId: STD,
        programmeTitle: 'L3 Standard',
        programmeType: 'STANDARD',
        actualPct: 20
      }
    });
    vi.mocked(q.listEnrolmentRows).mockResolvedValue([carrierRow] as never);
    vi.mocked(q.listLinkedUnitCounts).mockResolvedValue(new Map([['carrier', { total: 3, complete: 1 }]]));
    expect((await listEnrolments(admin, query as never, NOW)).items[0].gatewayReady).toBe(false);
    expect(q.listLinkedUnitCounts).toHaveBeenCalledWith(['carrier']);
    vi.mocked(q.listLinkedUnitCounts).mockResolvedValue(new Map([['carrier', { total: 3, complete: 3 }]]));
    expect((await listEnrolments(admin, query as never, NOW)).items[0].gatewayReady).toBe(true);
  });

  it('status filter and counts use the rolled-up overall.status for a linked row (own status for an unlinked one)', async () => {
    // At NOW the expected % is ~41. The carrier's 60% is ahead of plan; its component's 5% is far behind (concern).
    const component = {
      id: 'component',
      programmeId: STD,
      programmeTitle: 'L3 Standard',
      programmeType: 'STANDARD',
      startDate: '2026-01-01',
      plannedEndDate: '2027-01-01',
      actualPct: 5,
      achievedAt: null
    };
    vi.mocked(q.listEnrolmentRows).mockResolvedValue([
      listRow({ id: 'pair', learnerName: 'Amy', actualPct: 60, linked: component }),
      listRow({ id: 'solo', learnerName: 'Bea', actualPct: 60 })
    ] as never);
    const all = await listEnrolments(admin, query as never, NOW);
    const pair = all.items.find((i) => i.id === 'pair')!;
    expect(pair.status).toBe('ON_TARGET'); // the carrier's own
    expect(pair.overall.status).toBe('CONCERN'); // what the chip shows
    expect(all.statusCounts).toMatchObject({ ON_TARGET: 1, CONCERN: 1 });

    const concern = await listEnrolments(admin, { ...query, status: 'CONCERN' } as never, NOW);
    expect(concern.items.map((i) => i.id)).toEqual(['pair']);
    const onTarget = await listEnrolments(admin, { ...query, status: 'ON_TARGET' } as never, NOW);
    expect(onTarget.items.map((i) => i.id)).toEqual(['solo']);
    // counts are taken BEFORE the status filter
    expect(concern.statusCounts).toEqual(all.statusCounts);
  });

  it('type=BOTH returns only linked pairs, with total, pages and statusCounts over the pairs only', async () => {
    const component = {
      id: 'component',
      programmeId: STD,
      programmeTitle: 'L3 Standard',
      programmeType: 'STANDARD',
      startDate: '2026-01-01',
      plannedEndDate: '2027-01-01',
      actualPct: 5,
      achievedAt: null
    };
    vi.mocked(q.listEnrolmentRows).mockResolvedValue([
      listRow({ id: 'pair1', learnerName: 'Amy', actualPct: 60, linked: component }),
      listRow({ id: 'pair2', learnerName: 'Cat', actualPct: 60, linked: component }),
      listRow({ id: 'solo', learnerName: 'Bea', actualPct: 60 })
    ] as never);
    const res = await listEnrolments(admin, { ...query, type: 'BOTH', pageSize: 1 } as never, NOW);
    expect(res.total).toBe(2);
    expect(res.items.map((i) => i.id)).toEqual(['pair1']);
    expect(res.statusCounts).toMatchObject({ CONCERN: 2, ON_TARGET: 0 });
    const p2 = await listEnrolments(admin, { ...query, type: 'BOTH', pageSize: 1, page: 2 } as never, NOW);
    expect(p2.items.map((i) => i.id)).toEqual(['pair2']);
    // BOTH is not a programme type: the DB-level type filter must not receive it
    expect(vi.mocked(q.listEnrolmentRows).mock.calls.at(-1)![0]).toMatchObject({ type: undefined });
  });

  it('an unlinked row has linked null and overall equal to its own numbers', async () => {
    vi.mocked(q.listEnrolmentRows).mockResolvedValue([listRow()] as never);
    const { items } = await listEnrolments(admin, query as never, NOW);
    expect(items[0].linked).toBeNull();
    expect(items[0].overall).toEqual({ actualPct: 40, status: items[0].status });
  });

  it('passes programmeId and type through to the query scope', async () => {
    vi.mocked(q.listEnrolmentRows).mockResolvedValue([]);
    await listEnrolments(admin, { ...query, programmeId: STD, type: 'STANDARD' } as never, NOW);
    expect(vi.mocked(q.listEnrolmentRows).mock.calls[0][0]).toMatchObject({ programmeId: STD, type: 'STANDARD' });
  });
});

const RANK = ['COMPLETE', 'ON_TARGET', 'NOT_SET', 'BEHIND', 'CONCERN'];
function worst(a: string, b: string) {
  return RANK.indexOf(a) >= RANK.indexOf(b) ? a : b;
}

describe('portfolio gains programme.type and linked', () => {
  const overview = (o: Record<string, unknown>) => ({
    enrolment: {
      id: 'carrier',
      organizationId: ORG,
      learnerId: LRN,
      programmeId: DIP,
      primaryEnrolmentId: null,
      startDate: '2026-01-01',
      plannedEndDate: '2027-01-01',
      contractedHoursWeek: 30,
      otjTargetMinutesOverride: null,
      gatewayItems: {}
    },
    learnerName: 'Amy',
    learnerEmail: 'amy@example.com',
    programmeTitle: 'L3 Diploma',
    programmeReference: null,
    programmeLevel: '3',
    programmeType: 'DIPLOMA',
    counterpart: null,
    tutors: [],
    overdueTaskCount: 0,
    nextReview: null,
    gatewayChecklist: null,
    ...o
  });
  beforeEach(() => {
    vi.mocked(q.getApprProgrammeStructure).mockResolvedValue({ qualifications: [], units: [], criteria: [] } as never);
  });

  it('the carrier sees its component as the counterpart', async () => {
    vi.mocked(q.getEnrolmentOverview).mockResolvedValue(
      overview({
        counterpart: { enrolmentId: 'component', programmeId: STD, title: 'L3 Standard', type: 'STANDARD' }
      }) as never
    );
    const portfolio = await getPortfolio(admin, 'carrier');
    expect(portfolio.programme.type).toBe('DIPLOMA');
    expect(portfolio.linked).toEqual({
      role: 'CARRIER',
      carrierId: 'carrier',
      counterpart: { enrolmentId: 'component', programmeId: STD, title: 'L3 Standard', type: 'STANDARD' }
    });
  });

  it('the gateway counts the counterpart units too: ready only when both halves are complete', async () => {
    const unitsOnly = [{ key: 'units', label: 'All units complete', kind: 'AUTO_UNITS' }];
    vi.mocked(q.getEnrolmentOverview).mockResolvedValue(
      overview({
        gatewayChecklist: unitsOnly,
        counterpart: { enrolmentId: 'component', programmeId: STD, title: 'L3 Standard', type: 'STANDARD' }
      }) as never
    );
    vi.mocked(q.listEnrolmentUnitRows).mockImplementation((async (id: string) =>
      id === 'component' ? [{ completedAt: '2026-05-01' }, { completedAt: null }] : []) as never);
    expect((await getPortfolio(admin, 'carrier')).gateway.ready).toBe(false);
    vi.mocked(q.listEnrolmentUnitRows).mockImplementation((async (id: string) =>
      id === 'component' ? [{ completedAt: '2026-05-01' }, { completedAt: '2026-05-02' }] : []) as never);
    expect((await getPortfolio(admin, 'carrier')).gateway.ready).toBe(true);
  });

  it('the component sees its carrier; an unlinked enrolment has linked null', async () => {
    const component = overview({
      enrolment: { ...overview({}).enrolment, id: 'component', programmeId: STD, primaryEnrolmentId: 'carrier' },
      programmeType: 'STANDARD',
      counterpart: { enrolmentId: 'carrier', programmeId: DIP, title: 'L3 Diploma', type: 'DIPLOMA' }
    });
    vi.mocked(q.getEnrolmentOverview).mockResolvedValue(component as never);
    const portfolio = await getPortfolio(admin, 'component');
    expect(portfolio.programme.type).toBe('STANDARD');
    expect(portfolio.linked).toMatchObject({
      role: 'COMPONENT',
      carrierId: 'carrier',
      counterpart: { enrolmentId: 'carrier' }
    });

    vi.mocked(q.getEnrolmentOverview).mockResolvedValue(overview({}) as never);
    expect((await getPortfolio(admin, 'carrier')).linked).toBeNull();
  });
});

describe('changing or clearing a diploma pair is blocked while learners are on both (checkPairChange)', () => {
  it('409 "N learners are on both" when the pair changes or is cleared and linked pairs exist', async () => {
    vi.mocked(q.countOpenLinkedPairs).mockResolvedValue(2);
    const err = await updateProgramme(admin, DIP, { pairedProgrammeId: null } as never).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('2 learners are on both — unlink or finish them first');
    expect(q.countOpenLinkedPairs).toHaveBeenCalledWith(DIP, STD);
    expect(q.updateApprProgramme).not.toHaveBeenCalled();
    vi.mocked(q.countOpenLinkedPairs).mockResolvedValue(1);
    expect(await status(updateProgramme(admin, DIP, { pairedProgrammeId: STD2 } as never))).toBe(409);
  });

  it('goes ahead with no linked pairs, and never asks when the pair is unchanged', async () => {
    expect(await status(updateProgramme(admin, DIP, { pairedProgrammeId: null } as never))).toBe(200);
    vi.mocked(q.countOpenLinkedPairs).mockClear();
    expect(await status(updateProgramme(admin, DIP, { title: 'New title' } as never))).toBe(200);
    expect(await status(updateProgramme(admin, DIP, { pairedProgrammeId: STD } as never))).toBe(200);
    expect(q.countOpenLinkedPairs).not.toHaveBeenCalled();
  });
});
