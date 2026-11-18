import { AppError, ErrorCodes } from '@api/utils/errors';
import {
  assertStaff,
  getEnrolmentForActor,
  getProgrammeForActor,
  requireAuthed
} from '@api/services/apprenticeship/access';
import { buildGatewayView, resolveChecklist } from '@api/services/apprenticeship/gateway-core';
import { nameGatewayActors } from '@api/services/apprenticeship/gateway-names';
import { notifyGatewayReadyOrRelease } from '@api/services/apprenticeship/notifications';
import {
  buildEnrolmentProgress,
  recomputeEnrolment,
  todayIso,
  type EnrolmentProgressDetail
} from '@api/services/apprenticeship/progress';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import { runInTransaction, type DbOrTxClient, type TxClient } from '@cio/db/drizzle';
import {
  claimGatewayReady,
  clearGatewayReady,
  getApprEnrolment,
  getApprProgramme,
  getLinkedEnrolment,
  getEnrolmentLearnerIds,
  listCarrierIdsForProgramme,
  passGateway,
  reopenGateway as reopenGatewayRow,
  setEpa,
  setLinkedAchievedAt,
  setGatewayTick,
  updateApprProgramme
} from '@cio/db/queries/apprenticeship';
import { APPR_EPA_ACHIEVING_RESULTS, type ApprEpaResult } from '@cio/utils/constants/apprenticeship';
import type { EpaUpdateInput, GatewayChecklistPutInput, GatewayTickInput } from '@cio/utils/validation/apprenticeship';

// Gecko Apprenticeships — the gateway checklist and the end-point assessment (EPA).
//   Programme setup (ADMIN): the checklist. Null on the programme = the default. AUTO_UNITS / AUTO_OTJ are computed LIVE
//   from progress; MANUAL items are ticked by staff. Ticks for items later removed from the checklist are ignored.
//   Per learner (staff = ADMIN or allocated TUTOR; the apprentice reads only): tick manual items → "ready" (computed on
//   read, so a referral after the last tick makes it not-ready again) → Confirm gateway (locks the checklist) → EPA
//   booked date → EPA result + date (an achieving result sets achieved_at, FAIL clears it). Reopen is ADMIN only and
//   refused once a result exists. Every tick / confirm re-derives the cache in the SAME transaction; "ready" alerts are
//   claimed (once) in that transaction and sent after commit.

/** Enrolments recomputed per transaction when a programme checklist changes. */
export const GATEWAY_RECOMPUTE_BATCH = 100;

const badRequest = (message: string, field?: string) => new AppError(message, ErrorCodes.VALIDATION_ERROR, 400, field);
const conflict = (message: string) => new AppError(message, ErrorCodes.CONFLICT, 409);

const audit = (actor: Actor, action: string, entityId: string, metadata: Record<string, unknown> = {}) =>
  recordAudit({ actor, action, entityType: 'appr_enrolment', entityId, metadata });

/**
 * Gateway endpoints act on the CARRIER of an apprenticeship: given a component id they follow the link (access was
 * checked on the id the caller passed). A standalone enrolment is its own carrier.
 */
async function carrierOf<T extends { id: string; primaryEnrolmentId: string | null }>(enrolment: T): Promise<T> {
  if (!enrolment.primaryEnrolmentId) return enrolment;
  const carrier = await getApprEnrolment(enrolment.primaryEnrolmentId);
  return (carrier ?? enrolment) as unknown as T;
}

/**
 * The carrier's progress with the gateway worked out for the whole apprenticeship: for a linked pair the "all units
 * complete" item counts units complete / total summed across BOTH qualifications (checklist, ticks and the gateway /
 * EPA fields all live on the carrier). Reads only. Standalone = buildEnrolmentProgress unchanged.
 */
