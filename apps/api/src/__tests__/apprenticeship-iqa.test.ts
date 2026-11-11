import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// Gecko Apprenticeships — IQA sampling: access matrix, manual sample rules, suggest maths, decide (optimistic, evidence
// untouched, one alert to the assessor), acknowledge and delete.

vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  getApprEnrolment: vi.fn(),
  getIqaEvidenceContext: vi.fn(),
  getIqaSample: vi.fn(),
  getIqaSampleView: vi.fn(async (_o: string, id: string) => ({ id, outcome: 'PENDING' })),
  getIqaSampleViewByEvidence: vi.fn(async () => null),
  getIqaTargetPct: vi.fn(async () => null),
  putIqaTargetPct: vi.fn(async () => undefined),
  insertIqaSample: vi.fn(),
  insertIqaSamples: vi.fn(async (rows: unknown[]) => rows.map((_, i) => ({ id: `new-${i}` }))),
  listIqaAssessorCoverage: vi.fn(async () => []),
  listIqaUnitCoverage: vi.fn(async () => []),
  listIqaSampleViews: vi.fn(async () => []),
  listIqaSampleViewsByIds: vi.fn(async (_o: string, ids: string[]) => ids.map((id) => ({ id }))),
  pickIqaCandidates: vi.fn(async () => []),
  getIqaCandidatesByIds: vi.fn(async () => []),
  decideIqaSample: vi.fn(),
  acknowledgeIqaSample: vi.fn(async () => ({})),
  deletePendingIqaSample: vi.fn(async () => ({ id: 'x' }))
}));
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => false),
  isCourseTutorForLearner: vi.fn(async () => false),
  isCourseTutor: vi.fn(async () => false),
  listTutorsForLearnerInOrg: vi.fn(async () => [])
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@api/services/comms/notify', () => ({ emitNotification: vi.fn(async () => undefined) }));

import * as q from '@cio/db/queries/apprenticeship';
import { isTutorAllocatedToLearner } from '@cio/db/queries/allocation';
import { emitNotification } from '@api/services/comms/notify';
import {
  acknowledgeIqaOutcome,
  createIqaSample,
  decideIqaSampleOutcome,
  deleteIqaSample,
  getEvidenceIqa,
  getIqaCoverage,
  listIqaSamples,
  putIqaTarget,
  suggestIqaSamples
} from '@api/services/apprenticeship/iqa';
import { AppError } from '@api/utils/errors';
import { ZIqaDecide, ZIqaSuggest } from '@cio/utils/validation/apprenticeship';

const ORG = 'org-1';
const PROG = '11111111-1111-4111-8111-111111111111';
const LRN = '22222222-2222-4222-8222-222222222222';
const EV = '55555555-5555-4555-8555-555555555555';
const ENR = '33333333-3333-4333-8333-333333333333';
const SAMPLE = '66666666-6666-4666-8666-666666666666';
const DECIDED = '2026-11-11 10:00:00.123456+00';

const admin = { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG } as Actor;
const assessor = { authenticated: true, userId: 'u-assessor', role: 'TUTOR', status: 'ACTIVE', orgId: ORG } as Actor;
const tutor = { ...assessor, userId: 'u-other-tutor' } as Actor;
const learner = { authenticated: true, userId: LRN, role: 'LEARNER', status: 'ACTIVE', orgId: ORG } as Actor;
const otherOrgAdmin = { ...admin, orgId: 'org-2' } as Actor;

const evidence = (o: Record<string, unknown> = {}) => ({
  id: EV,
  organizationId: ORG,
  programmeId: PROG,
  learnerId: LRN,
  status: 'ACCEPTED',
  title: 'Evidence',
  reviewedBy: 'u-assessor',
  enrolmentId: ENR,
  ...o
});
const sample = (o: Record<string, unknown> = {}) => ({
  id: SAMPLE,
  organizationId: ORG,
  evidenceId: EV,
  assessorId: 'u-assessor',
  outcome: 'PENDING',
  ...o
});
const cov = (accepted: number, sampled: number, assessorId = 'a1', sampledAccepted = sampled) => ({
  assessorId,
  name: assessorId,
  accepted,
  sampled,
  sampledAccepted,
  pending: 0,
  agree: 0,
  disagree: 0,
  awaitingAck: 0
});

