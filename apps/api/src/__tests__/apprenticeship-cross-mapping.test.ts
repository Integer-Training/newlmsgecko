import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import type { Actor } from '@cio/db/actor';

// Gecko Apprenticeships Deploy 3 (agent A) — evidence across a linked Diploma + Standard pair:
//   • the counting queries filter on the CRITERION's programme (criterion -> unit -> qualification) + the learner, and
//     are identical for unlinked data (SQL-shape regression on a recording client + row mapping)
//   • criteria checks accept either qualification of a pair and nothing else
//   • recomputeEnrolment recomputes BOTH enrolments (component first, locks in id order, no recursion)
//   • the carrier owns learner-level OTJ minutes (pair evidence + validated logs) and the learner EPA lock

vi.mock('@cio/db/queries/apprenticeship', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isProgrammeTutor: vi.fn(async () => false),
    isProgrammeTutorOfLinked: vi.fn(async () => false),
    getApprEnrolment: vi.fn(),
    getApprEnrolmentByProgrammeLearner: vi.fn(),
    getLinkedEnrolment: vi.fn(async () => null),
    lockApprEnrolment: vi.fn(async (_tx: unknown, id: string) => ({ id })),
    listProgrammeUnits: vi.fn(async () => []),
    listProgrammeCriteria: vi.fn(async () => []),
    countAcceptedByCriterion: vi.fn(async () => new Map()),
    getEvidenceTotals: vi.fn(async () => ({ submitted: 0, accepted: 0, referred: 0, otjMinutes: 0 })),
    listEnrolmentUnitRows: vi.fn(async () => []),
    getApprSettings: vi.fn(async () => ({ concernGapPct: 15, otjFactor: 0.2, otjWeeklyCapHours: 30 })),
    getApprProgramme: vi.fn(async () => ({ gatewayChecklist: null })),
    sumGlhLogMinutes: vi.fn(async () => 0),
    sumValidatedOtjLogMinutes: vi.fn(async () => 0),
    writeEnrolmentCache: vi.fn(async () => undefined),
    claimGatewayReady: vi.fn(async () => false),
    clearGatewayReady: vi.fn(async () => undefined),
    filterCriterionIdsInProgramme: vi.fn(),
    listApprEvidenceTypes: vi.fn(async () => [{ key: 'assignment', label: 'Assignment', active: true }]),
    insertApprEvidence: vi.fn(),
    replaceEvidenceCriteria: vi.fn(async () => undefined),
    insertEvidenceNote: vi.fn(async () => ({})),
    markUploadsAttached: vi.fn(async () => undefined),
    listEvidenceForLearner: vi.fn(async () => []),
    listEvidenceMappings: vi.fn(async () => []),
    listEvidenceForCriterion: vi.fn(async () => []),
    countTasksForCriterion: vi.fn(async () => 0)
  };
});
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => false),
  isCourseTutorForLearner: vi.fn(async () => false),
  isCourseTutor: vi.fn(async () => false),
  getOrgMemberRoleId: vi.fn(async () => null)
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runInTransaction: (fn: (tx: unknown) => unknown) => fn({ tx: true })
}));
vi.mock('@api/services/apprenticeship/notifications', () => ({
  notifyEvidenceSubmitted: vi.fn(async () => undefined),
  notifyEvidenceReviewed: vi.fn(async () => undefined),
  notifyGatewayReadyOrRelease: vi.fn(async () => undefined),
  notifySafely: async (_label: string, fn: () => Promise<void>) => fn()
}));
vi.mock('@api/services/organization/users', () => ({ createOrgUser: vi.fn() }));
vi.mock('@api/services/organization/allocation', () => ({ createTutorAllocation: vi.fn() }));

import * as q from '@cio/db/queries/apprenticeship';
import { notifyEvidenceSubmitted } from '@api/services/apprenticeship/notifications';
import { assertCriteriaInProgramme, assertCriteriaInProgrammes } from '@api/services/apprenticeship/checks';
import { buildEnrolmentProgress, recomputeEnrolment } from '@api/services/apprenticeship/progress';
import { createEvidence, listCriterionEvidence, listEvidence } from '@api/services/apprenticeship/evidence';

