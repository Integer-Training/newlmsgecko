import type { TxClient, DbOrTxClient } from '@cio/db/drizzle';
import {
  buildGatewayView,
  buildGlhView,
  resolveChecklist,
  type GatewayView,
  type GlhView
} from '@api/services/apprenticeship/gateway-core';
import {
  claimGatewayReady,
  clearGatewayReady,
  countAcceptedByCriterion,
  getApprEnrolment,
  getApprProgramme,
  getLinkedEnrolment,
  sumGlhLogMinutes,
  sumValidatedOtjLogMinutes,
  getApprSettings,
  getEvidenceTotals,
  listProgrammeCriteria,
  listProgrammeUnits,
  listEnrolmentUnitRows,
  writeEnrolmentCache
} from '@cio/db/queries/apprenticeship';
import { lockEnrolmentsInOrder } from '@api/services/apprenticeship/pair-lock';
import type { ApprSettings } from '@cio/utils/constants/apprenticeship';
import {
  computeEnrolmentProgress,
  todayIso as sharedTodayIso,
  type ApprEnrolmentProgress,
  type ApprUnitInput
} from '@cio/utils/functions/apprenticeship-progress';

// Gecko Apprenticeships — progress. ONE entry point that writes the cache (recomputeEnrolment) and ONE that builds
// the full picture for a learner (buildEnrolmentProgress). Both run the shared rules module, so the learners list,
// the portfolio and the CSV export can never disagree. Expected % and status are date-dependent and therefore always
// computed at read time; only action-driven values (actual %, OTJ minutes, counts) are cached.

/** Today as 'YYYY-MM-DD' in UTC (UK provider; within an hour of local). The rule lives in @cio/utils so the dashboard previews match. */
export const todayIso = sharedTodayIso;

export interface EnrolmentProgressDetail extends ApprEnrolmentProgress {
  enrolmentId: string;
  /** criterionId → accepted evidence count (for the criteria rows / grid). */
  acceptedByCriterion: Map<string, number>;
  totals: { submitted: number; accepted: number; referred: number; otjMinutes: number };
  /** GLH target / done (units + staff logs) / expected — nulls when no unit has GLH. */
  glh: GlhView;
  /** Gateway checklist state with LIVE auto items. */
  gateway: GatewayView;
  /** Set by recomputeEnrolment (opt-in) when THIS call newly made the learner ready - the caller notifies after commit. */
  gatewayReadyClaimed?: boolean;
  /**
   * With gatewayReadyClaimed: the enrolment whose readiness was claimed. The gateway belongs to the CARRIER of a linked
   * pair, so when a component is recomputed this is the carrier's id (absent = the enrolment that was recomputed).
   */
  gatewayReadyEnrolmentId?: string;
}

/** Everything about one learner's progress, from scratch (reads only). Null if the enrolment does not exist. */
export async function buildEnrolmentProgress(
  enrolmentId: string,
  client?: DbOrTxClient,
  opts: { today?: string; settings?: ApprSettings } = {}
): Promise<EnrolmentProgressDetail | null> {
  const enrolment = await getApprEnrolment(enrolmentId, client);
  if (!enrolment) return null;
  // A CARRIER with a linked component owns the learner-level numbers: evidence counts + OTJ minutes across both
  // programmes, plus VALIDATED off-the-job log entries (those live on the carrier only). A component, and any
  // standalone enrolment, counts its own home evidence only. Criteria progress is per criterion's programme either way.
  const isComponent = !!enrolment.primaryEnrolmentId;
  const component = isComponent ? null : await getLinkedEnrolment(enrolmentId, client);
  const [units, criteria, accepted, evidenceTotals, unitRows, settings, programme, loggedGlh, loggedOtj] =
    await Promise.all([
      listProgrammeUnits(enrolment.programmeId, client),
      listProgrammeCriteria(enrolment.programmeId, client),
      countAcceptedByCriterion(enrolment.programmeId, enrolment.learnerId, client),
      getEvidenceTotals(
        enrolment.programmeId,
        enrolment.learnerId,
        client,
        component ? { programmeIds: [enrolment.programmeId, component.programmeId] } : {}
      ),
      listEnrolmentUnitRows(enrolmentId, client),
      opts.settings ? Promise.resolve(opts.settings) : getApprSettings(enrolment.organizationId, client),
      getApprProgramme(enrolment.programmeId, client),
      sumGlhLogMinutes(enrolmentId, client),
      isComponent ? Promise.resolve(0) : sumValidatedOtjLogMinutes(enrolmentId, client)
    ]);
  const totals = { ...evidenceTotals, otjMinutes: evidenceTotals.otjMinutes + loggedOtj };

  const datesByUnit = new Map(unitRows.map((r) => [r.unitId, r]));
  const criteriaByUnit = new Map<string, { acceptedCount: number; requiredCount: number }[]>();
  for (const c of criteria) {
    const list = criteriaByUnit.get(c.unitId) ?? [];
    list.push({ acceptedCount: accepted.get(c.criterionId) ?? 0, requiredCount: c.requiredCount });
    criteriaByUnit.set(c.unitId, list);
  }
  const unitInputs: ApprUnitInput[] = units.map((u) => ({
    unitId: u.unitId,
    startDate: datesByUnit.get(u.unitId)?.startDate ?? null,
    targetDate: datesByUnit.get(u.unitId)?.targetDate ?? null,
    criteria: criteriaByUnit.get(u.unitId) ?? []
  }));

  const progress = computeEnrolmentProgress({
    startDate: enrolment.startDate,
    plannedEndDate: enrolment.plannedEndDate,
    contractedHoursWeek: enrolment.contractedHoursWeek,
    otjOverrideMinutes: enrolment.otjTargetMinutesOverride,
    otjMinutes: totals.otjMinutes,
    units: unitInputs,
    today: opts.today ?? todayIso(),
    settings
  });
  const unitStatus = new Map(progress.units.map((u) => [u.unitId, u.status]));
  const glh = buildGlhView(
    units.map((u) => ({ glh: u.glh ?? null, complete: unitStatus.get(u.unitId) === 'COMPLETE' })),
    loggedGlh,
    progress.expectedPct
  );
  // Gateway AUTO_UNITS on a carrier counts units across BOTH qualifications of the pair. The component is recomputed
  // first (recomputeEnrolment), so its cached unit rows are fresh.
  const componentUnits = component ? await listEnrolmentUnitRows(component.id, client) : [];
  const gateway = buildGatewayView({
    checklist: resolveChecklist(programme?.gatewayChecklist),
    manual: enrolment.gatewayItems,
    unitsTotal: progress.units.length + componentUnits.length,
    unitsComplete:
      progress.units.filter((u) => u.status === 'COMPLETE').length + componentUnits.filter((u) => u.completedAt).length,
    otjMinutes: progress.otjMinutes,
    otjTargetMinutes: progress.otjTargetMinutes,
    enrolment
  });
  return { ...progress, enrolmentId, acceptedByCriterion: accepted, totals, glh, gateway };
}

