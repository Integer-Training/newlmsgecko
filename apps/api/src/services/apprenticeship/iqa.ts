import { AppError, ErrorCodes } from '@api/utils/errors';
import { canAccessLearner, requireAuthed } from '@api/services/apprenticeship/access';
import { EVIDENCE_ENTITY, notifySafely } from '@api/services/apprenticeship/notifications';
import { emitNotification } from '@api/services/comms/notify';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import {
  acknowledgeIqaSample,
  decideIqaSample,
  deletePendingIqaSample,
  getIqaCandidatesByIds,
  getIqaEvidenceContext,
  getIqaSample,
  getIqaSampleView,
  getIqaSampleViewByEvidence,
  getIqaTargetPct,
  insertIqaSample,
  insertIqaSamples,
  listIqaAssessorCoverage,
  listIqaSampleViews,
  listIqaSampleViewsByIds,
  listIqaUnitCoverage,
  pickIqaCandidates,
  putIqaTargetPct,
  type ApprIqaSampleView
} from '@cio/db/queries/apprenticeship';
import { APPR_IQA_TARGET_PCT_DEFAULT } from '@cio/utils/constants/apprenticeship';
import type {
  IqaAcknowledgeInput,
  IqaDecideInput,
  IqaQueryInput,
  IqaSampleCreateInput,
  IqaSuggestInput,
  IqaTargetPutInput
} from '@cio/utils/validation/apprenticeship';

// Gecko Apprenticeships — IQA sampling. An admin (the internal quality assurer) samples assessed evidence, agrees or
// disagrees with the assessor's decision and leaves feedback; the assessor (appr_evidence.reviewed_by at sampling time)
// sees and acknowledges it. IQA is internal: learners never see it, managers have no access, and a DISAGREE NEVER
// changes the evidence status (an admin may refer the evidence separately through the normal review).
//   ADMIN → everything in their org.
//   TUTOR → only samples where they are the assessor (their own IQA feedback), plus the sample on evidence of a learner
//           they reach.
// Anything not visible is a 404 so ids of other orgs cannot be probed.

type AuthedActor = Extract<Actor, { authenticated: true }>;

/** A suggested pick that is not saved yet (preview): the list shape with no sample id. */
export type IqaSuggestionPreview = Omit<ApprIqaSampleView, 'id'> & { id: null };

const notFound = (what = 'Sample') => new AppError(`${what} not found`, ErrorCodes.NOT_FOUND, 404);
const badRequest = (message: string, field?: string) => new AppError(message, ErrorCodes.VALIDATION_ERROR, 400, field);
const conflict = (message: string) => new AppError(message, ErrorCodes.CONFLICT, 409);

function assertAdmin(actor: Actor): AuthedActor {
  const a = requireAuthed(actor);
  if (a.role !== 'ADMIN') throw new AppError('Only an admin can manage IQA sampling', ErrorCodes.FORBIDDEN, 403);
  return a;
}

/** Admin or tutor; a learner (or anyone else) gets a 404 — IQA does not exist for them. */
function assertAdminOrTutor(actor: Actor): AuthedActor {
  const a = requireAuthed(actor);
  if (a.role !== 'ADMIN' && a.role !== 'TUTOR') throw notFound();
  return a;
}

async function targetPctOf(organizationId: string) {
  return (await getIqaTargetPct(organizationId)) ?? APPR_IQA_TARGET_PCT_DEFAULT;
}

const pctOf = (sampled: number, accepted: number) => (accepted > 0 ? Math.round((sampled / accepted) * 100) : 0);

// ── Reads ──

export async function getIqaCoverage(actor: Actor, query: IqaQueryInput) {
  const a = assertAdmin(actor);
  const filter = { programmeId: query.programmeId, assessorId: query.assessorId };
  const [targetPct, assessorRows, unitRows] = await Promise.all([
    targetPctOf(a.orgId),
    listIqaAssessorCoverage(a.orgId, filter),
    listIqaUnitCoverage(a.orgId, { programmeId: query.programmeId })
  ]);
  return {
    targetPct,
    assessors: assessorRows.map((r) => ({ ...r, pct: pctOf(r.sampledAccepted, r.accepted) })),
    units: unitRows.map((r) => ({ ...r, pct: pctOf(r.sampled, r.accepted) }))
  };
}