const ORG = 'org-1';
const LRN = '22222222-2222-4222-8222-222222222222';
const DIP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // diploma programme
const STD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // standard programme
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CARRIER = '10000000-0000-4000-8000-000000000001'; // sorts BEFORE the component
const COMPONENT = '10000000-0000-4000-8000-000000000002';
const CRIT_D = '55555555-5555-4555-8555-555555555551';
const CRIT_S = '55555555-5555-4555-8555-555555555552';
const CRIT_X = '55555555-5555-4555-8555-555555555559';

const admin = { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG } as Actor;
const learner = { authenticated: true, userId: LRN, role: 'LEARNER', status: 'ACTIVE', orgId: ORG } as Actor;

const carrierRow = {
  id: CARRIER,
  organizationId: ORG,
  programmeId: DIP,
  learnerId: LRN,
  primaryEnrolmentId: null,
  startDate: '2026-01-01',
  plannedEndDate: '2026-12-31',
  contractedHoursWeek: 30,
  otjTargetMinutesOverride: null,
  gatewayItems: {},
  gatewayPassedAt: null
};
const componentRow = { ...carrierRow, id: COMPONENT, programmeId: STD, primaryEnrolmentId: CARRIER };
const standaloneRow = { ...carrierRow, id: '10000000-0000-4000-8000-000000000009' };

function useEnrolments(rows: Record<string, unknown>[], link: Record<string, unknown> | null = null) {
  vi.mocked(q.getApprEnrolment).mockImplementation(
    async (id: string) => (rows.find((r) => r.id === id) ?? null) as never
  );
  vi.mocked(q.getLinkedEnrolment).mockImplementation(async (id: string) => {
    if (!link) return null as never;
    if (id === CARRIER) return componentRow as never;
    if (id === COMPONENT) return carrierRow as never;
    return null as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.getLinkedEnrolment).mockResolvedValue(null as never);
  vi.mocked(q.getEvidenceTotals).mockResolvedValue({ submitted: 0, accepted: 0, referred: 0, otjMinutes: 0 });
  vi.mocked(q.sumValidatedOtjLogMinutes).mockResolvedValue(0);
  vi.mocked(q.listEnrolmentUnitRows).mockResolvedValue([]);
});

// ── 1. Counting queries: criterion's programme + learner, never the evidence's home programme ──