async function status(p: Promise<unknown>) {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof AppError ? e.statusCode : 500;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.getIqaEvidenceContext).mockResolvedValue(evidence() as never);
  vi.mocked(q.getIqaSample).mockResolvedValue(sample() as never);
  vi.mocked(q.getIqaTargetPct).mockResolvedValue(null);
  vi.mocked(q.getIqaSampleViewByEvidence).mockResolvedValue(null);
  vi.mocked(q.isProgrammeTutor).mockResolvedValue(false);
  vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(false);
  vi.mocked(q.insertIqaSample).mockResolvedValue({ id: SAMPLE } as never);
  vi.mocked(q.listIqaAssessorCoverage).mockResolvedValue([]);
  vi.mocked(q.pickIqaCandidates).mockResolvedValue([]);
  vi.mocked(q.decideIqaSample).mockResolvedValue(sample({ outcome: 'DISAGREE' }) as never);
});

describe('access matrix', () => {
  it('admin-only actions refuse tutors and learners (403), other orgs get 404', async () => {
    for (const who of [assessor, learner]) {
      expect(await status(getIqaCoverage(who, {}))).toBe(403);
      expect(await status(createIqaSample(who, { evidenceId: EV }))).toBe(403);
      expect(await status(suggestIqaSamples(who, { max: 10, preview: true }))).toBe(403);
      expect(await status(deleteIqaSample(who, SAMPLE))).toBe(403);
      expect(await status(putIqaTarget(who, { iqaTargetPct: 20 }))).toBe(403);
    }
    expect(await status(createIqaSample(otherOrgAdmin, { evidenceId: EV }))).toBe(404);
    expect(
      await status(decideIqaSampleOutcome(otherOrgAdmin, SAMPLE, { outcome: 'AGREE', expectedOutcome: 'PENDING' }))
    ).toBe(404);
  });

  it('samples list: admin sees the org, a tutor only their own, a learner gets 404', async () => {
    await listIqaSamples(admin, { programmeId: PROG });
    expect(q.listIqaSampleViews).toHaveBeenLastCalledWith(ORG, { programmeId: PROG });
    await listIqaSamples(assessor, { outcome: 'DISAGREE' });
    expect(q.listIqaSampleViews).toHaveBeenLastCalledWith(ORG, { outcome: 'DISAGREE', assessorId: 'u-assessor' });
    expect(await listIqaSamples(assessor, { assessorId: 'someone-else' })).toEqual([]);
    expect(await status(listIqaSamples(learner, {}))).toBe(404);
  });

  it("evidence's sample: admin, a tutor who reaches the learner, the assessor; not another tutor, learner or org", async () => {
    expect(await status(getEvidenceIqa(admin, EV))).toBe(200);
    expect(await status(getEvidenceIqa(tutor, EV))).toBe(404);

    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(true);
    expect(await status(getEvidenceIqa(tutor, EV))).toBe(200);
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(false);

    vi.mocked(q.getIqaSampleViewByEvidence).mockResolvedValue({ id: SAMPLE, assessorId: 'u-assessor' } as never);
    expect(await status(getEvidenceIqa(assessor, EV))).toBe(200);
    expect(await status(getEvidenceIqa(tutor, EV))).toBe(404);
    expect(await status(getEvidenceIqa(learner, EV))).toBe(404);
    expect(await status(getEvidenceIqa(otherOrgAdmin, EV))).toBe(404);
  });
});