export async function buildApprenticeshipProgress(
  carrierId: string,
  client?: DbOrTxClient
): Promise<EnrolmentProgressDetail | null> {
  const detail = await buildEnrolmentProgress(carrierId, client);
  if (!detail) return null;
  const component = await getLinkedEnrolment(carrierId, client);
  if (!component || component.id === carrierId) return detail;
  const [other, enrolment] = await Promise.all([
    buildEnrolmentProgress(component.id, client),
    getApprEnrolment(carrierId, client)
  ]);
  if (!other || !enrolment) return detail;
  const programme = await getApprProgramme(enrolment.programmeId, client);
  const complete = (d: EnrolmentProgressDetail) => d.units.filter((u) => u.status === 'COMPLETE').length;
  const gateway = buildGatewayView({
    checklist: resolveChecklist(programme?.gatewayChecklist),
    manual: enrolment.gatewayItems,
    unitsTotal: detail.units.length + other.units.length,
    unitsComplete: complete(detail) + complete(other),
    otjMinutes: detail.otjMinutes,
    otjTargetMinutes: detail.otjTargetMinutes,
    enrolment
  });
  return { ...detail, gateway };
}

/** Re-derive the caches and the ready flag (pair-aware) inside the caller's transaction. */
async function recomputeApprenticeship(tx: TxClient, carrierId: string) {
  const component = await getLinkedEnrolment(carrierId, tx);
  if (!component || component.id === carrierId) return recomputeEnrolment(tx, carrierId, { claimGatewayReady: true });
  // recomputeEnrolment on a linked enrolment refreshes BOTH halves (component first), so one call is enough.
  await recomputeEnrolment(tx, carrierId);
  const full = await buildApprenticeshipProgress(carrierId, tx);
  if (!full) return null;
  // Readiness is the pair's, not the carrier's own: override the flag recomputeEnrolment set from the carrier alone.
  if (!full.gateway.locked) {
    if (!full.gateway.ready) await clearGatewayReady(tx, carrierId);
    else full.gatewayReadyClaimed = await claimGatewayReady(tx, carrierId);
  }
  return full;
}

// ── Programme checklist ──

export async function getGatewayChecklist(actor: Actor, programmeId: string) {
  const programme = await getProgrammeForActor(actor, programmeId);
  return {
    checklist: resolveChecklist(programme.gatewayChecklist),
    isDefault: !programme.gatewayChecklist || programme.gatewayChecklist.length === 0
  };
}

export async function putGatewayChecklist(actor: Actor, programmeId: string, input: GatewayChecklistPutInput) {
  const programme = await getProgrammeForActor(actor, programmeId);
  await runInTransaction((tx) => updateApprProgramme(programmeId, { gatewayChecklist: input.checklist }, tx));
  // Readiness may change for every learner of the programme (confirmed learners are locked and untouched). Recompute in
  // batches so one transaction never holds hundreds of enrolments; each batch claims the ready flag and the alerts go
  // out only after that batch has committed.
  // The gateway lives on the carrier of a linked pair, so recompute through the carrier (recomputeEnrolment hops to the
  // counterpart and refreshes both sides): a component id resolves to its carrier, a pair is done once, and the claim /
  // alert always names the carrier.
  const ids = await listCarrierIdsForProgramme(programmeId);
  for (let i = 0; i < ids.length; i += GATEWAY_RECOMPUTE_BATCH) {
    const batch = ids.slice(i, i + GATEWAY_RECOMPUTE_BATCH);
    const claimed = await runInTransaction(async (tx) => {
      const out = new Set<string>();
      for (const id of batch) {
        const detail = await recomputeEnrolment(tx, id, { claimGatewayReady: true });
        if (detail?.gatewayReadyClaimed) out.add(detail.gatewayReadyEnrolmentId ?? id);
      }
      return [...out];
    });
    if (claimed.length === 0) continue;
    const learners = await getEnrolmentLearnerIds(claimed);
    for (const id of claimed) {
      const learnerId = learners.get(id);
      if (learnerId) await sendReady({ id, learnerId, organizationId: programme.organizationId });
    }
  }
  await recordAudit({
    actor,
    action: 'appr.gateway.checklist_updated',
    entityType: 'appr_programme',
    entityId: programmeId,
    metadata: { items: input.checklist?.length ?? null, reset: input.checklist === null }
  });
  return getGatewayChecklist(actor, programmeId);
}