describe('counting queries are scoped by the criterion programme (SQL shape + row mapping)', () => {
  const captured: { sql: string; params: unknown[] }[] = [];
  let nextRows: unknown[][] = [];
  const recorder = drizzle(async (sqlText, params) => {
    captured.push({ sql: sqlText, params });
    return { rows: nextRows };
  });
  let real: typeof q;

  beforeEach(async () => {
    captured.length = 0;
    nextRows = [];
    real = await vi.importActual<typeof q>('@cio/db/queries/apprenticeship');
  });

  const noHomeProgrammeFilter = (sqlText: string) => expect(sqlText).not.toMatch(/"appr_evidence"\."programme_id"/);

  it('countAcceptedByCriterion: qualification.programme_id + learner_id, status ACCEPTED, no evidence.programme_id', async () => {
    nextRows = [[CRIT_D, 3]];
    const map = await real.countAcceptedByCriterion(DIP, LRN, recorder as never);
    const { sql: text, params } = captured[0];
    expect(text).toMatch(/"appr_qualification"\."programme_id" = \$1/);
    expect(text).toMatch(/"appr_evidence"\."learner_id" = \$2/);
    expect(text).toMatch(/"appr_evidence"\."status" in \(\$3\)/);
    expect(text).toMatch(/inner join "appr_criterion"/);
    expect(params).toEqual([DIP, LRN, 'ACCEPTED']);
    noHomeProgrammeFilter(text);
    expect(map.get(CRIT_D)).toBe(3); // same Map<criterionId, count> shape as before
  });

  it('countEvidenceByCriterion / listAcceptedEvidenceTitles / listCriterionAcceptedDates share the rule', async () => {
    await real.countEvidenceByCriterion(DIP, LRN, recorder as never);
    await real.listAcceptedEvidenceTitles(DIP, LRN, recorder as never);
    await real.listCriterionAcceptedDates(DIP, LRN, recorder as never);
    expect(captured).toHaveLength(3);
    for (const { sql: text, params } of captured) {
      expect(text).toMatch(/"appr_qualification"\."programme_id" = \$1/);
      expect(text).toMatch(/"appr_evidence"\."learner_id" = \$2/);
      expect(params.slice(0, 2)).toEqual([DIP, LRN]);
      noHomeProgrammeFilter(text);
    }
  });

  it('listEvidenceForCriterion: by the criterion programme + learner, returns the home programme', async () => {
    await real.listEvidenceForCriterion(STD, LRN, CRIT_S, recorder as never);
    const { sql: text, params } = captured[0];
    expect(text).toMatch(/"appr_qualification"\."programme_id" = \$2/);
    expect(params).toEqual([CRIT_S, STD, LRN]);
    expect(text).toMatch(/select "appr_evidence"."id", "appr_evidence"."programme_id"/);
    expect(text).not.toMatch(/"appr_evidence"\."programme_id" = /);
  });

  it('getEvidenceTotals: home programme only by default (unlinked), both for a carrier', async () => {
    await real.getEvidenceTotals(DIP, LRN, recorder as never);
    await real.getEvidenceTotals(DIP, LRN, recorder as never, { programmeIds: [DIP, STD] });
    expect(captured[0].params).toContain(DIP);
    expect(captured[0].params).not.toContain(STD);
    expect(captured[0].sql).toMatch(/"appr_evidence"\."programme_id" in \(\$\d+\)/);
    expect(captured[1].params).toEqual(expect.arrayContaining([DIP, STD, LRN]));
  });

  it('unlinked regression: an unlinked learner counts exactly the progress of the programme the criterion is in', async () => {
    // The pre-change filter was evidence.programme_id = P, which assertCriteriaInProgramme forced to equal the
    // criterion's programme. With one programme per learner both filters select the same rows: the SQL above
    // filters on the criterion's programme and the learner, and buildEnrolmentProgress asks for exactly that.
    useEnrolments([standaloneRow]);
    vi.mocked(q.countAcceptedByCriterion).mockResolvedValue(new Map([[CRIT_D, 1]]));
    await buildEnrolmentProgress(standaloneRow.id);
    expect(q.countAcceptedByCriterion).toHaveBeenCalledWith(DIP, LRN, undefined);
    expect(q.getEvidenceTotals).toHaveBeenCalledWith(DIP, LRN, undefined, {});
    expect(q.sumValidatedOtjLogMinutes).toHaveBeenCalledWith(standaloneRow.id, undefined);
  });
});

// ── 2. Criteria checks ──

describe('assertCriteriaInProgrammes', () => {
  beforeEach(() => {
    vi.mocked(q.filterCriterionIdsInProgramme).mockImplementation(async (programmeId: string, ids: string[]) =>
      ids.filter((id) => (programmeId === DIP && id === CRIT_D) || (programmeId === STD && id === CRIT_S))
    );
  });

  it('unlinked: one programme, same rule as before (a foreign criterion is a 400)', async () => {
    await expect(assertCriteriaInProgramme(DIP, [CRIT_D, CRIT_D])).resolves.toEqual([CRIT_D]);
    expect(q.filterCriterionIdsInProgramme).toHaveBeenCalledTimes(1);
    await expect(assertCriteriaInProgramme(DIP, [CRIT_S])).rejects.toMatchObject({ statusCode: 400 });
    await expect(assertCriteriaInProgrammes([DIP, null], [CRIT_S])).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a pair accepts criteria of either qualification, in one request', async () => {
    await expect(assertCriteriaInProgrammes([DIP, STD], [CRIT_D, CRIT_S])).resolves.toEqual([CRIT_D, CRIT_S]);
  });

  it('a pair still rejects a criterion of any other programme, and an empty set is fine', async () => {
    await expect(assertCriteriaInProgrammes([DIP, STD], [CRIT_D, CRIT_X])).rejects.toMatchObject({
      statusCode: 400,
      field: 'criterionIds'
    });
    await expect(assertCriteriaInProgrammes([DIP, STD, OTHER], [])).resolves.toEqual([]);
  });
});

// ── 3. Pair recompute ──

