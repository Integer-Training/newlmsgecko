import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// Gecko Apprenticeships round 2 Deploy 2 — gateway checklist, confirmation, EPA, GLH logs and the "ready" alert.
// DB queries mocked; the rules module and the real progress/recompute service are used.

vi.mock('@cio/db/queries/apprenticeship', () => ({
  getApprEnrolment: vi.fn(),
  getApprProgramme: vi.fn(),
  getApprSettings: vi.fn(async () => ({ concernGapPct: 15, otjFactor: 0.2, otjWeeklyCapHours: 30 })),
  listProgrammeUnits: vi.fn(),
  listProgrammeCriteria: vi.fn(async () => []),
  countAcceptedByCriterion: vi.fn(async () => new Map()),
  getEvidenceTotals: vi.fn(async () => ({ submitted: 0, accepted: 0, referred: 0, otjMinutes: 0 })),
  listEnrolmentUnitRows: vi.fn(async () => []),
  writeEnrolmentCache: vi.fn(async () => undefined),
  sumGlhLogMinutes: vi.fn(async () => 0),
  claimGatewayReady: vi.fn(async () => true),
  clearGatewayReady: vi.fn(async () => undefined),
  setGatewayTick: vi.fn(),
  passGateway: vi.fn(),
  reopenGateway: vi.fn(),
  setEpa: vi.fn(),
  updateApprProgramme: vi.fn(async () => ({})),
  listEnrolmentIdsForProgramme: vi.fn(async () => ['enr-1', 'enr-2']),
  listGlhLogs: vi.fn(async () => []),
  insertGlhLog: vi.fn(),
  deleteGlhLog: vi.fn(),
  getEnrolmentLearnerIds: vi.fn(async () => new Map()),
  getApprUnitInProgramme: vi.fn(async () => ({ id: 'u1' })),
  updateApprUnit: vi.fn(async (id: string) => ({ id }))
}));
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => true),
  isCourseTutorForLearner: vi.fn(async () => false),
  isCourseTutor: vi.fn(async () => false),
  getOrgMemberRoleId: vi.fn(async () => null)
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', () => ({ runInTransaction: (fn: (tx: unknown) => unknown) => fn({ tx: true }) }));
vi.mock('@api/services/apprenticeship/notifications', () => ({
  notifyGatewayReadyOrRelease: vi.fn(async () => undefined),
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
import { notifyGatewayReadyOrRelease } from '@api/services/apprenticeship/notifications';
import { recomputeEnrolment } from '@api/services/apprenticeship/progress';
import { buildGatewayView, buildGlhView } from '@api/services/apprenticeship/gateway-core';
import {
  confirmGateway,
  getGateway,
  putGatewayChecklist,
  reopenGateway,
  setGatewayItem,
  updateEpa
} from '@api/services/apprenticeship/gateway';
import { addGlhLog, removeGlhLog } from '@api/services/apprenticeship/glh';
import { updateUnit } from '@api/services/apprenticeship/programme';
import { APPR_DEFAULT_GATEWAY_CHECKLIST } from '@cio/utils/constants/apprenticeship';
import { ZGatewayChecklistPut, ZEpaUpdate, ZGlhLogCreate } from '@cio/utils/validation/apprenticeship';

const ORG = 'org-1';
const PROG = '11111111-1111-4111-8111-111111111111';
const LRN = '22222222-2222-4222-8222-222222222222';
const ENR = '33333333-3333-4333-8333-333333333333';
const LOG = '44444444-4444-4444-8444-444444444444';

const admin = { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG } as Actor;
const tutor = { authenticated: true, userId: 'u-tutor', role: 'TUTOR', status: 'ACTIVE', orgId: ORG } as Actor;
const self = { authenticated: true, userId: LRN, role: 'LEARNER', status: 'ACTIVE', orgId: ORG } as Actor;
const otherOrgAdmin = { ...admin, orgId: 'org-2' } as Actor;

const enrolment = (over: Record<string, unknown> = {}) => ({
  id: ENR,
  organizationId: ORG,
  programmeId: PROG,
  learnerId: LRN,
  startDate: '2026-01-01',
  plannedEndDate: '2026-12-31',
  contractedHoursWeek: 30,
  otjTargetMinutesOverride: 600,
  achievedAt: null,
  gatewayItems: {},
  gatewayPassedAt: null,
  gatewayPassedBy: null,
  epaBookedDate: null,
  epaResult: null,
  epaResultDate: null,
  ...over
});
const ALL_MANUAL_DONE = {
  english: { done: true },
  maths: { done: true },
  employer: { done: true },
  tutor: { done: true }
};
/** One unit that is complete (all criteria accepted) and OTJ target reached -> every AUTO item done. */
function givenAutoItemsDone(done: boolean) {
  vi.mocked(q.listProgrammeUnits).mockResolvedValue([{ unitId: 'u1', qualificationId: 'q1', glh: 10 }] as never);
  vi.mocked(q.listProgrammeCriteria).mockResolvedValue([
    { criterionId: 'c1', unitId: 'u1', qualificationId: 'q1', requiredCount: 1 }
  ] as never);
  vi.mocked(q.countAcceptedByCriterion).mockResolvedValue(new Map(done ? [['c1', 1]] : []));
  vi.mocked(q.getEvidenceTotals).mockResolvedValue({
    submitted: 0,
    accepted: done ? 1 : 0,
    referred: 0,
    otjMinutes: done ? 700 : 0
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment() as never);
  vi.mocked(q.getApprProgramme).mockResolvedValue({
    id: PROG,
    organizationId: ORG,
    status: 'ACTIVE',
    gatewayChecklist: null
  } as never);
  vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(true);
  givenAutoItemsDone(true);
  vi.mocked(q.setGatewayTick).mockResolvedValue({} as never);
  vi.mocked(q.passGateway).mockResolvedValue({} as never);
  vi.mocked(q.reopenGateway).mockResolvedValue({} as never);
  vi.mocked(q.setEpa).mockResolvedValue({} as never);
  vi.mocked(q.claimGatewayReady).mockResolvedValue(true);
  vi.mocked(q.listEnrolmentIdsForProgramme).mockResolvedValue(['enr-1', 'enr-2']);
  vi.mocked(notifyGatewayReadyOrRelease).mockResolvedValue(undefined);
});

describe('gateway view (pure)', () => {
  const base = {
    checklist: APPR_DEFAULT_GATEWAY_CHECKLIST,
    unitsTotal: 2,
    unitsComplete: 2,
    otjMinutes: 700,
    otjTargetMinutes: 600,
    enrolment: { gatewayPassedAt: null, epaBookedDate: null, epaResult: null, epaResultDate: null }
  };

  it('ready only when every auto + manual item is done; stage follows', () => {
    expect(buildGatewayView({ ...base, manual: ALL_MANUAL_DONE })).toMatchObject({
      ready: true,
      stage: 'READY_FOR_GATEWAY'
    });
    expect(buildGatewayView({ ...base, manual: { ...ALL_MANUAL_DONE, maths: { done: false } } })).toMatchObject({
      ready: false,
      stage: 'IN_LEARNING'
    });
  });

  it('readiness DROPS when an auto item regresses (evidence referred) before confirmation', () => {
    const view = buildGatewayView({ ...base, unitsComplete: 1, manual: ALL_MANUAL_DONE });
    expect(view.ready).toBe(false);
    expect(view.items.find((i) => i.key === 'units')?.done).toBe(false);
  });

  it('ticks for items removed from the checklist are ignored (orphans)', () => {
    const view = buildGatewayView({
      ...base,
      checklist: [{ key: 'tutor', label: 'Tutor sign-off', kind: 'MANUAL' }],
      manual: { ...ALL_MANUAL_DONE, legacy: { done: true }, tutor: { done: false } }
    });
    expect(view.items.map((i) => i.key)).toEqual(['tutor']);
    expect(view.ready).toBe(false);
  });

  it('stages: gateway confirmed, EPA booked, achieved, failed', () => {
    const at = '2026-05-01T00:00:00Z';
    const stage = (e: object) =>
      buildGatewayView({ ...base, manual: ALL_MANUAL_DONE, enrolment: { ...base.enrolment, ...e } }).stage;
    expect(stage({ gatewayPassedAt: at })).toBe('AT_GATEWAY');
    expect(stage({ gatewayPassedAt: at, epaBookedDate: '2026-06-01' })).toBe('EPA_BOOKED');
    expect(stage({ gatewayPassedAt: at, epaResult: 'MERIT' })).toBe('ACHIEVED');
    expect(stage({ gatewayPassedAt: at, epaResult: 'FAIL' })).toBe('EPA_FAILED');
  });

  it('GLH with no unit GLH -> target / expected are null (done still counts logged hours)', () => {
    expect(buildGlhView([{ glh: null, complete: true }], 90, 50)).toEqual({
      targetMinutes: null,
      doneMinutes: 90,
      expectedMinutes: null
    });
    expect(
      buildGlhView(
        [
          { glh: 10, complete: true },
          { glh: 10, complete: false }
        ],
        30,
        50
      )
    ).toEqual({
      targetMinutes: 1200,
      doneMinutes: 630,
      expectedMinutes: 600
    });
  });
});

describe('recomputeEnrolment: gateway readiness flag', () => {
  const tx = { tx: true } as never;

  it('claims the flag ONLY when the caller opts in, and reports it so the caller notifies after commit', async () => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment({ gatewayItems: ALL_MANUAL_DONE }) as never);
    const quiet = await recomputeEnrolment(tx, ENR);
    expect(q.claimGatewayReady).not.toHaveBeenCalled();
    expect(quiet?.gatewayReadyClaimed).toBeUndefined();
    const loud = await recomputeEnrolment(tx, ENR, { claimGatewayReady: true });
    expect(q.claimGatewayReady).toHaveBeenCalledTimes(1);
    expect(loud?.gatewayReadyClaimed).toBe(true);
    // already notified (the claim returns false) -> not reported again
    vi.mocked(q.claimGatewayReady).mockResolvedValueOnce(false);
    expect((await recomputeEnrolment(tx, ENR, { claimGatewayReady: true }))?.gatewayReadyClaimed).toBe(false);
  });

  it('clears the flag when readiness drops (referral) so it can fire again', async () => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment({ gatewayItems: ALL_MANUAL_DONE }) as never);
    givenAutoItemsDone(false);
    await recomputeEnrolment(tx, ENR, { claimGatewayReady: true });
    expect(q.clearGatewayReady).toHaveBeenCalledWith(tx, ENR);
    expect(q.claimGatewayReady).not.toHaveBeenCalled();
  });

  it('after confirmation the flag is left alone either way (checklist locked)', async () => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue(
      enrolment({ gatewayItems: ALL_MANUAL_DONE, gatewayPassedAt: '2026-05-01T00:00:00Z' }) as never
    );
    await recomputeEnrolment(tx, ENR, { claimGatewayReady: true });
    givenAutoItemsDone(false);
    await recomputeEnrolment(tx, ENR, { claimGatewayReady: true });
    expect(q.claimGatewayReady).not.toHaveBeenCalled();
    expect(q.clearGatewayReady).not.toHaveBeenCalled();
  });

  it('caches GLH done (units + logs) with the rest of the progress cache', async () => {
    vi.mocked(q.sumGlhLogMinutes).mockResolvedValue(45);
    await recomputeEnrolment(tx, ENR);
    expect(vi.mocked(q.writeEnrolmentCache).mock.calls[0][1]).toMatchObject({ glhMinutes: 10 * 60 + 45 });
  });
});