// ── Per learner ──

/** Gateway + stage for one learner (live auto items). Learners read their own. */
export async function getGateway(actor: Actor, enrolmentId: string) {
  const enrolment = await carrierOf(await getEnrolmentForActor(actor, enrolmentId));
  const detail = await buildApprenticeshipProgress(enrolment.id);
  if (!detail) throw new AppError('Learner portfolio not found', ErrorCodes.NOT_FOUND, 404);
  return { ...(await nameGatewayActors(detail.gateway)), glh: detail.glh };
}

export async function setGatewayItem(actor: Actor, enrolmentId: string, key: string, input: GatewayTickInput) {
  const a = assertStaff(actor);
  const enrolment = await carrierOf(await getEnrolmentForActor(actor, enrolmentId));
  if (enrolment.gatewayPassedAt) throw conflict('The gateway has been confirmed, so the checklist is locked');

  const programme = await getApprProgramme(enrolment.programmeId);
  const item = resolveChecklist(programme?.gatewayChecklist).find((i) => i.key === key);
  if (!item) throw new AppError('Checklist item not found', ErrorCodes.NOT_FOUND, 404);
  if (item.kind !== 'MANUAL') throw badRequest('This item is worked out automatically and cannot be ticked', 'key');

  const result = await runInTransaction(async (tx) => {
    // Conditional on "not confirmed": a confirm that lands first makes this a 409, never a silent change.
    const row = await setGatewayTick(tx, enrolment.id, key, {
      done: input.done,
      note: input.note ?? null,
      by: a.userId,
      at: new Date().toISOString()
    });
    if (!row) throw conflict('The gateway has been confirmed, so the checklist is locked');
    return recomputeApprenticeship(tx, enrolment.id);
  });
  if (result?.gatewayReadyClaimed) await sendReady(enrolment);
  await audit(actor, 'appr.gateway.item_set', enrolment.id, { key, done: input.done });
  return { ...(await nameGatewayActors(result!.gateway)), glh: result!.glh };
}

export async function confirmGateway(actor: Actor, enrolmentId: string) {
  const a = assertStaff(actor);
  const enrolment = await carrierOf(await getEnrolmentForActor(actor, enrolmentId));
  if (enrolment.gatewayPassedAt) throw conflict('The gateway has already been confirmed');
  await runInTransaction(async (tx) => {
    // Readiness is re-derived inside the transaction, so a referral landing first stops the confirmation.
    const detail = await buildApprenticeshipProgress(enrolment.id, tx);
    if (!detail?.gateway.ready)
      throw badRequest('Every checklist item must be complete before the gateway can be confirmed');
    const row = await passGateway(tx, enrolment.id, a.userId);
    if (!row) throw conflict('The gateway has already been confirmed');
  });
  await audit(actor, 'appr.gateway.confirmed', enrolment.id);
  return getGateway(actor, enrolment.id);
}

/** Reopen a confirmed gateway (ADMIN only). Ticks are kept. Refused once an EPA result exists. */
export async function reopenGateway(actor: Actor, enrolmentId: string) {
  const a = requireAuthed(actor);
  if (a.role !== 'ADMIN') throw new AppError('Only an admin can reopen the gateway', ErrorCodes.FORBIDDEN, 403);
  const enrolment = await carrierOf(await getEnrolmentForActor(actor, enrolmentId));
  if (!enrolment.gatewayPassedAt) throw conflict('The gateway has not been confirmed');
  if (enrolment.epaResult) throw conflict('An EPA result has been recorded, so the gateway cannot be reopened');
  const row = await runInTransaction((tx) => reopenGatewayRow(tx, enrolment.id));
  if (!row) throw conflict('The gateway cannot be reopened');
  await audit(actor, 'appr.gateway.reopened', enrolment.id);
  return getGateway(actor, enrolment.id);
}