describe('recomputeEnrolment hops to the counterpart of a linked pair', () => {
  it('standalone: one build, no locks (identical to before)', async () => {
    useEnrolments([standaloneRow]);
    await recomputeEnrolment({ tx: true } as never, standaloneRow.id, { claimGatewayReady: true });
    expect(q.writeEnrolmentCache).toHaveBeenCalledTimes(1);
    expect(q.lockApprEnrolment).not.toHaveBeenCalled();
  });

  it.each([
    ['the carrier', CARRIER],
    ['the component', COMPONENT]
  ])(
    'recomputing %s writes BOTH caches, component first, locks in id order, once each (no recursion)',
    async (_n, id) => {
      useEnrolments([carrierRow, componentRow], {});
      const detail = await recomputeEnrolment({ tx: true } as never, id);
      expect(vi.mocked(q.lockApprEnrolment).mock.calls.map((c) => c[1])).toEqual([CARRIER, COMPONENT]);
      expect(vi.mocked(q.writeEnrolmentCache).mock.calls.map((c) => c[0])).toEqual([COMPONENT, CARRIER]);
      expect(detail?.enrolmentId).toBe(id);
    }
  );

  it('locks in id order whichever half is recomputed (lower id first)', async () => {
    const low = { ...carrierRow, id: '10000000-0000-4000-8000-0000000000ff' };
    const high = { ...componentRow, id: '10000000-0000-4000-8000-000000000001', primaryEnrolmentId: low.id };
    vi.mocked(q.getApprEnrolment).mockImplementation(async (id: string) => (id === low.id ? low : high) as never);
    vi.mocked(q.getLinkedEnrolment).mockImplementation(async (id: string) => (id === low.id ? high : low) as never);
    await recomputeEnrolment({ tx: true } as never, low.id);
    expect(vi.mocked(q.lockApprEnrolment).mock.calls.map((c) => c[1])).toEqual([high.id, low.id]);
  });

  it('a component recompute claims the gateway on the CARRIER and says so', async () => {
    useEnrolments([carrierRow, componentRow], {});
    vi.mocked(q.getApprProgramme).mockResolvedValue({
      gatewayChecklist: [{ key: 'u', label: 'Units', kind: 'AUTO_UNITS' }]
    } as never);
    vi.mocked(q.claimGatewayReady).mockResolvedValue(true);
    const detail = await recomputeEnrolment({ tx: true } as never, COMPONENT, { claimGatewayReady: true });
    // no units on either side -> not ready -> nothing claimed; the component itself never touches the flag
    expect(q.claimGatewayReady).not.toHaveBeenCalledWith(expect.anything(), COMPONENT);
    expect(detail?.gatewayReadyClaimed ?? false).toBe(false);
  });
});

describe('buildEnrolmentProgress: learner-level numbers live on the carrier', () => {
  it('a carrier counts evidence of BOTH programmes and adds validated OTJ log minutes', async () => {
    useEnrolments([carrierRow, componentRow], {});
    vi.mocked(q.getEvidenceTotals).mockResolvedValue({ submitted: 1, accepted: 4, referred: 0, otjMinutes: 120 });
    vi.mocked(q.sumValidatedOtjLogMinutes).mockResolvedValue(30);
    const detail = await buildEnrolmentProgress(CARRIER);
    expect(q.getEvidenceTotals).toHaveBeenCalledWith(DIP, LRN, undefined, { programmeIds: [DIP, STD] });
    expect(detail?.otjMinutes).toBe(150);
    expect(detail?.totals.otjMinutes).toBe(150);
  });

  it('a component counts its own home evidence only and has no log minutes', async () => {
    useEnrolments([carrierRow, componentRow], {});
    vi.mocked(q.getEvidenceTotals).mockResolvedValue({ submitted: 0, accepted: 1, referred: 0, otjMinutes: 45 });
    const detail = await buildEnrolmentProgress(COMPONENT);
    expect(q.getEvidenceTotals).toHaveBeenCalledWith(STD, LRN, undefined, {});
    expect(q.sumValidatedOtjLogMinutes).not.toHaveBeenCalled();
    expect(detail?.otjMinutes).toBe(45);
  });

  it('gateway AUTO_UNITS on a carrier counts units across both qualifications', async () => {
    useEnrolments([carrierRow, componentRow], {});
    vi.mocked(q.getApprProgramme).mockResolvedValue({
      gatewayChecklist: [{ key: 'u', label: 'Units', kind: 'AUTO_UNITS' }]
    } as never);
    // component has one unit, not complete; carrier has no units -> not done. Then complete -> done.
    vi.mocked(q.listEnrolmentUnitRows).mockResolvedValue([{ unitId: 'u1', completedAt: null }] as never);
    const before = await buildEnrolmentProgress(CARRIER);
    expect(before?.gateway.items.find((i) => i.key === 'u')?.done).toBe(false);
    vi.mocked(q.listEnrolmentUnitRows).mockResolvedValue([{ unitId: 'u1', completedAt: '2026-05-01' }] as never);
    const after = await buildEnrolmentProgress(CARRIER);
    expect(after?.gateway.items.find((i) => i.key === 'u')?.done).toBe(true);
  });
});