describe('manual ticks', () => {
  it('ticks a MANUAL item, recomputes in the same tx and notifies exactly when this tick made them ready', async () => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue(
      enrolment({ gatewayItems: { english: { done: true }, maths: { done: true }, employer: { done: true } } }) as never
    );
    await setGatewayItem(tutor, ENR, 'tutor', { done: true, note: 'Signed off' });
    expect(q.setGatewayTick).toHaveBeenCalledWith(
      { tx: true },
      ENR,
      'tutor',
      expect.objectContaining({ done: true, note: 'Signed off', by: 'u-tutor' })
    );
    // the mocked tick does not change stored ticks, so the learner is not ready yet -> nobody is told
    expect(notifyGatewayReadyOrRelease).not.toHaveBeenCalled();
  });

  it('tells tutors + admins once when the tick completes the checklist', async () => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment({ gatewayItems: ALL_MANUAL_DONE }) as never);
    await setGatewayItem(admin, ENR, 'tutor', { done: true });
    expect(notifyGatewayReadyOrRelease).toHaveBeenCalledTimes(1);
    expect(notifyGatewayReadyOrRelease).toHaveBeenCalledWith({ enrolmentId: ENR, learnerId: LRN, organizationId: ORG });
    vi.mocked(q.claimGatewayReady).mockResolvedValue(false);
    await setGatewayItem(admin, ENR, 'tutor', { done: true });
    expect(notifyGatewayReadyOrRelease).toHaveBeenCalledTimes(1);
  });

  it('an AUTO item cannot be ticked (400); a key not on the checklist is 404', async () => {
    await expect(setGatewayItem(admin, ENR, 'units', { done: true })).rejects.toMatchObject({ statusCode: 400 });
    await expect(setGatewayItem(admin, ENR, 'otj', { done: true })).rejects.toMatchObject({ statusCode: 400 });
    await expect(setGatewayItem(admin, ENR, 'nope', { done: true })).rejects.toMatchObject({ statusCode: 404 });
    expect(q.setGatewayTick).not.toHaveBeenCalled();
  });

  it('is locked once the gateway is confirmed (409), including a confirm that lands first', async () => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment({ gatewayPassedAt: '2026-05-01T00:00:00Z' }) as never);
    await expect(setGatewayItem(admin, ENR, 'tutor', { done: false })).rejects.toMatchObject({ statusCode: 409 });
    vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment() as never);
    vi.mocked(q.setGatewayTick).mockResolvedValueOnce(null as never);
    await expect(setGatewayItem(admin, ENR, 'tutor', { done: true })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('works against the programme checklist when it has its own (custom keys, orphans ignored)', async () => {
    vi.mocked(q.getApprProgramme).mockResolvedValue({
      id: PROG,
      gatewayChecklist: [{ key: 'portfolio', label: 'Portfolio reviewed', kind: 'MANUAL' }]
    } as never);
    await expect(setGatewayItem(admin, ENR, 'english', { done: true })).rejects.toMatchObject({ statusCode: 404 });
    await expect(setGatewayItem(admin, ENR, 'portfolio', { done: true })).resolves.toBeTruthy();
  });

  it('learners cannot tick; a tutor of an unallocated learner gets 404; another org gets 404', async () => {
    await expect(setGatewayItem(self, ENR, 'tutor', { done: true })).rejects.toMatchObject({ statusCode: 403 });
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(false);
    await expect(setGatewayItem(tutor, ENR, 'tutor', { done: true })).rejects.toMatchObject({ statusCode: 404 });
    await expect(setGatewayItem(otherOrgAdmin, ENR, 'tutor', { done: true })).rejects.toMatchObject({
      statusCode: 404
    });
    expect(q.setGatewayTick).not.toHaveBeenCalled();
  });
});