describe('manual sample', () => {
  it('samples ACCEPTED or REFERRED evidence, with the reviewer as assessor', async () => {
    for (const st of ['ACCEPTED', 'REFERRED']) {
      vi.mocked(q.getIqaEvidenceContext).mockResolvedValue(evidence({ status: st }) as never);
      expect(await status(createIqaSample(admin, { evidenceId: EV }))).toBe(200);
    }
    expect(q.insertIqaSample).toHaveBeenLastCalledWith({
      organizationId: ORG,
      enrolmentId: ENR,
      evidenceId: EV,
      assessorId: 'u-assessor',
      sampledBy: 'u-admin'
    });
  });

  it('refuses unassessed evidence and evidence with no reviewer (400)', async () => {
    vi.mocked(q.getIqaEvidenceContext).mockResolvedValue(evidence({ status: 'SUBMITTED' }) as never);
    expect(await status(createIqaSample(admin, { evidenceId: EV }))).toBe(400);
    vi.mocked(q.getIqaEvidenceContext).mockResolvedValue(evidence({ reviewedBy: null }) as never);
    expect(await status(createIqaSample(admin, { evidenceId: EV }))).toBe(400);
    expect(q.insertIqaSample).not.toHaveBeenCalled();
  });

  it('an already sampled evidence is a 409', async () => {
    vi.mocked(q.insertIqaSample).mockResolvedValue(null);
    expect(await status(createIqaSample(admin, { evidenceId: EV }))).toBe(409);
  });

  it('unknown evidence is a 404', async () => {
    vi.mocked(q.getIqaEvidenceContext).mockResolvedValue(null);
    expect(await status(createIqaSample(admin, { evidenceId: EV }))).toBe(404);
  });
});

describe('coverage and target', () => {
  it('returns the default target and the percentages', async () => {
    vi.mocked(q.listIqaAssessorCoverage).mockResolvedValue([cov(20, 5), cov(0, 0, 'a2')]);
    const r = await getIqaCoverage(admin, {});
    expect(r.targetPct).toBe(10);
    expect(r.assessors.map((a) => a.pct)).toEqual([25, 0]);
  });

  it('target is saved through the settings upsert only', async () => {
    expect(await putIqaTarget(admin, { iqaTargetPct: 25 })).toEqual({ targetPct: 25 });
    expect(q.putIqaTargetPct).toHaveBeenCalledWith(ORG, 25);
  });
});

describe('suggest', () => {
  const pick = (n: number, assessorId = 'a1') => ({
    evidenceId: `e${n}`,
    enrolmentId: ENR,
    assessorId,
    assessorName: 'A'
  });

  it('needs ceil(accepted x target) minus what is already sampled, per assessor', async () => {
    vi.mocked(q.listIqaAssessorCoverage).mockResolvedValue([cov(25, 1, 'a1'), cov(30, 3, 'a2'), cov(40, 9, 'a3')]);
    await suggestIqaSamples(admin, { max: 100, preview: true });
    // 10%: a1 ceil(2.5)=3-1=2, a2 3-3=0, a3 4-9 -> 0
    expect(q.pickIqaCandidates).toHaveBeenCalledWith(ORG, [{ assessorId: 'a1', n: 2 }], {}, 100);
  });

  it('uses the configured target and the max', async () => {
    vi.mocked(q.getIqaTargetPct).mockResolvedValue(50);
    vi.mocked(q.listIqaAssessorCoverage).mockResolvedValue([cov(10, 0)]);
    await suggestIqaSamples(admin, { max: 3, preview: true, programmeId: PROG });
    expect(q.pickIqaCandidates).toHaveBeenCalledWith(ORG, [{ assessorId: 'a1', n: 5 }], { programmeId: PROG }, 3);
  });

  it('preview returns the picks and inserts nothing', async () => {
    vi.mocked(q.listIqaAssessorCoverage).mockResolvedValue([cov(10, 0)]);
    vi.mocked(q.pickIqaCandidates).mockResolvedValue([pick(1)] as never);
    const r = (await suggestIqaSamples(admin, { max: 10, preview: true })) as { id: null; evidenceId: string }[];
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: null, evidenceId: 'e1', outcome: 'PENDING' });
    expect(q.insertIqaSamples).not.toHaveBeenCalled();
  });

  it('without preview it creates the picks and returns the saved rows', async () => {
    vi.mocked(q.listIqaAssessorCoverage).mockResolvedValue([cov(10, 0)]);
    vi.mocked(q.pickIqaCandidates).mockResolvedValue([pick(1)] as never);
    const r = await suggestIqaSamples(admin, { max: 10, preview: false });
    expect(q.insertIqaSamples).toHaveBeenCalledWith([
      { organizationId: ORG, enrolmentId: ENR, evidenceId: 'e1', assessorId: 'a1', sampledBy: 'u-admin' }
    ]);
    expect(r).toEqual([{ id: 'new-0' }]);
  });

  it('confirming a preview saves exactly those evidence ids (re-checked), never a new random draw', async () => {
    vi.mocked(q.getIqaCandidatesByIds).mockResolvedValue([pick(1)] as never);
    await suggestIqaSamples(admin, { max: 10, preview: false, evidenceIds: ['e1', 'e2'], programmeId: PROG });
    expect(q.getIqaCandidatesByIds).toHaveBeenCalledWith(ORG, ['e1', 'e2'], {
      programmeId: PROG,
      assessorId: undefined
    });
    expect(q.pickIqaCandidates).not.toHaveBeenCalled();
    expect(q.insertIqaSamples).toHaveBeenCalledWith([
      { organizationId: ORG, enrolmentId: ENR, evidenceId: 'e1', assessorId: 'a1', sampledBy: 'u-admin' }
    ]);
  });

  it('quota counts only samples whose evidence is still accepted (pct never above 100)', async () => {
    // 10 accepted, 3 samples of which 2 were later referred: 1 still counts, ceil(1.0)=1 → nothing needed;
    // with 20 accepted ceil(2)=2-1 = 1 more.
    vi.mocked(q.listIqaAssessorCoverage).mockResolvedValue([cov(20, 3, 'a1', 1)]);
    await suggestIqaSamples(admin, { max: 100, preview: true });
    expect(q.pickIqaCandidates).toHaveBeenCalledWith(ORG, [{ assessorId: 'a1', n: 1 }], {}, 100);
    vi.mocked(q.listIqaAssessorCoverage).mockResolvedValue([cov(2, 3, 'a1', 1)]);
    expect((await getIqaCoverage(admin, {})).assessors[0].pct).toBe(50);
  });

  it('nothing needed means nothing picked', async () => {
    vi.mocked(q.listIqaAssessorCoverage).mockResolvedValue([cov(10, 1)]);
    expect(await suggestIqaSamples(admin, { max: 10, preview: false })).toEqual([]);
  });

  it('validator defaults and bounds', () => {
    expect(ZIqaSuggest.parse({})).toMatchObject({ max: 100, preview: false });
    expect(ZIqaSuggest.safeParse({ max: 101 }).success).toBe(false);
  });
});

