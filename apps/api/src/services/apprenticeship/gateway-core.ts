import {
  APPR_DEFAULT_GATEWAY_CHECKLIST,
  APPR_STAGE_LABELS,
  type ApprGatewayItem,
  type ApprStage
} from '@cio/utils/constants/apprenticeship';
import {
  apprStage,
  gatewayState,
  glhDoneMinutes,
  glhExpectedMinutes,
  glhTargetMinutes
} from '@cio/utils/functions/apprenticeship-progress';

// Gecko Apprenticeships — pure GLH + gateway view builders shared by the portfolio, the learners list, the recompute
// and the gateway endpoints, so they can never disagree. No I/O here.

type ManualTicks = Record<string, { done: boolean; by?: string | null; at?: string | null; note?: string | null }>;

/** The programme's own checklist, or the default when it has none. */
export function resolveChecklist(stored: { key: string; label: string; kind: string }[] | null | undefined) {
  return (stored && stored.length > 0 ? stored : APPR_DEFAULT_GATEWAY_CHECKLIST) as readonly ApprGatewayItem[];
}

export interface GatewayEnrolmentFields {
  gatewayPassedAt: string | null;
  gatewayPassedBy?: string | null;
  epaBookedDate: string | null;
  epaResult: string | null;
  epaResultDate: string | null;
  achievedAt?: string | null;
}

export interface GatewayView {
  items: {
    key: string;
    label: string;
    kind: string;
    done: boolean;
    note: string | null;
    by: string | null;
    /** Display name of `by` (filled by withGatewayNames). */
    byName?: string | null;
    at: string | null;
  }[];
  /** Every checklist item is done (live). After confirmation the checklist is locked and this stays as last computed. */
  ready: boolean;
  stage: ApprStage;
  stageLabel: string;
  /** The checklist can no longer be changed (gateway confirmed). */
  locked: boolean;
  gatewayPassedAt: string | null;
  gatewayPassedBy: string | null;
  /** Display name of `gatewayPassedBy` (filled by withGatewayNames). */
  gatewayPassedByName?: string | null;
  epaBookedDate: string | null;
  epaResult: string | null;
  epaResultDate: string | null;
  achievedAt: string | null;
}

/** The view with the display names of whoever ticked / confirmed, given an id → name lookup. */
export function withGatewayNames(view: GatewayView, names: ReadonlyMap<string, string>): GatewayView {
  return {
    ...view,
    items: view.items.map((i) => ({ ...i, byName: i.by ? (names.get(i.by) ?? null) : null })),
    gatewayPassedByName: view.gatewayPassedBy ? (names.get(view.gatewayPassedBy) ?? null) : null
  };
}

/**
 * Gateway state for one learner. Auto items use LIVE progress; manual items use the stored ticks (ticks for items no
 * longer on the checklist are simply ignored). `ready` is recomputed every time, so a referral after the last tick
 * makes the learner not-ready again until the evidence is accepted.
 */
export function buildGatewayView(input: {
  checklist: readonly { key: string; label: string; kind: string }[];
  manual: ManualTicks | null | undefined;
  unitsTotal: number;
  unitsComplete: number;
  otjMinutes: number;
  otjTargetMinutes: number | null;
  enrolment: GatewayEnrolmentFields;
}): GatewayView {
  const manual = input.manual ?? {};
  const state = gatewayState({
    checklist: input.checklist,
    manual,
    unitsTotal: input.unitsTotal,
    unitsComplete: input.unitsComplete,
    otjMinutes: input.otjMinutes,
    otjTargetMinutes: input.otjTargetMinutes
  });
  const e = input.enrolment;
  const stage = apprStage({
    ready: state.ready,
    gatewayPassedAt: e.gatewayPassedAt,
    epaBookedDate: e.epaBookedDate,
    epaResult: e.epaResult
  });
  return {
    items: state.items.map((i) => ({
      ...i,
      note: i.kind === 'MANUAL' ? (manual[i.key]?.note ?? null) : null,
      by: i.kind === 'MANUAL' ? (manual[i.key]?.by ?? null) : null,
      at: i.kind === 'MANUAL' ? (manual[i.key]?.at ?? null) : null
    })),
    ready: state.ready,
    stage,
    stageLabel: APPR_STAGE_LABELS[stage],
    locked: Boolean(e.gatewayPassedAt),
    gatewayPassedAt: e.gatewayPassedAt,
    gatewayPassedBy: e.gatewayPassedBy ?? null,
    epaBookedDate: e.epaBookedDate,
    epaResult: e.epaResult,
    epaResultDate: e.epaResultDate,
    achievedAt: e.achievedAt ?? null
  };
}

export interface GlhView {
  targetMinutes: number | null;
  doneMinutes: number;
  expectedMinutes: number | null;
}

/** GLH target / done / expected. No unit GLH set → target and expected are null (done still counts logged hours). */
export function buildGlhView(
  units: readonly { glh: number | null; complete: boolean }[],
  loggedMinutes: number,
  expectedPct: number | null
): GlhView {
  const targetMinutes = glhTargetMinutes(units);
  return {
    targetMinutes,
    doneMinutes: glhDoneMinutes(units, loggedMinutes),
    expectedMinutes: glhExpectedMinutes(targetMinutes, expectedPct)
  };
}