export async function listIqaSamples(actor: Actor, query: IqaQueryInput) {
  const a = assertAdminOrTutor(actor);
  if (a.role === 'TUTOR') {
    // A tutor only ever sees samples of their own assessments; asking for someone else's assessor id finds nothing.
    if (query.assessorId && query.assessorId !== a.userId) return [];
    return listIqaSampleViews(a.orgId, { ...query, assessorId: a.userId });
  }
  return listIqaSampleViews(a.orgId, query);
}

/** The sample on one evidence, or null. Admin, a tutor who reaches the learner on that programme, or the assessor. */
export async function getEvidenceIqa(actor: Actor, evidenceId: string) {
  const a = assertAdminOrTutor(actor);
  const ctx = await getIqaEvidenceContext(evidenceId);
  if (!ctx || ctx.organizationId !== a.orgId) throw notFound('Evidence');
  const view = await getIqaSampleViewByEvidence(a.orgId, evidenceId);
  if (a.role === 'TUTOR') {
    const allowed =
      view?.assessorId === a.userId || (await canAccessLearner(a, ctx.organizationId, ctx.learnerId, ctx.programmeId));
    if (!allowed) throw notFound('Evidence');
  }
  return view;
}

// ── Sampling ──

/** Manual "Sample for IQA": ACCEPTED or REFERRED evidence that has a reviewer. One sample per evidence. */
export async function createIqaSample(actor: Actor, input: IqaSampleCreateInput) {
  const a = assertAdmin(actor);
  const ctx = await getIqaEvidenceContext(input.evidenceId);
  if (!ctx || ctx.organizationId !== a.orgId) throw notFound('Evidence');
  if (ctx.status !== 'ACCEPTED' && ctx.status !== 'REFERRED') {
    throw badRequest('Only assessed (accepted or referred) evidence can be sampled', 'evidenceId');
  }
  if (!ctx.reviewedBy) throw badRequest('This evidence has no assessor to sample', 'evidenceId');
  if (!ctx.enrolmentId) throw notFound('Learner portfolio');

  const row = await insertIqaSample({
    organizationId: a.orgId,
    enrolmentId: ctx.enrolmentId,
    evidenceId: ctx.id,
    assessorId: ctx.reviewedBy,
    sampledBy: a.userId
  });
  if (!row) throw conflict('This evidence is already sampled');
  await recordAudit({
    actor: a,
    action: 'appr.iqa.sample',
    entityType: 'appr_iqa_sample',
    entityId: row.id,
    metadata: { evidenceId: ctx.id, assessorId: ctx.reviewedBy }
  });
  return (await getIqaSampleView(a.orgId, row.id)) as ApprIqaSampleView;
}

/**
 * Suggest: per assessor, needed = ceil(accepted × target%) − already sampled (never below 0); pick that many random
 * unsampled ACCEPTED evidence (all assessors together capped at `max`). Preview returns the picks only; otherwise they
 * are created, skipping any sampled meanwhile.
 */
export async function suggestIqaSamples(actor: Actor, input: IqaSuggestInput) {
  const a = assertAdmin(actor);
  const [targetPct, assessors] = await Promise.all([
    targetPctOf(a.orgId),
    listIqaAssessorCoverage(a.orgId, { programmeId: input.programmeId, assessorId: input.assessorId })
  ]);
  // Quota counts only samples whose evidence is still ACCEPTED (a later referral frees the slot up again).
  const quotas = assessors
    .map((r) => ({
      assessorId: r.assessorId,
      n: Math.max(0, Math.ceil((r.accepted * targetPct) / 100) - r.sampledAccepted)
    }))
    .filter((q) => q.n > 0);
  // Confirming a preview saves exactly what the admin saw (still-eligible ids only), never a fresh random draw.
  const picks =
    !input.preview && input.evidenceIds
      ? await getIqaCandidatesByIds(a.orgId, input.evidenceIds.slice(0, input.max), {
          programmeId: input.programmeId,
          assessorId: input.assessorId
        })
      : await pickIqaCandidates(a.orgId, quotas, { programmeId: input.programmeId }, input.max);

  if (input.preview) {
    return picks.map(
      (p): IqaSuggestionPreview => ({
        id: null,
        outcome: 'PENDING',
        feedback: null,
        createdAt: new Date().toISOString(),
        decidedAt: null,
        acknowledgedAt: null,
        evidenceId: p.evidenceId,
        evidenceTitle: p.evidenceTitle,
        evidenceStatus: p.evidenceStatus,
        evidenceTypeKey: p.evidenceTypeKey,
        enrolmentId: p.enrolmentId,
        programmeId: p.programmeId,
        programmeTitle: p.programmeTitle,
        learnerId: p.learnerId,
        learnerName: p.learnerName,
        assessorId: p.assessorId,
        assessorName: p.assessorName,
        sampledByName: null,
        decidedByName: null
      })
    );
  }

  const created = await insertIqaSamples(
    picks.map((p) => ({
      organizationId: a.orgId,
      enrolmentId: p.enrolmentId,
      evidenceId: p.evidenceId,
      assessorId: p.assessorId,
      sampledBy: a.userId
    }))
  );
  if (created.length > 0) {
    await recordAudit({
      actor: a,
      action: 'appr.iqa.suggest',
      entityType: 'appr_iqa_sample',
      entityId: created[0].id,
      metadata: { created: created.length, targetPct, programmeId: input.programmeId ?? null }
    });
  }
  return listIqaSampleViewsByIds(
    a.orgId,
    created.map((r) => r.id)
  );
}

