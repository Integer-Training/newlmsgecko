import { AppError, ErrorCodes } from '@api/utils/errors';
import { getEnrolmentForActor } from '@api/services/apprenticeship/access';
import { getPortfolio } from '@api/services/apprenticeship/enrolment';
import { todayIso } from '@api/services/apprenticeship/progress';
import { countedHalves } from '@api/services/apprenticeship/withdrawn';
import type { Actor } from '@cio/db/actor';
import {
  getApprEnrolment,
  getApprProgramme,
  getComponentEnrolment,
  getOnboardingCountsForEnrolment,
  getOverviewBreakdown
} from '@cio/db/queries/apprenticeship';
import type { ApprEnrolmentRole, ApprProgrammeType, ApprProgressStatus } from '@cio/utils/constants/apprenticeship';
import { apprenticeshipRollup, otjCompletionPct } from '@cio/utils/functions/apprenticeship-progress';

// Gecko Apprenticeships — the learner overview of one apprenticeship (Diploma + Standard pair, or a single enrolment).
// Shape is FROZEN in dashboard `api/overview.types.ts` (OverviewPayload). Every number comes from the existing
// progress builders (getPortfolio per enrolment), so the overview can never disagree with the qualification pages.

type Portfolio = Awaited<ReturnType<typeof getPortfolio>>;

const notFound = () => new AppError('Learner portfolio not found', ErrorCodes.NOT_FOUND, 404);

function cardOf(p: Portfolio, role: ApprEnrolmentRole, type: ApprProgrammeType, extra: { primaryTitle?: string }) {
  const units = p.qualifications.flatMap((q) => q.units);
  return {
    enrolmentId: p.enrolment.id,
    programmeId: p.enrolment.programmeId,
    title: extra.primaryTitle ?? p.programme.title,
    type,
    level: p.programme.level ?? null,
    startDate: p.enrolment.startDate ?? null,
    plannedEndDate: p.enrolment.plannedEndDate ?? null,
    actualPct: p.summary.actualPct,
    expectedPct: p.summary.expectedPct,
    status: p.summary.status as ApprProgressStatus,
    unitsTotal: units.length,
    unitsComplete: units.filter((u) => u.status === 'COMPLETE').length,
    achievedAt: p.enrolment.achievedAt ? new Date(p.enrolment.achievedAt).toISOString() : null,
    // Set when this qualification is withdrawn (frozen, out of the roll-up and the gateway count).
    withdrawnAt: (p.enrolment.withdrawnAt ? new Date(p.enrolment.withdrawnAt).toISOString() : null) as string | null,
    withdrawalReason: (p.enrolment.withdrawalReason ?? null) as string | null,
    role,
    units: units.map((u) => ({
      id: u.id,
      title: u.title,
      actualPct: u.actualPct,
      status: u.status as ApprProgressStatus,
      // When a COMPLETE unit was completed (its last criterion met); null otherwise.
      achievedAt: (u.achievedAt ?? null) as string | null
    }))
  };
}

/** `enrolmentId` may be the carrier or its linked component; the payload always describes the whole apprenticeship. */
export async function getOverview(actor: Actor, enrolmentId: string) {
  const given = await getEnrolmentForActor(actor, enrolmentId); // 404 when not visible
  let carrier = given;
  if (given.primaryEnrolmentId) {
    const loaded = await getApprEnrolment(given.primaryEnrolmentId);
    if (!loaded || loaded.organizationId !== given.organizationId) throw notFound();
    carrier = loaded;
  }
  const component = await getComponentEnrolment(carrier.id);

  // The carrier must be readable by the caller; the counterpart is shown only when they reach it too.
  const carrierPortfolio = await getPortfolio(actor, carrier.id);
  let componentPortfolio: Portfolio | null = null;
  if (component) {
    try {
      componentPortfolio = await getPortfolio(actor, component.id);
    } catch (error) {
      if (!(error instanceof AppError) || error.statusCode !== 404) throw error;
    }
  }

  const [carrierProgramme, componentProgramme] = await Promise.all([
    getApprProgramme(carrier.programmeId),
    component && componentPortfolio ? getApprProgramme(component.programmeId) : Promise.resolve(null)
  ]);
  const carrierType = (carrierProgramme?.type ?? 'DIPLOMA') as ApprProgrammeType;

  const cards = [
    cardOf(carrierPortfolio, component ? 'CARRIER' : 'STANDALONE', carrierType, {}),
    ...(componentPortfolio
      ? [cardOf(componentPortfolio, 'COMPONENT', (componentProgramme?.type ?? 'STANDARD') as ApprProgrammeType, {})]
      : [])
  ];

  // A withdrawn half is out of the roll-up and the breakdown (unless every half is withdrawn: the frozen numbers show).
  const halves = countedHalves(!!carrier.withdrawnAt, component ? !!component.withdrawnAt : null);
  const counted = cards.filter((c) => (c.enrolmentId === carrier.id ? halves.own : halves.linked));
  const enrolmentIds = counted.map((c) => c.enrolmentId);
  const [breakdown, onboarding] = await Promise.all([
    getOverviewBreakdown(
      { enrolmentIds, programmeIds: counted.map((c) => c.programmeId), learnerId: carrier.learnerId },
      todayIso()
    ),
    getOnboardingCountsForEnrolment(carrier.id)
  ]);

  const s = carrierPortfolio.summary;
  const otj = {
    doneMinutes: s.otj.minutes,
    expectedMinutes: s.otj.expectedMinutes,
    targetMinutes: s.otj.targetMinutes,
    completionPct: otjCompletionPct(s.otj.minutes, s.otj.targetMinutes),
    status: s.otj.status as ApprProgressStatus
  };

  // "Add the paired standard": admins only, a lone Diploma whose programme has an ACTIVE paired Standard.
  let canAddPair: { programmeId: string; title: string } | null = null;
  if (
    actor.authenticated &&
    actor.role === 'ADMIN' &&
    !component &&
    carrierProgramme?.type === 'DIPLOMA' &&
    carrierProgramme.pairedProgrammeId
  ) {
    const paired = await getApprProgramme(carrierProgramme.pairedProgrammeId);
    if (paired && paired.organizationId === carrier.organizationId && paired.status === 'ACTIVE') {
      canAddPair = { programmeId: paired.id, title: paired.title };
    }
  }

  return {
    learner: carrierPortfolio.learner,
    tutors: carrierPortfolio.tutors,
    overall: apprenticeshipRollup(counted.map((c) => ({ actualPct: c.actualPct, status: c.status }))),
    cards,
    breakdown,
    otj,
    nextReview: s.nextReview ?? null,
    stage: s.stage,
    onboarding: { approved: onboarding.approved, required: onboarding.required },
    canAddPair
  };
}