/**
 * EPA booking + result. Only after the gateway was confirmed. A result needs its date; an achieving result sets
 * achieved_at to that date, FAIL clears it. Clearing a recorded result is ADMIN only.
 */
export async function updateEpa(actor: Actor, enrolmentId: string, input: EpaUpdateInput, now: Date = new Date()) {
  const a = assertStaff(actor);
  const enrolment = await carrierOf(await getEnrolmentForActor(actor, enrolmentId));
  if (!enrolment.gatewayPassedAt) throw conflict('Confirm the gateway before booking or recording the EPA');

  // Once a result is recorded, changing or clearing it (or its date) is an admin decision.
  const changesRecordedResult =
    Boolean(enrolment.epaResult) &&
    ((input.epaResult !== undefined && input.epaResult !== enrolment.epaResult) ||
      (input.epaResultDate !== undefined && input.epaResultDate !== enrolment.epaResultDate));
  if (changesRecordedResult && a.role !== 'ADMIN') {
    throw new AppError('Only an admin can change or clear a recorded EPA result', ErrorCodes.FORBIDDEN, 403);
  }

  // Dates must make sense against the gateway confirmation and today.
  const passedOn = enrolment.gatewayPassedAt.slice(0, 10);
  if (input.epaBookedDate && input.epaBookedDate < passedOn) {
    throw badRequest('The EPA cannot be booked before the gateway was confirmed', 'epaBookedDate');
  }
  if (input.epaResultDate) {
    if (input.epaResultDate < passedOn) {
      throw badRequest('The result date cannot be before the gateway was confirmed', 'epaResultDate');
    }
    if (input.epaResultDate > todayIso(now)) {
      throw badRequest('The result date cannot be in the future', 'epaResultDate');
    }
  }

  const booked = input.epaBookedDate !== undefined ? input.epaBookedDate : enrolment.epaBookedDate;
  const result = (input.epaResult !== undefined ? input.epaResult : enrolment.epaResult) as ApprEpaResult | null;
  let resultDate = input.epaResultDate !== undefined ? input.epaResultDate : enrolment.epaResultDate;

  if (!result) {
    if (input.epaResultDate) throw badRequest('Choose a result before setting its date', 'epaResult');
    resultDate = null;
  } else if (!resultDate) {
    throw badRequest('A result needs the date it was received', 'epaResultDate');
  }
  const achievedAt =
    result && APPR_EPA_ACHIEVING_RESULTS.includes(result) && resultDate ? `${resultDate}T00:00:00.000Z` : null;

  // One EPA for the whole apprenticeship: the result lives on the carrier, and achieved_at is set (or cleared) on BOTH
  // halves of a pair in the same transaction.
  const row = await runInTransaction(async (tx) => {
    const updated = await setEpa(
      tx,
      enrolment.id,
      { epaBookedDate: booked, epaResult: result, epaResultDate: resultDate, achievedAt },
      // Conditional on the EPA fields as read: a concurrent edit makes this a 409, never a silent overwrite.
      {
        epaBookedDate: enrolment.epaBookedDate,
        epaResult: enrolment.epaResult,
        epaResultDate: enrolment.epaResultDate
      }
    );
    if (updated) await setLinkedAchievedAt(tx, enrolment.id, achievedAt);
    return updated;
  });
  if (!row) throw conflict('The end-point assessment was just changed or the gateway reopened - reload and try again');
  await audit(actor, 'appr.epa.updated', enrolment.id, { fields: Object.keys(input), result: result ?? null });
  return getGateway(actor, enrolment.id);
}

async function sendReady(enrolment: { id: string; learnerId: string; organizationId: string }) {
  // Claimed in the transaction; if the send fails the claim is released so the daily scan retries.
  await notifyGatewayReadyOrRelease({
    enrolmentId: enrolment.id,
    learnerId: enrolment.learnerId,
    organizationId: enrolment.organizationId
  });
}