describe('confirm / reopen', () => {
  it('confirms only when ready (re-derived in the transaction); readiness lost after the last tick blocks it', async () => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment({ gatewayItems: ALL_MANUAL_DONE }) as never);
    await confirmGateway(tutor, ENR);
    expect(q.passGateway).toHaveBeenCalledWith({ tx: true }, ENR, 'u-tutor');

    vi.mocked(q.passGateway).mockClear();
    givenAutoItemsDone(false); // a referral dropped a unit back to incomplete
    await expect(confirmGateway(tutor, ENR)).rejects.toMatchObject({ statusCode: 400 });
    expect(q.passGateway).not.toHaveBeenCalled();
  });

  it('a second confirm is a 409; a learner cannot confirm', async () => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue(
      enrolment({ gatewayItems: ALL_MANUAL_DONE, gatewayPassedAt: 'x' }) as never
    );
    await expect(confirmGateway(admin, ENR)).rejects.toMatchObject({ statusCode: 409 });
    await expect(confirmGateway(self, ENR)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('reopen is ADMIN only, needs a confirmed gateway, and is refused once an EPA result exists', async () => {
    await expect(reopenGateway(tutor, ENR)).rejects.toMatchObject({ statusCode: 403 });
    await expect(reopenGateway(admin, ENR)).rejects.toMatchObject({ statusCode: 409 }); // not confirmed
    vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment({ gatewayPassedAt: 'x', epaResult: 'PASS' }) as never);
    await expect(reopenGateway(admin, ENR)).rejects.toMatchObject({ statusCode: 409 });
    vi.mocked(q.getApprEnrolment).mockResolvedValue(
      enrolment({ gatewayPassedAt: 'x', gatewayItems: ALL_MANUAL_DONE }) as never
    );
    await expect(reopenGateway(admin, ENR)).resolves.toBeTruthy();
    expect(q.reopenGateway).toHaveBeenCalledWith({ tx: true }, ENR);
  });
});