describe('decide', () => {
  it('DISAGREE needs feedback (validator)', () => {
    expect(ZIqaDecide.safeParse({ outcome: 'DISAGREE', expectedOutcome: 'PENDING' }).success).toBe(false);
    expect(ZIqaDecide.safeParse({ outcome: 'DISAGREE', feedback: '  ', expectedOutcome: 'PENDING' }).success).toBe(
      false
    );
    expect(ZIqaDecide.safeParse({ outcome: 'AGREE', expectedOutcome: 'PENDING' }).success).toBe(true);
  });

  it('a stale decision is a 409', async () => {
    vi.mocked(q.decideIqaSample).mockResolvedValue(null);
    expect(await status(decideIqaSampleOutcome(admin, SAMPLE, { outcome: 'AGREE', expectedOutcome: 'PENDING' }))).toBe(
      409
    );
    expect(emitNotification).not.toHaveBeenCalled();
  });

  it('records the outcome, notifies the assessor once and never touches the evidence', async () => {
    await decideIqaSampleOutcome(admin, SAMPLE, { outcome: 'DISAGREE', feedback: 'Weak', expectedOutcome: 'PENDING' });
    expect(q.decideIqaSample).toHaveBeenCalledWith(
      SAMPLE,
      { outcome: 'PENDING', decidedAt: undefined },
      {
        outcome: 'DISAGREE',
        feedback: 'Weak',
        decidedBy: 'u-admin'
      }
    );
    expect(emitNotification).toHaveBeenCalledTimes(1);
    expect(emitNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'appr.iqa.outcome',
        recipients: [{ userId: 'u-assessor' }],
        entityType: 'appr_evidence',
        entityId: EV
      })
    );
  });

  it('does not notify the admin who is also the assessor, nor a sample with no assessor', async () => {
    vi.mocked(q.decideIqaSample).mockResolvedValue(sample({ assessorId: 'u-admin' }) as never);
    await decideIqaSampleOutcome(admin, SAMPLE, { outcome: 'AGREE', expectedOutcome: 'PENDING' });
    vi.mocked(q.decideIqaSample).mockResolvedValue(sample({ assessorId: null }) as never);
    await decideIqaSampleOutcome(admin, SAMPLE, { outcome: 'AGREE', expectedOutcome: 'PENDING' });
    expect(emitNotification).not.toHaveBeenCalled();
  });

  it('changing a decision checks the decided_at the admin saw', async () => {
    await decideIqaSampleOutcome(admin, SAMPLE, {
      outcome: 'AGREE',
      expectedOutcome: 'AGREE',
      expectedDecidedAt: DECIDED
    });
    expect(q.decideIqaSample).toHaveBeenCalledWith(
      SAMPLE,
      { outcome: 'AGREE', decidedAt: DECIDED },
      { outcome: 'AGREE', feedback: null, decidedBy: 'u-admin' }
    );
  });

  it('a failing notification never undoes the decision', async () => {
    vi.mocked(emitNotification).mockRejectedValueOnce(new Error('boom'));
    expect(await status(decideIqaSampleOutcome(admin, SAMPLE, { outcome: 'AGREE', expectedOutcome: 'PENDING' }))).toBe(
      200
    );
  });
});