// ── Outcome ──

/** Load a sample in the actor's org, or 404. */
async function loadSample(a: AuthedActor, sampleId: string) {
  const sample = await getIqaSample(sampleId);
  if (!sample || sample.organizationId !== a.orgId) throw notFound();
  return sample;
}

export async function decideIqaSampleOutcome(actor: Actor, sampleId: string, input: IqaDecideInput) {
  const a = assertAdmin(actor);
  const sample = await loadSample(a, sampleId);
  const expected = { outcome: input.expectedOutcome, decidedAt: input.expectedDecidedAt ?? undefined };
  const updated = await decideIqaSample(sample.id, expected, {
    outcome: input.outcome,
    feedback: input.feedback ? input.feedback : null,
    decidedBy: a.userId
  });
  if (!updated) throw conflict('This sample changed — reload');
  await recordAudit({
    actor: a,
    action: 'appr.iqa.decide',
    entityType: 'appr_iqa_sample',
    entityId: sample.id,
    metadata: { evidenceId: sample.evidenceId, outcome: input.outcome, assessorId: sample.assessorId }
  });
  // The assessor hears about it, unless they are the one who decided. Never undoes the decision if it fails.
  if (updated.assessorId && updated.assessorId !== a.userId) {
    await notifySafely('iqa outcome', () =>
      emitNotification({
        type: 'appr.iqa.outcome',
        recipients: [{ userId: updated.assessorId as string }],
        entityType: EVIDENCE_ENTITY,
        entityId: updated.evidenceId
      })
    );
  }
  return (await getIqaSampleView(a.orgId, sample.id)) as ApprIqaSampleView;
}

/** Only the sample's assessor, only once decided. Idempotent: acknowledging again changes nothing. */
export async function acknowledgeIqaOutcome(actor: Actor, sampleId: string, input: IqaAcknowledgeInput) {
  const a = requireAuthed(actor);
  const sample = await loadSample(a, sampleId);
  if (sample.assessorId !== a.userId) throw notFound();
  if (sample.outcome === 'PENDING') throw conflict('This sample has no outcome yet');
  const acked = await acknowledgeIqaSample(sample.id, a.userId, input.decidedAt);
  if (!acked) throw conflict('The IQA decision changed since you opened it — reload');
  return (await getIqaSampleView(a.orgId, sample.id)) as ApprIqaSampleView;
}

/** Remove a sample that has no outcome yet. */
export async function deleteIqaSample(actor: Actor, sampleId: string) {
  const a = assertAdmin(actor);
  const sample = await loadSample(a, sampleId);
  if (sample.outcome !== 'PENDING') throw conflict('Only a sample with no outcome yet can be removed');
  const removed = await deletePendingIqaSample(sample.id);
  if (!removed) throw conflict('This sample changed — reload');
  await recordAudit({
    actor: a,
    action: 'appr.iqa.delete',
    entityType: 'appr_iqa_sample',
    entityId: sample.id,
    metadata: { evidenceId: sample.evidenceId }
  });
  return { id: sample.id };
}

// ── Target ──

export async function putIqaTarget(actor: Actor, input: IqaTargetPutInput) {
  const a = assertAdmin(actor);
  await putIqaTargetPct(a.orgId, input.iqaTargetPct);
  await recordAudit({
    actor: a,
    action: 'appr.iqa.target',
    entityType: 'appr_settings',
    entityId: a.orgId,
    metadata: { iqaTargetPct: input.iqaTargetPct }
  });
  return { targetPct: input.iqaTargetPct };
}