/**
 * Recompute and store the cache for one enrolment. MUST be called inside the same transaction as any change that
 * affects progress (evidence status/mapping/minutes, criteria required counts, unit set) so readers never see a
 * half-updated learner. Returns the fresh progress so the caller can hand it straight back to the UI.
 */
export async function recomputeEnrolment(
  tx: TxClient,
  enrolmentId: string,
  opts: { claimGatewayReady?: boolean } = {}
): Promise<EnrolmentProgressDetail | null> {
  const self = await getApprEnrolment(enrolmentId, tx);
  if (!self) return null;
  const other = await getLinkedEnrolment(enrolmentId, tx);
  if (!other) return recomputeOne(tx, self, opts);

  // A linked Diploma + Standard pair is one apprenticeship: evidence on either side moves both enrolments' numbers, so
  // BOTH are recomputed here, in the same transaction. Rows are locked in id order (two concurrent writes on the same
  // pair cannot deadlock), and the COMPONENT is computed before the CARRIER so the carrier sees fresh component data.
  // recomputeOne never hops, so there is no recursion.
  await lockEnrolmentsInOrder(tx, [self.id, other.id]);
  const [carrier, component] = self.primaryEnrolmentId ? [other, self] : [self, other];
  const componentDetail = await recomputeOne(tx, component, {});
  const carrierDetail = await recomputeOne(tx, carrier, opts);
  if (self.id === carrier.id) return carrierDetail;
  if (componentDetail && carrierDetail?.gatewayReadyClaimed) {
    componentDetail.gatewayReadyClaimed = true;
    componentDetail.gatewayReadyEnrolmentId = carrier.id;
  }
  return componentDetail;
}

/** Recompute and store the cache of ONE enrolment (no pair hop). The gateway flag only applies to a carrier / standalone. */
async function recomputeOne(
  tx: TxClient,
  enrolment: { id: string; primaryEnrolmentId: string | null },
  opts: { claimGatewayReady?: boolean }
): Promise<EnrolmentProgressDetail | null> {
  const enrolmentId = enrolment.id;
  const detail = await buildEnrolmentProgress(enrolmentId, tx);
  if (!detail) return null;
  await writeEnrolmentCache(
    enrolmentId,
    {
      actualPct: detail.actualPct,
      otjMinutes: detail.otjMinutes,
      submittedCount: detail.totals.submitted,
      acceptedCount: detail.totals.accepted,
      referredCount: detail.totals.referred,
      glhMinutes: detail.glh.doneMinutes,
      units: detail.units.map((u) => ({ unitId: u.unitId, actualPct: u.actualPct, complete: u.status === 'COMPLETE' }))
    },
    tx
  );
  // Gateway readiness flag. Only claimed when the caller opted in (it must then notify after commit); a drop in
  // readiness always clears it so the notification can fire again. Nothing changes once the gateway is confirmed.
  if (!detail.gateway.locked && !enrolment.primaryEnrolmentId) {
    if (!detail.gateway.ready) await clearGatewayReady(tx, enrolmentId);
    else if (opts.claimGatewayReady) detail.gatewayReadyClaimed = await claimGatewayReady(tx, enrolmentId);
  }
  return detail;
}