describe('acknowledge', () => {
  it('only the assessor, only once decided', async () => {
    vi.mocked(q.getIqaSample).mockResolvedValue(sample({ outcome: 'DISAGREE' }) as never);
    expect(await status(acknowledgeIqaOutcome(assessor, SAMPLE, { decidedAt: DECIDED }))).toBe(200);
    expect(q.acknowledgeIqaSample).toHaveBeenCalledWith(SAMPLE, 'u-assessor', DECIDED);
    expect(await status(acknowledgeIqaOutcome(tutor, SAMPLE, { decidedAt: DECIDED }))).toBe(404);
    expect(await status(acknowledgeIqaOutcome(admin, SAMPLE, { decidedAt: DECIDED }))).toBe(404);
    expect(await status(acknowledgeIqaOutcome(learner, SAMPLE, { decidedAt: DECIDED }))).toBe(404);

    vi.mocked(q.getIqaSample).mockResolvedValue(sample({ outcome: 'PENDING' }) as never);
    expect(await status(acknowledgeIqaOutcome(assessor, SAMPLE, { decidedAt: DECIDED }))).toBe(409);
  });

  it('a decision changed since the assessor saw it is a 409', async () => {
    vi.mocked(q.getIqaSample).mockResolvedValue(sample({ outcome: 'AGREE' }) as never);
    vi.mocked(q.acknowledgeIqaSample).mockResolvedValueOnce(null as never);
    expect(await status(acknowledgeIqaOutcome(assessor, SAMPLE, { decidedAt: DECIDED }))).toBe(409);
  });

  it('is idempotent (acknowledging twice succeeds)', async () => {
    vi.mocked(q.getIqaSample).mockResolvedValue(sample({ outcome: 'AGREE' }) as never);
    expect(await status(acknowledgeIqaOutcome(assessor, SAMPLE, { decidedAt: DECIDED }))).toBe(200);
    expect(await status(acknowledgeIqaOutcome(assessor, SAMPLE, { decidedAt: DECIDED }))).toBe(200);
  });
});

describe('delete', () => {
  it('only a PENDING sample', async () => {
    expect(await status(deleteIqaSample(admin, SAMPLE))).toBe(200);
    expect(q.deletePendingIqaSample).toHaveBeenCalledWith(SAMPLE);
    vi.mocked(q.getIqaSample).mockResolvedValue(sample({ outcome: 'AGREE' }) as never);
    expect(await status(deleteIqaSample(admin, SAMPLE))).toBe(409);
  });

  it('a sample that was decided meanwhile is a 409', async () => {
    vi.mocked(q.deletePendingIqaSample).mockResolvedValueOnce(null as never);
    expect(await status(deleteIqaSample(admin, SAMPLE))).toBe(409);
  });
});