// ── 4. Evidence service on a pair ──

describe('evidence on a linked pair', () => {
  const evidenceRow = (id: string, programmeId: string) => ({
    id,
    homeProgrammeId: programmeId,
    title: id,
    status: 'ACCEPTED'
  });

  beforeEach(() => {
    vi.mocked(q.filterCriterionIdsInProgramme).mockImplementation(async (programmeId: string, ids: string[]) =>
      ids.filter((id) => (programmeId === DIP && id === CRIT_D) || (programmeId === STD && id === CRIT_S))
    );
  });

  it('GET evidence of either half lists the pair: homeEnrolmentId + mappedQualifications (home first)', async () => {
    useEnrolments([carrierRow, componentRow], {});
    vi.mocked(q.listEvidenceForLearner).mockResolvedValue([evidenceRow('e1', DIP), evidenceRow('e2', STD)] as never);
    vi.mocked(q.listEvidenceMappings).mockResolvedValue([
      {
        evidenceId: 'e1',
        programmeId: STD,
        programmeTitle: 'Lead Adult Care Worker',
        programmeType: 'STANDARD',
        code: 'K1'
      },
      { evidenceId: 'e1', programmeId: DIP, programmeTitle: 'L3 Adult Care', programmeType: 'DIPLOMA', code: '1.1' },
      { evidenceId: 'e1', programmeId: DIP, programmeTitle: 'L3 Adult Care', programmeType: 'DIPLOMA', code: '1.2' },
      {
        evidenceId: 'e2',
        programmeId: STD,
        programmeTitle: 'Lead Adult Care Worker',
        programmeType: 'STANDARD',
        code: 'S2'
      }
    ] as never);

    for (const asked of [CARRIER, COMPONENT]) {
      const rows = await listEvidence(admin, asked, {});
      expect(q.listEvidenceForLearner).toHaveBeenLastCalledWith(
        ORG,
        asked === CARRIER ? [DIP, STD] : [STD, DIP],
        LRN,
        {}
      );
      const e1 = rows.find((r) => r.id === 'e1')!;
      expect(e1.homeEnrolmentId).toBe(CARRIER);
      expect(e1.mappedQualifications).toEqual([
        {
          enrolmentId: CARRIER,
          programmeId: DIP,
          type: 'DIPLOMA',
          title: 'L3 Adult Care',
          criterionCodes: ['1.1', '1.2']
        },
        {
          enrolmentId: COMPONENT,
          programmeId: STD,
          type: 'STANDARD',
          title: 'Lead Adult Care Worker',
          criterionCodes: ['K1']
        }
      ]);
      expect(rows.find((r) => r.id === 'e2')!.homeEnrolmentId).toBe(COMPONENT);
    }
  });

  it('an unlinked enrolment lists its own programme only, with no mapping lookup', async () => {
    useEnrolments([standaloneRow]);
    vi.mocked(q.listEvidenceForLearner).mockResolvedValue([evidenceRow('e1', DIP)] as never);
    const rows = await listEvidence(admin, standaloneRow.id, {});
    expect(q.listEvidenceForLearner).toHaveBeenCalledWith(ORG, [DIP], LRN, {});
    expect(q.listEvidenceMappings).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ homeEnrolmentId: standaloneRow.id, mappedQualifications: [] });
  });

  it('one upload may map to criteria in BOTH qualifications; both enrolments are recomputed in the same tx', async () => {
    useEnrolments([carrierRow, componentRow], {});
    vi.mocked(q.insertApprEvidence).mockImplementation(async (_tx, v) => ({ ...v, files: [] }) as never);
    const res = await createEvidence(admin, CARRIER, {
      title: 'Care plan',
      details: '',
      typeKey: 'assignment',
      minutes: 0,
      includeOtj: false,
      criterionIds: [CRIT_D, CRIT_S],
      files: []
    } as never);
    expect(vi.mocked(q.replaceEvidenceCriteria).mock.calls[0][2]).toEqual([CRIT_D, CRIT_S]);
    expect(res.evidence.programmeId).toBe(DIP); // homed where it was created
    expect(
      vi
        .mocked(q.writeEnrolmentCache)
        .mock.calls.map((c) => c[0])
        .sort()
    ).toEqual([CARRIER, COMPONENT]);
  });

  it('a criterion outside the pair is a 400 and nothing is written', async () => {
    useEnrolments([carrierRow, componentRow], {});
    await expect(
      createEvidence(admin, CARRIER, {
        title: 'x',
        details: '',
        typeKey: 'assignment',
        minutes: 0,
        includeOtj: false,
        criterionIds: [CRIT_X],
        files: []
      } as never)
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(q.insertApprEvidence).not.toHaveBeenCalled();
  });

  it('the apprentice submitting on a linked pair tells the tutors of BOTH enrolments (ids passed through)', async () => {
    useEnrolments([carrierRow, componentRow], {});
    vi.mocked(q.insertApprEvidence).mockImplementation(async (_tx, v) => ({ ...v, files: [] }) as never);
    await createEvidence(learner, COMPONENT, {
      title: 'x',
      details: '',
      typeKey: 'assignment',
      minutes: 0,
      includeOtj: false,
      criterionIds: [CRIT_S],
      files: []
    } as never);
    expect(notifyEvidenceSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({ learnerId: LRN, enrolmentId: COMPONENT, pairEnrolmentId: CARRIER })
    );
  });

  it("the apprentice's evidence lock follows the CARRIER's gateway_passed_at, from either half", async () => {
    const passed = { ...carrierRow, gatewayPassedAt: '2026-06-01T00:00:00Z' };
    useEnrolments([passed, componentRow], {});
    const body = {
      title: 'x',
      details: '',
      typeKey: 'assignment',
      minutes: 0,
      includeOtj: false,
      criterionIds: [CRIT_S],
      files: []
    } as never;
    await expect(createEvidence(learner, COMPONENT, body)).rejects.toMatchObject({ statusCode: 403 });
    await expect(createEvidence(learner, CARRIER, body)).rejects.toMatchObject({ statusCode: 403 });
    expect(q.insertApprEvidence).not.toHaveBeenCalled();
    // staff are unaffected
    vi.mocked(q.insertApprEvidence).mockImplementation(async (_tx, v) => ({ ...v, files: [] }) as never);
    await expect(createEvidence(admin, COMPONENT, body)).resolves.toBeDefined();
  });

  it('the criterion popover finds a Standard criterion from the Diploma enrolment, with evidence of both homes + taskCount', async () => {
    useEnrolments([carrierRow, componentRow], {});
    vi.mocked(q.listEvidenceForCriterion).mockResolvedValue([
      { id: 'e1', homeProgrammeId: DIP },
      { id: 'e2', homeProgrammeId: STD }
    ] as never);
    vi.mocked(q.countTasksForCriterion).mockResolvedValue(2);
    const res = await listCriterionEvidence(admin, CRIT_S, CARRIER);
    expect(q.listEvidenceForCriterion).toHaveBeenCalledWith(STD, LRN, CRIT_S);
    expect(q.countTasksForCriterion).toHaveBeenCalledWith([CARRIER, COMPONENT], CRIT_S);
    expect(res.taskCount).toBe(2);
    expect(res.items.map((i) => i.homeEnrolmentId)).toEqual([CARRIER, COMPONENT]);
    await expect(listCriterionEvidence(admin, CRIT_X, CARRIER)).rejects.toMatchObject({ statusCode: 404 });
  });
});