describe('EPA', () => {
  const passed = (over: Record<string, unknown> = {}) =>
    vi
      .mocked(q.getApprEnrolment)
      .mockResolvedValue(enrolment({ gatewayPassedAt: '2026-05-01T00:00:00Z', ...over }) as never);

  it('needs the gateway confirmed first (409) and staff (learner 403)', async () => {
    await expect(updateEpa(admin, ENR, { epaBookedDate: '2026-06-01' })).rejects.toMatchObject({ statusCode: 409 });
    passed();
    await expect(updateEpa(self, ENR, { epaBookedDate: '2026-06-01' })).rejects.toMatchObject({ statusCode: 403 });
    expect(q.setEpa).not.toHaveBeenCalled();
  });

  it('books a date; a result needs its date; an achieving result sets achieved_at to that date', async () => {
    passed();
    await updateEpa(tutor, ENR, { epaBookedDate: '2026-06-01' });
    expect(vi.mocked(q.setEpa).mock.calls[0][2]).toMatchObject({
      epaBookedDate: '2026-06-01',
      epaResult: null,
      achievedAt: null
    });

    await expect(updateEpa(tutor, ENR, { epaResult: 'PASS' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(updateEpa(tutor, ENR, { epaResultDate: '2026-07-01' })).rejects.toMatchObject({ statusCode: 400 });

    await updateEpa(tutor, ENR, { epaResult: 'DISTINCTION', epaResultDate: '2026-07-01' });
    expect(vi.mocked(q.setEpa).mock.calls.at(-1)![2]).toMatchObject({
      epaResult: 'DISTINCTION',
      epaResultDate: '2026-07-01',
      achievedAt: '2026-07-01T00:00:00.000Z'
    });
  });

  it('FAIL clears achieved_at; clearing a recorded result is ADMIN only and clears everything derived', async () => {
    passed({ epaResult: 'PASS', epaResultDate: '2026-07-01', achievedAt: '2026-07-01T00:00:00Z' });
    await updateEpa(admin, ENR, { epaResult: 'FAIL' });
    expect(vi.mocked(q.setEpa).mock.calls[0][2]).toMatchObject({ epaResult: 'FAIL', achievedAt: null });

    await expect(updateEpa(tutor, ENR, { epaResult: null })).rejects.toMatchObject({ statusCode: 403 });
    await updateEpa(admin, ENR, { epaResult: null });
    expect(vi.mocked(q.setEpa).mock.calls.at(-1)![2]).toMatchObject({
      epaResult: null,
      epaResultDate: null,
      achievedAt: null
    });
  });

  it('a lost race (gateway reopened meanwhile) is a 409', async () => {
    passed();
    vi.mocked(q.setEpa).mockResolvedValueOnce(null as never);
    await expect(updateEpa(admin, ENR, { epaBookedDate: '2026-06-01' })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('EPA: recorded results, date sanity, optimistic concurrency', () => {
  const NOW = new Date('2026-08-01T10:00:00Z');
  const passed = (over: Record<string, unknown> = {}) =>
    vi
      .mocked(q.getApprEnrolment)
      .mockResolvedValue(enrolment({ gatewayPassedAt: '2026-05-01T09:00:00Z', ...over }) as never);

  it('once a result exists, ANY change to the result or its date is admin-only; unchanged values and booking are not', async () => {
    passed({ epaResult: 'PASS', epaResultDate: '2026-07-01', epaBookedDate: '2026-06-01' });
    await expect(updateEpa(tutor, ENR, { epaResult: 'MERIT' }, NOW)).rejects.toMatchObject({ statusCode: 403 });
    await expect(updateEpa(tutor, ENR, { epaResultDate: '2026-07-02' }, NOW)).rejects.toMatchObject({
      statusCode: 403
    });
    expect(q.setEpa).not.toHaveBeenCalled();
    // same values re-sent, or only the booked date: allowed for staff
    await expect(updateEpa(tutor, ENR, { epaResult: 'PASS', epaResultDate: '2026-07-01' }, NOW)).resolves.toBeTruthy();
    await expect(updateEpa(tutor, ENR, { epaBookedDate: '2026-06-02' }, NOW)).resolves.toBeTruthy();
    await expect(updateEpa(admin, ENR, { epaResult: 'MERIT' }, NOW)).resolves.toBeTruthy();
  });

  it('result date: not before the gateway date, not in the future; booked date: not before the gateway date', async () => {
    passed();
    await expect(updateEpa(tutor, ENR, { epaResult: 'PASS', epaResultDate: '2026-04-30' }, NOW)).rejects.toMatchObject({
      statusCode: 400
    });
    await expect(updateEpa(tutor, ENR, { epaResult: 'PASS', epaResultDate: '2026-08-02' }, NOW)).rejects.toMatchObject({
      statusCode: 400
    });
    await expect(updateEpa(tutor, ENR, { epaBookedDate: '2026-04-30' }, NOW)).rejects.toMatchObject({
      statusCode: 400
    });
    expect(q.setEpa).not.toHaveBeenCalled();
    await expect(updateEpa(tutor, ENR, { epaResult: 'PASS', epaResultDate: '2026-05-01' }, NOW)).resolves.toBeTruthy(); // same day as the gateway
    await expect(updateEpa(tutor, ENR, { epaResult: 'PASS', epaResultDate: '2026-08-01' }, NOW)).resolves.toBeTruthy(); // today
    await expect(updateEpa(tutor, ENR, { epaBookedDate: '2026-12-01' }, NOW)).resolves.toBeTruthy(); // booking ahead is fine
  });

  it('writes conditionally on the EPA fields as read: a concurrent change is a 409', async () => {
    passed({ epaBookedDate: '2026-06-01' });
    await updateEpa(tutor, ENR, { epaBookedDate: '2026-06-15' }, NOW);
    expect(vi.mocked(q.setEpa).mock.calls[0][3]).toEqual({
      epaBookedDate: '2026-06-01',
      epaResult: null,
      epaResultDate: null
    });
    vi.mocked(q.setEpa).mockResolvedValueOnce(null as never);
    await expect(updateEpa(tutor, ENR, { epaBookedDate: '2026-06-20' }, NOW)).rejects.toMatchObject({
      statusCode: 409
    });
  });
});

describe('ready alert survives a failed send', () => {
  it('notifyGatewayReadyOrRelease is used after a claim (the release itself is covered in the notifications tests)', async () => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment({ gatewayItems: ALL_MANUAL_DONE }) as never);
    await setGatewayItem(admin, ENR, 'tutor', { done: true });
    expect(notifyGatewayReadyOrRelease).toHaveBeenCalledTimes(1);
  });
});

describe('programme checklist recompute is batched', () => {
  it('recomputes in transactions of 100, claims the ready flag, and notifies only after each batch', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `e${i}`);
    vi.mocked(q.listEnrolmentIdsForProgramme).mockResolvedValue(ids);
    vi.mocked(q.getApprEnrolment).mockImplementation((async (id: string) =>
      enrolment({ id, gatewayItems: ALL_MANUAL_DONE })) as never);
    vi.mocked(q.getEnrolmentLearnerIds).mockImplementation(
      (async (batch: string[]) => new Map(batch.map((id) => [id, `l-${id}`]))) as never
    );
    const events: string[] = [];
    vi.mocked(q.claimGatewayReady).mockImplementation((async (_tx: unknown, id: string) => {
      events.push(`claim ${id}`);
      return id === 'e0' || id === 'e150';
    }) as never);
    vi.mocked(notifyGatewayReadyOrRelease).mockImplementation(
      (async (c: { enrolmentId: string }) => void events.push(`notify ${c.enrolmentId}`)) as never
    );
    await putGatewayChecklist(admin, PROG, { checklist: [{ key: 'tutor', label: 'T', kind: 'MANUAL' }] });
    expect(q.writeEnrolmentCache).toHaveBeenCalledTimes(250);
    // batch 1 (e0..e99) commits and notifies e0 before batch 2 claims anything; e150 is in batch 2
    expect(events.indexOf('notify e0')).toBeGreaterThan(events.indexOf('claim e99'));
    expect(events.indexOf('notify e0')).toBeLessThan(events.indexOf('claim e100'));
    expect(events.filter((e) => e.startsWith('notify'))).toEqual(['notify e0', 'notify e150']);
    expect(notifyGatewayReadyOrRelease).toHaveBeenCalledWith({
      enrolmentId: 'e150',
      learnerId: 'l-e150',
      organizationId: ORG
    });
  });
});

describe('getGateway', () => {
  it('returns live items + stage + glh for a learner reading their own gateway', async () => {
    vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment({ gatewayItems: ALL_MANUAL_DONE }) as never);
    const g = await getGateway(self, ENR);
    expect(g).toMatchObject({ ready: true, stage: 'READY_FOR_GATEWAY', locked: false });
    expect(g.glh).toMatchObject({ targetMinutes: 600 });
    expect(g.items).toHaveLength(6);
  });
});

describe('programme checklist', () => {
  it('saves and resets (null) the checklist, then recomputes every enrolment of the programme in the same tx', async () => {
    await putGatewayChecklist(admin, PROG, { checklist: [{ key: 'a', label: 'A', kind: 'MANUAL' }] });
    expect(q.updateApprProgramme).toHaveBeenCalledWith(
      PROG,
      { gatewayChecklist: [{ key: 'a', label: 'A', kind: 'MANUAL' }] },
      { tx: true }
    );
    expect(q.writeEnrolmentCache).toHaveBeenCalledTimes(2);
    await putGatewayChecklist(admin, PROG, { checklist: null });
    expect(vi.mocked(q.updateApprProgramme).mock.calls.at(-1)![1]).toEqual({ gatewayChecklist: null });
  });

  it('validation: <=20 items, unique slug keys, AUTO_UNITS / AUTO_OTJ at most once, null resets', () => {
    const item = (key: string, kind = 'MANUAL') => ({ key, label: key, kind });
    expect(ZGatewayChecklistPut.safeParse({ checklist: null }).success).toBe(true);
    expect(ZGatewayChecklistPut.safeParse({ checklist: [item('a'), item('b')] }).success).toBe(true);
    expect(ZGatewayChecklistPut.safeParse({ checklist: [item('a'), item('a')] }).success).toBe(false);
    expect(
      ZGatewayChecklistPut.safeParse({ checklist: [item('a', 'AUTO_UNITS'), item('b', 'AUTO_UNITS')] }).success
    ).toBe(false);
    expect(ZGatewayChecklistPut.safeParse({ checklist: [item('a', 'AUTO_OTJ'), item('b', 'AUTO_OTJ')] }).success).toBe(
      false
    );
    expect(
      ZGatewayChecklistPut.safeParse({ checklist: [item('a', 'AUTO_OTJ'), item('b', 'AUTO_UNITS')] }).success
    ).toBe(true);
    expect(
      ZGatewayChecklistPut.safeParse({ checklist: Array.from({ length: 21 }, (_, i) => item(`k${i}`)) }).success
    ).toBe(false);
    expect(
      ZGatewayChecklistPut.safeParse({ checklist: Array.from({ length: 20 }, (_, i) => item(`k${i}`)) }).success
    ).toBe(true);
    expect(ZGatewayChecklistPut.safeParse({ checklist: [item('Bad Key')] }).success).toBe(false);
    expect(ZGatewayChecklistPut.safeParse({ checklist: [] }).success).toBe(false);
  });

  it('EPA and GLH inputs are validated', () => {
    expect(ZEpaUpdate.safeParse({}).success).toBe(false);
    expect(ZEpaUpdate.safeParse({ epaResult: 'GREAT' }).success).toBe(false);
    expect(ZEpaUpdate.safeParse({ epaBookedDate: '2026-02-30' }).success).toBe(false);
    expect(ZGlhLogCreate.safeParse({ minutes: 0, logDate: '2026-01-01' }).success).toBe(false);
    expect(ZGlhLogCreate.safeParse({ minutes: 1441, logDate: '2026-01-01' }).success).toBe(false);
    expect(ZGlhLogCreate.safeParse({ minutes: 90, logDate: '2026-01-01', note: 'x'.repeat(501) }).success).toBe(false);
    expect(ZGlhLogCreate.safeParse({ minutes: 1440, logDate: '2026-01-01', note: 'Workshop' }).success).toBe(true);
  });
});

describe('GLH logs', () => {
  it('staff log minutes and the cache is recomputed in the same transaction', async () => {
    vi.mocked(q.insertGlhLog).mockResolvedValue({ id: LOG, minutes: 90 } as never);
    vi.mocked(q.sumGlhLogMinutes).mockResolvedValue(90);
    const res = await addGlhLog(tutor, ENR, { minutes: 90, logDate: '2026-02-01', note: 'Workshop' });
    expect(q.insertGlhLog).toHaveBeenCalledWith(
      { tx: true },
      expect.objectContaining({ enrolmentId: ENR, organizationId: ORG, minutes: 90, createdBy: 'u-tutor' })
    );
    expect(q.writeEnrolmentCache).toHaveBeenCalledTimes(1);
    expect(res.glh).toMatchObject({ doneMinutes: 10 * 60 + 90 });
  });

  it('a tutor who is not allocated gets 404; a learner cannot write; another org gets 404', async () => {
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(false);
    await expect(addGlhLog(tutor, ENR, { minutes: 30, logDate: '2026-02-01' })).rejects.toMatchObject({
      statusCode: 404
    });
    await expect(removeGlhLog(tutor, ENR, LOG)).rejects.toMatchObject({ statusCode: 404 });
    await expect(addGlhLog(self, ENR, { minutes: 30, logDate: '2026-02-01' })).rejects.toMatchObject({
      statusCode: 403
    });
    await expect(removeGlhLog(self, ENR, LOG)).rejects.toMatchObject({ statusCode: 403 });
    await expect(addGlhLog(otherOrgAdmin, ENR, { minutes: 30, logDate: '2026-02-01' })).rejects.toMatchObject({
      statusCode: 404
    });
    expect(q.insertGlhLog).not.toHaveBeenCalled();
    expect(q.deleteGlhLog).not.toHaveBeenCalled();
  });

  it('removing a log bound to another enrolment is a 404 and recomputes nothing', async () => {
    vi.mocked(q.deleteGlhLog).mockResolvedValue(false as never);
    await expect(removeGlhLog(admin, ENR, LOG)).rejects.toMatchObject({ statusCode: 404 });
    expect(q.writeEnrolmentCache).not.toHaveBeenCalled();
    vi.mocked(q.deleteGlhLog).mockResolvedValue(true as never);
    await expect(removeGlhLog(admin, ENR, LOG)).resolves.toMatchObject({ deleted: true });
    expect(q.writeEnrolmentCache).toHaveBeenCalledTimes(1);
  });
});

describe('unit GLH edits', () => {
  it('changing a unit GLH re-derives every learner of the programme in the same transaction; other edits do not', async () => {
    await updateUnit(admin, PROG, 'q1', 'u1', { glh: 40 });
    expect(q.updateApprUnit).toHaveBeenCalledWith('u1', { glh: 40 }, { tx: true });
    expect(q.listEnrolmentIdsForProgramme).toHaveBeenCalledTimes(1);
    expect(q.writeEnrolmentCache).toHaveBeenCalledTimes(2);
    vi.mocked(q.listEnrolmentIdsForProgramme).mockClear();
    await updateUnit(admin, PROG, 'q1', 'u1', { title: 'Renamed' });
    expect(q.listEnrolmentIdsForProgramme).not.toHaveBeenCalled();
  });
});
