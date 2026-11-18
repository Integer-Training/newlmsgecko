import { AppError, ErrorCodes } from '@api/utils/errors';
import {
  assertEnrolmentWritable,
  assertStaff,
  canAccessLearner,
  getEnrolmentForActor,
  getProgrammeForActor,
  requireAuthed
} from '@api/services/apprenticeship/access';
import { buildGatewayView, buildGlhView, resolveChecklist } from '@api/services/apprenticeship/gateway-core';
import { nameGatewayActors } from '@api/services/apprenticeship/gateway-names';
import { notifyGatewayReadyOrRelease } from '@api/services/apprenticeship/notifications';
import { ensureOnboardingTypes } from '@api/services/apprenticeship/onboarding';
import { lockEnrolmentsInOrder } from '@api/services/apprenticeship/pair-lock';
import { countedHalves } from '@api/services/apprenticeship/withdrawn';
import { recomputeEnrolment, todayIso, type EnrolmentProgressDetail } from '@api/services/apprenticeship/progress';
import { createOrgUser } from '@api/services/organization/users';
import { createTutorAllocation } from '@api/services/organization/allocation';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import { runInTransaction, type TxClient } from '@cio/db/drizzle';
import { getOrgMemberRoleId } from '@cio/db/queries/allocation';
import {
  countCrossMappedEvidence,
  countEvidenceByCriterion,
  countRegularCourses,
  getApprEnrolment,
  getApprEnrolmentByProgrammeLearner,
  getApprProgrammeStructure,
  getLinkedEnrolment,
  getOrgLearnerByEmail,
  linkApprEnrolments,
  listLearnerEnrolments,
  lockLearnerEnrolments,
  unlinkApprEnrolment,
  type ApprLearnerEnrolmentRef,
  type ApprEnrolmentRow,
  getApprSettings,
  getEnrolmentOverview,
  getEvidenceTotals,
  sumValidatedOtjLogMinutes,
  insertApprEnrolment,
  insertApprReview,
  sumGlhLogMinutes,
  getApprProgramme,
  listPlannedPlanTasksForEnrolment,
  listReviewsForEnrolment,
  updateApprReviewIfUnchanged,
  updateApprTask,
  insertEnrolmentUnits,
  listAcceptedEvidenceTitles,
  listCriterionAcceptedDates,
  listApprPickerPeople,
  listEnrolmentRows,
  listEnrolmentUnitRows,
  listLinkedUnitCounts,
  moveOtjLogs,
  updateApprEnrolment,
  clearApprEnrolmentWithdrawn,
  setApprEnrolmentWithdrawn,
  upsertEnrolmentUnitDates
} from '@cio/db/queries/apprenticeship';
import {
  APPR_PROGRESS_STATUS_LABELS,
  type ApprEnrolmentRole,
  type ApprProgrammeType,
  type ApprProgressStatus,
  type ApprSettings
} from '@cio/utils/constants/apprenticeship';
import { enrolmentSetError } from '@cio/utils/functions/apprenticeship-pairing';
import { ROLE } from '@cio/utils/constants';
import { getPostgresError, isUniqueConstraintViolation } from '@cio/utils/errors';
import {
  apprenticeshipRollup,
  averagePct,
  computeEnrolmentProgress,
  criterionAchievedAt,
  criterionMet,
  expectedPct,
  firstReviewDate,
  glhExpectedMinutes,
  isReviewOverdue,
  otjExpectedMinutes,
  otjTargetMinutes,
  progressStatus,
  sortUnitsBySchedule,
  spreadUnitDates,
  taskDueDate,
  toDayNumber,
  unitAchievedAt,
  type ApprUnitInput
} from '@cio/utils/functions/apprenticeship-progress';
import type {
  ApprenticeshipCreateInput,
  EnrolmentCreateInput,
  EnrolmentLinkInput,
  EnrolmentListQuery,
  EnrolmentReinstateInput,
  EnrolmentUpdateInput,
  EnrolmentWithdrawInput,
  UnitDatesSpreadInput,
  UnitDatesUpdateInput
} from '@cio/utils/validation/apprenticeship';

// Gecko Apprenticeships — enrolments (the learners table, the portfolio, dates, export). Every read/write is scoped
// through access.ts (ADMIN org-wide, TUTOR allocated only, LEARNER self; anything else 404). Expected % and status are
// computed on read from the shared rules module; only action-driven values are cached by recomputeEnrolment.

const notFound = () => new AppError('Learner portfolio not found', ErrorCodes.NOT_FOUND, 404);
const badRequest = (message: string, field?: string) => new AppError(message, ErrorCodes.VALIDATION_ERROR, 400, field);

/** Status order for the learners table: the ones needing attention first. */
export const STATUS_RANK: Record<ApprProgressStatus, number> = {
  CONCERN: 0,
  BEHIND: 1,
  NOT_SET: 2,
  ON_TARGET: 3,
  COMPLETE: 4
};

export interface ProgressSummary {
  actualPct: number | null;
  expectedPct: number | null;
  status: ApprProgressStatus;
  otj: {
    targetMinutes: number | null;
    expectedMinutes: number | null;
    minutes: number;
    status: ApprProgressStatus;
  };
  counts: { submitted: number; accepted: number; referred: number };
}

/** The headline numbers of a learner, from a fresh progress detail (also returned by every evidence mutation). */
export function toProgressSummary(detail: EnrolmentProgressDetail): ProgressSummary {
  return {
    actualPct: detail.actualPct,
    expectedPct: detail.expectedPct,
    status: detail.status,
    otj: {
      targetMinutes: detail.otjTargetMinutes,
      expectedMinutes: detail.otjExpectedMinutes,
      minutes: detail.otjMinutes,
      status: detail.otjStatus
    },
    counts: {
      submitted: detail.totals.submitted,
      accepted: detail.totals.accepted,
      referred: detail.totals.referred
    }
  };
}

interface RowProgressInput {
  startDate: string | null;
  plannedEndDate: string | null;
  contractedHoursWeek: number | null;
  otjTargetMinutesOverride: number | null;
  actualPct: number | null;
  otjMinutes: number;
}

/**
 * The learners-table maths for one row, from the cache columns + dates only (no per-unit data needed). Mirrors the
 * enrolment-level half of computeEnrolmentProgress so the table, the portfolio and the CSV agree.
 */
export function computeRowProgress(row: RowProgressInput, settings: ApprSettings, today: string) {
  const expected = expectedPct(row.startDate, row.plannedEndDate, today);
  const status = progressStatus(row.actualPct, expected, settings);
  const target = otjTargetMinutes({
    start: row.startDate,
    end: row.plannedEndDate,
    contractedHoursWeek: row.contractedHoursWeek,
    overrideMinutes: row.otjTargetMinutesOverride,
    settings
  });
  const otjExpected = otjExpectedMinutes(target, row.startDate, row.plannedEndDate, today);
  const otjActualPct = target ? Math.floor((Math.max(0, row.otjMinutes) / target) * 100) : null;
  const otjExpectedPct = target && otjExpected !== null ? Math.round((otjExpected / target) * 100) : null;
  return {
    expectedPct: expected,
    status,
    otjTargetMinutes: target,
    otjExpectedMinutes: otjExpected,
    otjStatus: progressStatus(otjActualPct, otjExpectedPct, settings)
  };
}

/** A linked component's headline progress (dates + cached actual %), as the list shows it. */
export function computeLinkedProgress(
  component: { startDate: string | null; plannedEndDate: string | null; actualPct: number | null },
  settings: ApprSettings,
  today: string
) {
  return computeRowProgress(
    {
      startDate: component.startDate,
      plannedEndDate: component.plannedEndDate,
      contractedHoursWeek: null,
      otjTargetMinutesOverride: null,
      actualPct: component.actualPct,
      otjMinutes: 0
    },
    settings,
    today
  );
}

/**
 * The status chip a learners-table row shows: the carrier's own status, or for a linked pair the worst of both halves
 * (`overall.status`). The list's status filter + counts and the Summary tiles all use this one rule.
 */
export function overallRowStatus(
  row: RowProgressInput & {
    withdrawnAt?: string | null;
    linked?: {
      startDate: string | null;
      plannedEndDate: string | null;
      actualPct: number | null;
      withdrawnAt?: string | null;
    } | null;
  },
  ownStatus: ApprProgressStatus,
  settings: ApprSettings,
  today: string
): ApprProgressStatus {
  if (!row.linked) return ownStatus;
  // A withdrawn half is out of the roll-up (unless both are withdrawn: then the frozen numbers still show).
  const halves = countedHalves(!!row.withdrawnAt, !!row.linked.withdrawnAt);
  const parts: { actualPct: number | null; status: ApprProgressStatus }[] = [];
  if (halves.own) parts.push({ actualPct: row.actualPct, status: ownStatus });
  if (halves.linked) {
    parts.push({ actualPct: row.linked.actualPct, status: computeLinkedProgress(row.linked, settings, today).status });
  }

  return apprenticeshipRollup(parts).status;
}

/**
 * Units (total / complete) the gateway counts for a learners-table row: the carrier's own plus its component's, minus
 * any WITHDRAWN half (see countedHalves). `linkedUnits` is that carrier's entry from listLinkedUnitCounts.
 */
export function gatewayUnitCounts(
  row: {
    unitsTotal?: number | null;
    unitsComplete?: number | null;
    withdrawnAt?: string | null;
    linked?: { withdrawnAt?: string | null } | null;
  },
  linkedUnits: { total: number; complete: number } | undefined
) {
  const halves = countedHalves(!!row.withdrawnAt, row.linked ? !!row.linked.withdrawnAt : null);

  return {
    unitsTotal: (halves.own ? (row.unitsTotal ?? 0) : 0) + (halves.linked ? (linkedUnits?.total ?? 0) : 0),
    unitsComplete: (halves.own ? (row.unitsComplete ?? 0) : 0) + (halves.linked ? (linkedUnits?.complete ?? 0) : 0)
  };
}

/** Overdue = the earliest open review's date has passed (computed on read, never stored). */
function reviewOverdueOf(nextReview: { scheduledDate: string; status: string } | null | undefined, today: string) {
  return nextReview ? isReviewOverdue(nextReview, today) : false;
}

// ── Learners table ──

export async function listEnrolments(actor: Actor, query: EnrolmentListQuery, now: Date = new Date()) {
  const a = requireAuthed(actor);
  const scope: Parameters<typeof listEnrolmentRows>[0] = {
    organizationId: a.orgId,
    programmeId: query.programmeId,
    type: query.type === 'BOTH' ? undefined : query.type,
    tutorId: query.tutorId,
    search: query.search || undefined,
    noTutor: query.noTutor,
    onboardingIncomplete: query.onboarding === 'incomplete',
    // The apprentice always sees their own apprenticeship, withdrawn or not (read-only).
    state: a.role === 'LEARNER' ? 'all' : query.state,
    today: todayIso(now)
  };
  if (a.role === 'TUTOR') scope.restrictToTutorId = a.userId;
  else if (a.role === 'LEARNER') scope.restrictToLearnerId = a.userId;
  else if (a.role !== 'ADMIN') throw new AppError('You do not have access to this action', ErrorCodes.FORBIDDEN, 403);
  // The Onboarding column counts the org's document types, so give a new org its defaults before the first list.
  if (a.role !== 'LEARNER') await ensureOnboardingTypes(a.orgId);

  const [allRows, settings] = await Promise.all([listEnrolmentRows(scope), getApprSettings(a.orgId)]);
  // BOTH = linked pairs only (a pair is one carrier row), applied before counts + pagination.
  const rows = query.type === 'BOTH' ? allRows.filter((r) => !!r.linked) : allRows;
  const today = todayIso(now);
  // A linked pair is one row (the carrier) and its gateway counts units across BOTH qualifications.
  const linkedUnits = await listLinkedUnitCounts(rows.filter((r) => r.linked).map((r) => r.id));

  const computed = rows.map((r) => {
    const p = computeRowProgress(r, settings, today);
    const units = gatewayUnitCounts(r, linkedUnits.get(r.id));
    const gateway = buildGatewayView({
      checklist: resolveChecklist(r.gatewayChecklist),
      manual: r.gatewayItems,
      unitsTotal: units.unitsTotal,
      unitsComplete: units.unitsComplete,
      otjMinutes: r.otjMinutes,
      otjTargetMinutes: p.otjTargetMinutes,
      enrolment: {
        gatewayPassedAt: r.gatewayPassedAt ?? null,
        epaBookedDate: r.epaBookedDate ?? null,
        epaResult: r.epaResult ?? null,
        epaResultDate: r.epaResultDate ?? null,
        achievedAt: r.achievedAt
      }
    });
    // A linked pair is ONE row (the carrier): the component's headline numbers ride along as `linked`, and `overall`
    // rolls the two up (average actual %, worst status). A standalone row's overall is its own.
    const component = r.linked ?? null;
    const linkedProgress = component ? computeLinkedProgress(component, settings, today) : null;
    const linked =
      component && linkedProgress
        ? {
            id: component.id,
            programmeId: component.programmeId,
            programmeTitle: component.programmeTitle,
            type: component.programmeType,
            actualPct: component.actualPct,
            expectedPct: linkedProgress.expectedPct,
            status: linkedProgress.status,
            withdrawnAt: component.withdrawnAt ?? null
          }
        : null;
    // A withdrawn half is out of the roll-up (both withdrawn: the frozen numbers still show).
    const halves = countedHalves(!!r.withdrawnAt, linked ? !!linked.withdrawnAt : null);
    const ownPart = { actualPct: r.actualPct, status: p.status };
    const overall = linked
      ? apprenticeshipRollup([
          ...(halves.own ? [ownPart] : []),
          ...(halves.linked ? [{ actualPct: linked.actualPct, status: linked.status }] : [])
        ])
      : ownPart;
    return {
      id: r.id,
      programmeId: r.programmeId,
      programmeTitle: r.programmeTitle,
      programmeType: (r.programmeType === 'STANDARD' ? 'STANDARD' : 'DIPLOMA') as ApprProgrammeType,
      linked,
      overall,
      learner: { id: r.learnerId, name: r.learnerName, email: r.learnerEmail },
      tutors: r.tutors ?? [],
      onboarding: r.onboarding ?? null,
      startDate: r.startDate,
      plannedEndDate: r.plannedEndDate,
      achievedAt: r.achievedAt,
      withdrawnAt: r.withdrawnAt ?? null,
      withdrawalReason: r.withdrawalReason ?? null,
      actualPct: r.actualPct,
      expectedPct: p.expectedPct,
      status: p.status,
      statusLabel: APPR_PROGRESS_STATUS_LABELS[p.status],
      otj: {
        minutes: r.otjMinutes,
        targetMinutes: p.otjTargetMinutes,
        expectedMinutes: p.otjExpectedMinutes,
        status: p.otjStatus
      },
      toMark: r.submittedCount,
      acceptedCount: r.acceptedCount,
      referredCount: r.referredCount,
      // GLH done is the cached total (units + staff logs); the target is the programme's unit GLH; expected on read.
      glh: {
        targetMinutes: r.glhTargetMinutes ?? null,
        doneMinutes: r.glhMinutes ?? 0,
        expectedMinutes: glhExpectedMinutes(r.glhTargetMinutes ?? null, p.expectedPct)
      },
      stage: gateway.stage,
      stageLabel: gateway.stageLabel,
      gatewayReady: gateway.ready,
      overdueTaskCount: r.overdueTaskCount ?? 0,
      nextReview: r.nextReview ?? null,
      reviewOverdue: reviewOverdueOf(r.nextReview, today)
    };
  });

  // Status counts BEFORE the status filter, so the filter chips can show how many each status holds.
  const statusCounts: Record<ApprProgressStatus, number> = {
    ON_TARGET: 0,
    BEHIND: 0,
    CONCERN: 0,
    NOT_SET: 0,
    COMPLETE: 0
  };
  // The chip a row shows is its rolled-up `overall.status` (a linked pair's worst half; an unlinked row's own), so the
  // counts and the filter use that, matching the Summary tiles.
  for (const c of computed) statusCounts[c.overall.status] += 1;

  const filtered = query.status ? computed.filter((c) => c.overall.status === query.status) : computed;
  filtered.sort(
    (x, y) =>
      STATUS_RANK[x.overall.status] - STATUS_RANK[y.overall.status] || x.learner.name.localeCompare(y.learner.name)
  );
  const start = (query.page - 1) * query.pageSize;
  return {
    items: filtered.slice(start, start + query.pageSize),
    total: filtered.length,
    page: query.page,
    pageSize: query.pageSize,
    statusCounts
  };
}

// ── Create ──

/** Add-learner pickers (admin only): tutors + learners with their full names and emails. */
export async function getEnrolmentPickerOptions(actor: Actor) {
  const a = assertStaff(actor);
  if (a.role !== 'ADMIN') throw new AppError('Only an admin can enrol a learner', ErrorCodes.FORBIDDEN, 403);
  return listApprPickerPeople(a.orgId);
}

const TYPE_NOUN: Record<string, string> = { DIPLOMA: 'diploma', STANDARD: 'standard' };

interface PlanProgramme {
  id: string;
  title: string;
  type: string;
  pairedProgrammeId: string | null;
}

/**
 * The one-apprenticeship rule (plan §8.3), pure. A learner may hold at most ONE open (not achieved) diploma and ONE
 * open standard, and when they hold both the diploma must be paired to that standard. Only NEW violations are blocked:
 * legacy learners on two unrelated programmes are left as they are (the rule only looks at pairs involving a new one).
 *
 * Returns the error message, or the id of the open enrolment the single new programme should be linked to as its
 * COMPONENT (the existing enrolment stays the carrier), or neither when the learner holds nothing of the other type.
 */
export function planEnrolmentPairing(
  incoming: PlanProgramme[],
  open: ApprLearnerEnrolmentRef[]
): { error: string } | { linkToEnrolmentId: string | null } {
  for (const p of incoming) {
    const clash = open.find((o) => o.type === p.type);
    if (clash) {
      return {
        error: `This learner already has an open ${TYPE_NOUN[p.type] ?? 'programme'} enrolment (${clash.programmeTitle}). Finish it first.`
      };
    }
  }

  for (const p of incoming) {
    for (const o of open) {
      if (o.type === p.type) continue;
      const paired = p.type === 'DIPLOMA' ? p.pairedProgrammeId === o.programmeId : o.pairedProgrammeId === p.id;
      if (paired) continue;
      if (p.type === 'STANDARD') {
        const target = o.pairedProgrammeTitle ? `, ${o.pairedProgrammeTitle}` : '';

        return { error: `A learner on ${o.programmeTitle} can only be on its paired standard${target}` };
      }

      return { error: `${p.title} is not paired with ${o.programmeTitle}, so this learner cannot be on both` };
    }
  }

  // Auto-link a lone new programme to the open enrolment of the other type, if that one is not already in a pair.
  if (incoming.length === 1) {
    const free = open.find((o) => o.type !== incoming[0].type && !o.primaryEnrolmentId && !o.componentId);

    return { linkToEnrolmentId: free?.id ?? null };
  }

  return { linkToEnrolmentId: null };
}

const alreadyEnrolled = () =>
  new AppError('This learner is already enrolled on this programme', ErrorCodes.CONFLICT, 409, 'learner');

const alreadyHasLinkedQualification = (field = 'enrolments') =>
  new AppError('This apprenticeship already has a linked qualification', ErrorCodes.CONFLICT, 409, field);

/** The partial unique index that allows one component per carrier (migration 0036). */
const PRIMARY_LINK_INDEX = 'appr_enrolment_primary_unique';
const isDuplicateLink = (error: unknown) =>
  isUniqueConstraintViolation(error) && getPostgresError(error)?.constraint === PRIMARY_LINK_INDEX;

/**
 * Enrol an apprentice on one programme or a Diploma + Standard pair. Shared by POST /enrolments/apprenticeship and the
 * legacy POST /enrolments (one programme). Admin only. Everything is validated BEFORE an account is created.
 *   - both created together: the DIPLOMA is the carrier, the Standard its component;
 *   - one programme for a learner who already holds the other type: it becomes the COMPONENT of that enrolment;
 *   - learner-level data (first review, contracted hours, OTJ override) is written on the carrier only.
 */
async function enrolApprentice(
  actor: Actor,
  input: ApprenticeshipCreateInput,
  opts: { legacy: boolean }
): Promise<{
  learnerId: string;
  enrolments: { id: string; programmeId: string; role: ApprEnrolmentRole }[];
  temporaryPassword?: string;
}> {
  const a = requireAuthed(actor);
  if (a.role !== 'ADMIN') throw new AppError('Only an admin can enrol a learner', ErrorCodes.FORBIDDEN, 403);
  const programmeField = opts.legacy ? 'programmeId' : 'enrolments';

  const programmes: Awaited<ReturnType<typeof getProgrammeForActor>>[] = [];
  for (const item of input.enrolments) {
    const programme = await getProgrammeForActor(a, item.programmeId);
    if (programme.status !== 'ACTIVE') throw badRequest('This programme is archived', programmeField);
    programmes.push(programme);
  }
  const setProblem = enrolmentSetError(
    programmes.map((p) => ({ id: p.id, type: p.type, level: p.level, pairedProgrammeId: p.pairedProgrammeId }))
  );
  if (setProblem) throw badRequest(setProblem, 'enrolments');

  // Validate everything BEFORE a new account is created, so a bad tutor never leaves an orphan user behind.
  if ((await getOrgMemberRoleId(a.orgId, input.tutorId)) !== ROLE.TUTOR) {
    throw badRequest('The selected tutor is not a tutor in this organization', 'tutorId');
  }

  let learnerId: string;
  let temporaryPassword: string | undefined;
  if ('learnerId' in input.learner) {
    learnerId = input.learner.learnerId;
    if ((await getOrgMemberRoleId(a.orgId, learnerId)) !== ROLE.STUDENT) {
      throw badRequest('The selected learner is not a learner in this organization', 'learner');
    }
    // Fail fast before any side effect (tutor allocation). NOT authoritative: the same checks re-run under the
    // per-learner lock inside the transaction below, which is what actually closes the race.
    for (const programme of programmes) {
      if (await getApprEnrolmentByProgrammeLearner(programme.id, learnerId)) throw alreadyEnrolled();
    }
    const open = (await listLearnerEnrolments(a.orgId, learnerId)).filter((e) => !e.achievedAt && !e.withdrawnAt);
    const plan = planEnrolmentPairing(programmes, open);
    if ('error' in plan) throw badRequest(plan.error, programmeField);
  } else {
    const created = await createOrgUser(a.orgId, a, {
      name: `${input.learner.firstName} ${input.learner.lastName}`,
      email: input.learner.email,
      roleId: ROLE.STUDENT
    });
    learnerId = created.userId;
    temporaryPassword = created.temporaryPassword; // revealed once, like learner management
  }

  try {
    await createTutorAllocation(a.orgId, a, { tutorId: input.tutorId, learnerId });
  } catch (error) {
    // Already allocated to this tutor is exactly the state we want.
    if (!(error instanceof AppError && error.statusCode === 409)) throw error;
  }

  // Carrier first. Together, the diploma carries; otherwise the single programme is standalone, or a component of the
  // learner's open enrolment of the other type (decided under the lock inside the transaction).
  const dates = new Map(input.enrolments.map((item) => [item.programmeId, item]));
  const ordered = [...programmes].sort((x, y) => (x.type === 'DIPLOMA' ? -1 : 0) - (y.type === 'DIPLOMA' ? -1 : 0));
  const structures = await Promise.all(ordered.map((p) => getApprProgrammeStructure(p.id)));

  let created: { id: string; programmeId: string; role: ApprEnrolmentRole }[];
  try {
    created = await runInTransaction(async (tx) => {
      // Take the per-learner lock FIRST, then (re-)run the already-enrolled + one-apprenticeship checks against what is
      // committed now: a concurrent enrol for the same learner waits here and then sees the other one's rows. Runs for a
      // brand-new learner too (nothing to find, but one uniform path).
      await lockLearnerEnrolments(tx, learnerId);
      for (const programme of programmes) {
        if (await getApprEnrolmentByProgrammeLearner(programme.id, learnerId, tx)) throw alreadyEnrolled();
      }
      const open = (await listLearnerEnrolments(a.orgId, learnerId, tx)).filter((e) => !e.achievedAt && !e.withdrawnAt);
      const plan = planEnrolmentPairing(programmes, open);
      if ('error' in plan) throw badRequest(plan.error, programmeField);

      const out: { id: string; programmeId: string; role: ApprEnrolmentRole }[] = [];
      let carrierId: string | null = plan.linkToEnrolmentId;
      for (const [index, programme] of ordered.entries()) {
        const item = dates.get(programme.id)!;
        const isComponent = carrierId !== null;
        const row = await insertApprEnrolment(tx, {
          organizationId: a.orgId,
          programmeId: programme.id,
          learnerId,
          startDate: item.startDate,
          plannedEndDate: item.plannedEndDate,
          // Learner-level targets live on the carrier only.
          contractedHoursWeek: isComponent ? null : (input.contractedHoursWeek ?? null),
          otjTargetMinutesOverride: isComponent ? null : (input.otjTargetMinutesOverride ?? null),
          primaryEnrolmentId: carrierId,
          createdBy: a.userId
        });
        await insertEnrolmentUnits(
          tx,
          row.id,
          structures[index].units.map((u) => u.id)
        );
        if (!isComponent) {
          // The first progress review: learner start + the programme's review interval (staff can reschedule it).
          const firstReview = firstReviewDate(item.startDate, programme.reviewIntervalWeeks, todayIso());
          if (firstReview) {
            await insertApprReview(tx, {
              organizationId: a.orgId,
              enrolmentId: row.id,
              scheduledDate: firstReview,
              createdBy: a.userId
            });
          }
          carrierId = ordered.length > 1 ? row.id : null;
        }
        await recomputeEnrolment(tx, row.id);
        const role: ApprEnrolmentRole = isComponent ? 'COMPONENT' : ordered.length > 1 ? 'CARRIER' : 'STANDALONE';
        out.push({ id: row.id, programmeId: programme.id, role });
      }
      return out;
    });
  } catch (error) {
    // NOTE: when this call created the account (a new learner) it is left behind if the enrolment fails here. There is no
    // safe delete helper for an org user / auth account to roll it back with, so none is invented: the admin can retry
    // with "existing learner" (the account now exists) or remove the user from the Users screen.
    if (isDuplicateLink(error)) throw alreadyHasLinkedQualification();
    if (isUniqueConstraintViolation(error)) throw alreadyEnrolled();
    throw error;
  }

  const body = { learnerId, enrolments: created, ...(temporaryPassword ? { temporaryPassword } : {}) };
  if (opts.legacy) {
    await recordAudit({
      actor,
      action: 'appr.enrolment.created',
      entityType: 'appr_enrolment',
      entityId: created[0].id,
      metadata: {
        programmeId: created[0].programmeId,
        learnerId,
        tutorId: input.tutorId,
        newLearner: temporaryPassword !== undefined,
        linked: created[0].role === 'COMPONENT'
      }
    });
  } else {
    await recordAudit({
      actor,
      action: 'appr.apprenticeship.created',
      entityType: 'appr_enrolment',
      entityId: created[0].id,
      metadata: {
        learnerId,
        tutorId: input.tutorId,
        newLearner: temporaryPassword !== undefined,
        enrolments: created.map((e) => ({ id: e.id, programmeId: e.programmeId, role: e.role }))
      }
    });
  }
  return body;
}

/** POST /enrolments/apprenticeship — enrol on one programme or a Diploma + Standard pair in one transaction. */
export async function createApprenticeship(actor: Actor, input: ApprenticeshipCreateInput) {
  return enrolApprentice(actor, input, { legacy: false });
}

/** POST /enrolments (legacy body): one programme; applies the pairing rule and auto-links as a component if it fits. */
export async function createEnrolment(actor: Actor, input: EnrolmentCreateInput) {
  const result = await enrolApprentice(
    actor,
    {
      learner: input.learner,
      tutorId: input.tutorId,
      contractedHoursWeek: input.contractedHoursWeek,
      otjTargetMinutesOverride: input.otjTargetMinutesOverride,
      enrolments: [{ programmeId: input.programmeId, startDate: input.startDate, plannedEndDate: input.plannedEndDate }]
    },
    { legacy: true }
  );
  const [created] = result.enrolments;

  return {
    id: created.id,
    learnerId: result.learnerId,
    programmeId: created.programmeId,
    ...(result.temporaryPassword ? { temporaryPassword: result.temporaryPassword } : {})
  };
}

// ── Linked enrolments (a Diploma + Standard pair) ──

/**
 * Resolve either half of an apprenticeship to `{ carrier, component }` (component is null when standalone). Callers do
 * their own access check first (getEnrolmentForActor); this only follows the link. Throws 404 for an unknown id.
 */
export async function resolveApprenticeship(
  enrolmentId: string
): Promise<{ carrier: ApprEnrolmentRow; component: ApprEnrolmentRow | null }> {
  const enrolment = await getApprEnrolment(enrolmentId);
  if (!enrolment) throw notFound();

  if (enrolment.primaryEnrolmentId) {
    const carrier = await getApprEnrolment(enrolment.primaryEnrolmentId);

    return carrier ? { carrier, component: enrolment } : { carrier: enrolment, component: null };
  }

  return { carrier: enrolment, component: await getLinkedEnrolment(enrolment.id) };
}

/** POST /enrolments/:id/link — link two standalone enrolments of one learner into a pair (the earlier one carries). */
export async function linkEnrolment(actor: Actor, enrolmentId: string, input: EnrolmentLinkInput) {
  const a = requireAuthed(actor);
  if (a.role !== 'ADMIN') throw new AppError('Only an admin can link enrolments', ErrorCodes.FORBIDDEN, 403);
  const first = await getEnrolmentForActor(a, enrolmentId);
  const second = await getApprEnrolment(input.enrolmentId);
  if (!second || second.organizationId !== a.orgId) throw notFound();
  if (first.id === second.id) throw badRequest('Pick two different enrolments', 'enrolmentId');
  await assertEnrolmentWritable(first);
  await assertEnrolmentWritable(second);
  if (first.learnerId !== second.learnerId)
    throw badRequest('Both enrolments must belong to the same learner', 'enrolmentId');

  let carrier: ApprLearnerEnrolmentRef;
  let component: ApprLearnerEnrolmentRef;
  let claimed: string[] = [];
  try {
    [carrier, component] = await runInTransaction(async (tx) => {
      // Per-learner lock first, then read + check the learner's enrolments (so a concurrent enrol/link cannot slip in
      // between the check and the write).
      await lockLearnerEnrolments(tx, first.learnerId);
      const learnerEnrolments = await listLearnerEnrolments(a.orgId, first.learnerId, tx);
      const byId = new Map(learnerEnrolments.map((e) => [e.id, e]));
      const firstRef = byId.get(first.id);
      const secondRef = byId.get(second.id);
      if (!firstRef || !secondRef) throw notFound();
      if (
        firstRef.primaryEnrolmentId ||
        firstRef.componentId ||
        secondRef.primaryEnrolmentId ||
        secondRef.componentId
      ) {
        throw new AppError('One of these enrolments is already linked', ErrorCodes.CONFLICT, 409, 'enrolmentId');
      }
      const problem = enrolmentSetError(
        [firstRef, secondRef].map((e) => ({
          id: e.programmeId,
          type: e.type,
          level: e.level,
          pairedProgrammeId: e.pairedProgrammeId
        }))
      );
      if (problem) throw badRequest(problem, 'enrolmentId');

      // The earlier enrolment keeps its reviews, hours and onboarding, so it carries; the later one is the component.
      const pair: [ApprLearnerEnrolmentRef, ApprLearnerEnrolmentRef] =
        `${firstRef.createdAt}${firstRef.id}` <= `${secondRef.createdAt}${secondRef.id}`
          ? [firstRef, secondRef]
          : [secondRef, firstRef];
      // Pair lock (id order, shared with every OTJ / evidence write) before the link is written.
      await lockEnrolmentsInOrder(tx, [pair[0].id, pair[1].id]);
      if (!(await linkApprEnrolments(tx, pair[0].id, pair[1].id))) {
        throw new AppError('One of these enrolments is already linked', ErrorCodes.CONFLICT, 409, 'enrolmentId');
      }
      // Off-the-job logs are stored on the CARRIER only: any the component already held move across, then both halves'
      // caches are re-derived in this transaction (the pair now shares evidence counts, OTJ minutes and gateway units).
      await moveOtjLogs(tx, pair[1].id, pair[0].id);
      const detail = await recomputeEnrolment(tx, pair[0].id, { claimGatewayReady: true });
      claimed = detail?.gatewayReadyClaimed ? [pair[0].id] : [];
      return pair;
    });
  } catch (error) {
    if (isDuplicateLink(error)) throw alreadyHasLinkedQualification('enrolmentId');
    throw error;
  }

  if (claimed.length > 0) {
    await notifyGatewayReadyOrRelease({
      enrolmentId: carrier.id,
      learnerId: first.learnerId,
      organizationId: first.organizationId
    });
  }
  await recordAudit({
    actor,
    action: 'appr.enrolment.linked',
    entityType: 'appr_enrolment',
    entityId: carrier.id,
    metadata: { carrierId: carrier.id, componentId: component.id, learnerId: first.learnerId }
  });
  return { carrierId: carrier.id, componentId: component.id };
}

/** DELETE /enrolments/:id/link — split a pair (`:id` is either half). Blocked while evidence maps across the pair. */
export async function unlinkEnrolment(actor: Actor, enrolmentId: string) {
  const a = requireAuthed(actor);
  if (a.role !== 'ADMIN') throw new AppError('Only an admin can unlink enrolments', ErrorCodes.FORBIDDEN, 403);
  await getEnrolmentForActor(a, enrolmentId);
  const { carrier, component } = await resolveApprenticeship(enrolmentId);
  if (!component) throw badRequest('This enrolment is not linked to another');
  await assertEnrolmentWritable(carrier);

  // Under the pair lock (so no evidence write can add a cross-mapping between the check and the split), re-check, split,
  // and re-derive both caches: the halves stop sharing evidence counts, OTJ minutes and gateway units.
  // Off-the-job LOGS stay on the carrier: they are learner-level records and have no programme to follow, so the
  // component starts with none (only its own OTJ evidence counts toward its minutes).
  const claimed = await runInTransaction(async (tx) => {
    await lockEnrolmentsInOrder(tx, [carrier.id, component.id]);
    const crossMapped = await countCrossMappedEvidence(
      carrier.learnerId,
      [carrier.programmeId, component.programmeId],
      tx
    );
    if (crossMapped > 0) {
      throw new AppError(
        `${crossMapped} piece${crossMapped === 1 ? '' : 's'} of evidence ${crossMapped === 1 ? 'is' : 'are'} mapped to both qualifications — remove those mappings first`,
        ErrorCodes.CONFLICT,
        409
      );
    }
    await unlinkApprEnrolment(tx, component.id);
    const claims: string[] = [];
    for (const id of [carrier.id, component.id]) {
      const detail = await recomputeEnrolment(tx, id, { claimGatewayReady: true });
      if (detail?.gatewayReadyClaimed) claims.push(id);
    }
    return claims;
  });
  for (const id of claimed) {
    await notifyGatewayReadyOrRelease({
      enrolmentId: id,
      learnerId: carrier.learnerId,
      organizationId: carrier.organizationId
    });
  }

  await recordAudit({
    actor,
    action: 'appr.enrolment.unlinked',
    entityType: 'appr_enrolment',
    entityId: carrier.id,
    metadata: { carrierId: carrier.id, componentId: component.id, learnerId: carrier.learnerId }
  });
  return { carrierId: carrier.id, componentId: component.id };
}

/** GET /enrolments/learner-check — what the Enrol wizard shows once a learner is picked or an email is typed. */
export async function checkLearner(actor: Actor, query: { learnerId?: string; email?: string }) {
  const a = requireAuthed(actor);
  if (a.role !== 'ADMIN') throw new AppError('Only an admin can enrol a learner', ErrorCodes.FORBIDDEN, 403);

  let learnerId: string | null = null;
  if (query.learnerId) {
    learnerId = (await getOrgMemberRoleId(a.orgId, query.learnerId)) === ROLE.STUDENT ? query.learnerId : null;
  } else if (query.email) {
    learnerId = (await getOrgLearnerByEmail(a.orgId, query.email))?.id ?? null;
  }
  // Another org's (or a non-learner) account is reported as "does not exist" — nothing about it is revealed.
  if (!learnerId) return { exists: false, apprenticeship: [], regularCourses: 0 };

  const [enrolments, regularCourses] = await Promise.all([
    listLearnerEnrolments(a.orgId, learnerId),
    countRegularCourses(a.orgId, learnerId)
  ]);
  return {
    exists: true,
    learnerId,
    apprenticeship: enrolments.map((e) => ({
      enrolmentId: e.id,
      programmeId: e.programmeId,
      programmeTitle: e.programmeTitle,
      type: e.type,
      level: e.level,
      state: e.achievedAt ? 'achieved' : e.withdrawnAt ? 'withdrawn' : 'active'
    })),
    regularCourses
  };
}

// ── Portfolio ──

/** Everything the portfolio page needs, loaded in one parallel round after the overview/access check. */
interface Counterpart {
  enrolmentId: string;
  programmeId: string;
  title: string;
  type: string;
  withdrawnAt?: string | null;
}

function toPortfolioLinked(
  enrolment: { id: string; primaryEnrolmentId?: string | null },
  counterpart: Counterpart | null
) {
  if (!counterpart) return null;

  return {
    role: (enrolment.primaryEnrolmentId ? 'COMPONENT' : 'CARRIER') as Extract<
      ApprEnrolmentRole,
      'CARRIER' | 'COMPONENT'
    >,
    carrierId: enrolment.primaryEnrolmentId ?? enrolment.id,
    counterpart: {
      enrolmentId: counterpart.enrolmentId,
      programmeId: counterpart.programmeId,
      title: counterpart.title,
      type: (counterpart.type === 'STANDARD' ? 'STANDARD' : 'DIPLOMA') as ApprProgrammeType,
      withdrawnAt: counterpart.withdrawnAt ?? null
    }
  };
}

async function loadPortfolio(actor: Actor, enrolmentId: string, now: Date = new Date()) {
  requireAuthed(actor);
  const overview = await getEnrolmentOverview(enrolmentId, undefined, todayIso(now));
  if (
    !overview ||
    !(await canAccessLearner(
      actor,
      overview.enrolment.organizationId,
      overview.enrolment.learnerId,
      overview.enrolment.programmeId
    ))
  ) {
    throw notFound();
  }
  const { enrolment } = overview;
  // Same learner-level numbers as buildEnrolmentProgress: a CARRIER counts both halves of a pair plus its validated OTJ logs.
  const isComponent = !!enrolment.primaryEnrolmentId;
  const pairComponent = isComponent ? null : await getLinkedEnrolment(enrolment.id);
  // Withdrawn halves are out of the learner-level evidence totals and the gateway unit count (see countedHalves).
  const halves = countedHalves(
    !!enrolment.withdrawnAt,
    overview.counterpart ? !!overview.counterpart.withdrawnAt : null
  );
  const totalsProgrammeIds = [
    halves.own ? enrolment.programmeId : null,
    halves.linked && pairComponent ? pairComponent.programmeId : null
  ].filter((id): id is string => !!id);
  const [structure, counts, evidenceTotals, unitRows, settings, loggedGlh, acceptedDates, loggedOtj] =
    await Promise.all([
      getApprProgrammeStructure(enrolment.programmeId),
      countEvidenceByCriterion(enrolment.programmeId, enrolment.learnerId),
      getEvidenceTotals(
        enrolment.programmeId,
        enrolment.learnerId,
        undefined,
        pairComponent ? { programmeIds: totalsProgrammeIds } : {}
      ),
      listEnrolmentUnitRows(enrolment.id),
      getApprSettings(enrolment.organizationId),
      sumGlhLogMinutes(enrolment.id),
      listCriterionAcceptedDates(enrolment.programmeId, enrolment.learnerId),
      isComponent ? Promise.resolve(0) : sumValidatedOtjLogMinutes(enrolment.id)
    ]);
  const totals = { ...evidenceTotals, otjMinutes: evidenceTotals.otjMinutes + loggedOtj };

  const datesByUnit = new Map(unitRows.map((r) => [r.unitId, r]));
  const criteriaByUnit = new Map<string, typeof structure.criteria>();
  for (const c of structure.criteria) criteriaByUnit.set(c.unitId, [...(criteriaByUnit.get(c.unitId) ?? []), c]);

  // Same unit inputs as buildEnrolmentProgress, so the two can never disagree.
  const unitInputs: ApprUnitInput[] = structure.units.map((u) => ({
    unitId: u.id,
    startDate: datesByUnit.get(u.id)?.startDate ?? null,
    targetDate: datesByUnit.get(u.id)?.targetDate ?? null,
    criteria: (criteriaByUnit.get(u.id) ?? []).map((c) => ({
      acceptedCount: counts.get(c.id)?.accepted ?? 0,
      requiredCount: c.requiredCount
    }))
  }));
  const progress = computeEnrolmentProgress({
    startDate: enrolment.startDate,
    plannedEndDate: enrolment.plannedEndDate,
    contractedHoursWeek: enrolment.contractedHoursWeek,
    otjOverrideMinutes: enrolment.otjTargetMinutesOverride,
    otjMinutes: totals.otjMinutes,
    units: unitInputs,
    today: todayIso(now),
    settings
  });
  const progressByUnit = new Map(progress.units.map((u) => [u.unitId, u]));

  const qualifications = structure.qualifications.map((q) => {
    const unsorted = structure.units
      .filter((u) => u.qualificationId === q.id)
      .map((u) => {
        const p = progressByUnit.get(u.id);
        const status = p?.status ?? ('NOT_SET' as ApprProgressStatus);
        const criteria = (criteriaByUnit.get(u.id) ?? []).map((c) => {
          const n = counts.get(c.id) ?? { accepted: 0, submitted: 0 };
          const met = criterionMet(n.accepted, c.requiredCount);
          return {
            id: c.id,
            code: c.code,
            text: c.text,
            groupLabel: c.groupLabel,
            requiredCount: c.requiredCount,
            acceptedCount: n.accepted,
            met,
            // When the Nth accepted piece was accepted (N = required count); null while not met. Counts and dates are
            // two parallel reads (no shared snapshot): evidence accepted BETWEEN them can make a unit read COMPLETE with a
            // null date for that one response. Accepted: it self-corrects on the next load and the date is display-only.
            achievedAt: met ? criterionAchievedAt(acceptedDates.get(c.id) ?? [], c.requiredCount) : null,
            evidenceCount: n.accepted + n.submitted,
            pendingCount: n.submitted
          };
        });
        return {
          id: u.id,
          code: u.code,
          title: u.title,
          startDate: datesByUnit.get(u.id)?.startDate ?? null,
          targetDate: datesByUnit.get(u.id)?.targetDate ?? null,
          actualPct: p?.actualPct ?? null,
          expectedPct: p?.expectedPct ?? null,
          status,
          // Latest criterion date, only for a COMPLETE unit with at least one criterion.
          achievedAt: status === 'COMPLETE' ? unitAchievedAt(criteria) : null,
          criteria
        };
      });
    // Units in schedule order (dated first by start then target; undated keep programme order).
    const units = sortUnitsBySchedule(unsorted);
    return {
      id: q.id,
      title: q.title,
      reference: q.reference,
      awardingBody: q.awardingBody,
      level: q.level,
      actualPct: averagePct(units.map((u) => u.actualPct)),
      // Set when this qualification is withdrawn: its criteria are hidden from the evidence picker.
      withdrawnAt: enrolment.withdrawnAt ?? null,
      units
    };
  });

  const summary: ProgressSummary = {
    actualPct: progress.actualPct,
    expectedPct: progress.expectedPct,
    status: progress.status,
    otj: {
      targetMinutes: progress.otjTargetMinutes,
      expectedMinutes: progress.otjExpectedMinutes,
      minutes: progress.otjMinutes,
      status: progress.otjStatus
    },
    counts: { submitted: totals.submitted, accepted: totals.accepted, referred: totals.referred }
  };
  const nextReview = overview.nextReview ?? null;
  const glh = buildGlhView(
    structure.units.map((u) => ({ glh: u.glh ?? null, complete: progressByUnit.get(u.id)?.status === 'COMPLETE' })),
    loggedGlh,
    progress.expectedPct
  );
  // The gateway's AUTO_UNITS item counts units across BOTH halves of a linked pair (the counterpart's cached unit rows).
  const counterpartUnits = overview.counterpart ? await listEnrolmentUnitRows(overview.counterpart.enrolmentId) : [];
  const gateway = buildGatewayView({
    checklist: resolveChecklist(overview.gatewayChecklist),
    manual: enrolment.gatewayItems,
    unitsTotal: (halves.own ? structure.units.length : 0) + (halves.linked ? counterpartUnits.length : 0),
    unitsComplete:
      (halves.own ? structure.units.filter((u) => progressByUnit.get(u.id)?.status === 'COMPLETE').length : 0) +
      (halves.linked ? counterpartUnits.filter((u) => u.completedAt).length : 0),
    otjMinutes: progress.otjMinutes,
    otjTargetMinutes: progress.otjTargetMinutes,
    enrolment
  });

  return {
    enrolment: {
      id: enrolment.id,
      programmeId: enrolment.programmeId,
      learnerId: enrolment.learnerId,
      startDate: enrolment.startDate,
      plannedEndDate: enrolment.plannedEndDate,
      contractedHoursWeek: enrolment.contractedHoursWeek,
      otjTargetMinutesOverride: enrolment.otjTargetMinutesOverride,
      achievedAt: enrolment.achievedAt,
      recomputedAt: enrolment.recomputedAt,
      withdrawnAt: enrolment.withdrawnAt ?? null,
      withdrawalReason: enrolment.withdrawalReason ?? null,
      // Every half withdrawn: read-only for everyone (the learner still reads).
      apprenticeshipClosed: halves.closed
    },
    learner: { id: enrolment.learnerId, name: overview.learnerName, email: overview.learnerEmail },
    programme: {
      id: enrolment.programmeId,
      title: overview.programmeTitle,
      reference: overview.programmeReference,
      level: overview.programmeLevel,
      type: (overview.programmeType === 'STANDARD' ? 'STANDARD' : 'DIPLOMA') as ApprProgrammeType
    },
    // Set when this enrolment is half of a linked Diploma + Standard pair (either half's id opens the same pair).
    linked: toPortfolioLinked(enrolment, overview.counterpart ?? null),
    tutors: overview.tutors ?? [],
    summary: {
      ...summary,
      overdueTaskCount: overview.overdueTaskCount ?? 0,
      nextReview,
      reviewOverdue: reviewOverdueOf(nextReview, todayIso(now)),
      glh,
      stage: gateway.stage,
      stageLabel: gateway.stageLabel,
      gatewayReady: gateway.ready
    },
    gateway,
    qualifications
  };
}

export async function getPortfolio(actor: Actor, enrolmentId: string) {
  return loadPortfolio(actor, enrolmentId);
}

// ── Edit ──

/**
 * A moved start date moves what was derived from it: the FIRST review (only while it is still an untouched SCHEDULED
 * one and no review has completed) and the due dates of still-PLANNED plan tasks (their overdue alert is re-armed).
 * Submitted / referred / complete tasks and individual tasks keep their dates.
 */
async function rebaseOnStartDate(tx: TxClient, enrolmentId: string, startDate: string, intervalWeeks: number) {
  const reviews = await listReviewsForEnrolment(enrolmentId, tx);
  const first = [...reviews].sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))[0];
  const untouched =
    first &&
    first.status === 'SCHEDULED' &&
    !first.heldDate &&
    !first.tutorSignedAt &&
    !first.learnerSignedAt &&
    !first.employerSignedAt &&
    !reviews.some((r) => r.status === 'COMPLETE');
  const next = firstReviewDate(startDate, intervalWeeks, todayIso());
  if (untouched && next && next !== first.scheduledDate) {
    await updateApprReviewIfUnchanged(tx, first.id, first.updatedAt, { scheduledDate: next, dueNotifiedAt: null });
  }
  for (const task of await listPlannedPlanTasksForEnrolment(enrolmentId, tx)) {
    const due = taskDueDate(startDate, task.monthOffset);
    if (task.dueManual) continue; // a hand-set / batch-override date is protected
    if (due !== task.dueDate) await updateApprTask(tx, task.id, { dueDate: due, overdueNotifiedAt: null }, 'PLANNED');
  }
}

export async function updateEnrolment(actor: Actor, enrolmentId: string, patch: EnrolmentUpdateInput) {
  const a = assertStaff(actor);
  // Programme dates / contracted hours / OTJ override set the learner's targets — admin only (the route says so too).
  if (a.role !== 'ADMIN')
    throw new AppError('Only an admin can change programme dates and hours', ErrorCodes.FORBIDDEN, 403);
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  await assertEnrolmentWritable(enrolment);
  const start = patch.startDate ?? enrolment.startDate;
  const end = patch.plannedEndDate ?? enrolment.plannedEndDate;
  const s = toDayNumber(start);
  const e = toDayNumber(end);
  if (s !== null && e !== null && e < s) {
    throw badRequest('Planned end date must be on or after the start date', 'plannedEndDate');
  }
  const startChanged = patch.startDate !== undefined && patch.startDate !== enrolment.startDate;
  const programme = startChanged ? await getApprProgramme(enrolment.programmeId) : null;
  const detail = await runInTransaction(async (tx) => {
    await updateApprEnrolment(enrolmentId, patch, tx);
    if (startChanged) await rebaseOnStartDate(tx, enrolmentId, patch.startDate!, programme?.reviewIntervalWeeks ?? 12);
    return recomputeEnrolment(tx, enrolmentId, { claimGatewayReady: true });
  });
  // New hours / OTJ target can make the learner ready: the claim happened in the transaction, tell tutors + admins.
  if (detail?.gatewayReadyClaimed) {
    await notifyGatewayReadyOrRelease({
      enrolmentId,
      learnerId: enrolment.learnerId,
      organizationId: enrolment.organizationId
    });
  }
  await recordAudit({
    actor,
    action: 'appr.enrolment.updated',
    entityType: 'appr_enrolment',
    entityId: enrolmentId,
    metadata: { fields: Object.keys(patch) }
  });
  return loadPortfolio(actor, enrolmentId);
}

export async function setUnitDates(actor: Actor, enrolmentId: string, input: UnitDatesUpdateInput) {
  assertStaff(actor);
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  await assertEnrolmentWritable(enrolment);
  const structure = await getApprProgrammeStructure(enrolment.programmeId);
  const known = new Set(structure.units.map((u) => u.id));
  if (!input.units.every((u) => known.has(u.unitId))) {
    throw new AppError('Unit not found in this programme', ErrorCodes.NOT_FOUND, 404);
  }
  await runInTransaction((tx) => upsertEnrolmentUnitDates(tx, enrolmentId, input.units));
  await recordAudit({
    actor,
    action: 'appr.enrolment.unit_dates',
    entityType: 'appr_enrolment',
    entityId: enrolmentId,
    metadata: { units: input.units.length }
  });
  return loadPortfolio(actor, enrolmentId);
}

/** Spread a window across the units in order, weighted by criteria count (default window = the enrolment dates). */
export async function spreadEnrolmentUnitDates(actor: Actor, enrolmentId: string, input: UnitDatesSpreadInput) {
  assertStaff(actor);
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  await assertEnrolmentWritable(enrolment);
  const start = input.startDate ?? enrolment.startDate;
  const end = input.endDate ?? enrolment.plannedEndDate;
  if (
    !start ||
    !end ||
    toDayNumber(start) === null ||
    toDayNumber(end) === null ||
    toDayNumber(end)! < toDayNumber(start)!
  ) {
    throw badRequest('Set a valid start and end date first', 'startDate');
  }
  const [structure, unitRows] = await Promise.all([
    getApprProgrammeStructure(enrolment.programmeId),
    listEnrolmentUnitRows(enrolmentId)
  ]);
  const existing = new Map(unitRows.map((r) => [r.unitId, r]));
  const weight = new Map<string, number>();
  for (const c of structure.criteria) weight.set(c.unitId, (weight.get(c.unitId) ?? 0) + 1);

  const targets = structure.units.filter((u) => {
    if (!input.onlyEmpty) return true;
    const row = existing.get(u.id);
    return !row?.startDate && !row?.targetDate;
  });
  const ranges = spreadUnitDates(
    start,
    end,
    targets.map((u) => ({ unitId: u.id, weight: weight.get(u.id) ?? 1 }))
  );
  await runInTransaction((tx) => upsertEnrolmentUnitDates(tx, enrolmentId, ranges));
  await recordAudit({
    actor,
    action: 'appr.enrolment.unit_dates_spread',
    entityType: 'appr_enrolment',
    entityId: enrolmentId,
    metadata: { units: ranges.length, onlyEmpty: input.onlyEmpty }
  });
  return loadPortfolio(actor, enrolmentId);
}

// ── CSV export ──

/** Spreadsheet-safe cell: quoted when needed, and a leading = + - @ is neutralised so Excel never runs it as a formula. */
export function csvCell(value: string | number | boolean | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const ukDayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' });
/** YYYY-MM-DD in UK time (en-CA formats as ISO); blank when there is no date. */
function ukDay(iso: string | null | undefined) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : ukDayFormat.format(d);
}

export async function exportPortfolioCsv(actor: Actor, enrolmentId: string, unitId?: string) {
  const portfolio = await loadPortfolio(actor, enrolmentId);
  if (unitId && !portfolio.qualifications.some((q) => q.units.some((u) => u.id === unitId))) {
    throw new AppError('Unit not found in this programme', ErrorCodes.NOT_FOUND, 404);
  }
  const titles = await listAcceptedEvidenceTitles(portfolio.programme.id, portfolio.learner.id);
  const header = [
    'Qualification',
    'Unit code',
    'Unit title',
    'Criterion code',
    'Criterion',
    'Required',
    'Accepted',
    'Met',
    'Evidence',
    'GLH target (h)',
    'GLH done (h)',
    'GLH expected (h)',
    'Criterion met on',
    'Unit achieved on'
  ];
  // Learner-level GLH, repeated on each row; blank when the programme has no unit GLH (null-safe).
  const hours = (minutes: number | null | undefined) =>
    minutes === null || minutes === undefined ? '' : String(Math.round((minutes / 60) * 10) / 10);
  const glh = portfolio.summary.glh;
  const glhCells = [
    hours(glh.targetMinutes),
    glh.targetMinutes === null ? '' : hours(glh.doneMinutes),
    hours(glh.expectedMinutes)
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const q of portfolio.qualifications) {
    for (const u of q.units) {
      if (unitId && u.id !== unitId) continue;
      for (const c of u.criteria) {
        lines.push(
          [
            q.title,
            u.code,
            u.title,
            c.code,
            c.text,
            c.requiredCount,
            c.acceptedCount,
            c.met ? 'Yes' : 'No',
            (titles.get(c.id) ?? []).join('; '),
            ...glhCells,
            ukDay(c.achievedAt),
            ukDay(u.achievedAt)
          ]
            .map(csvCell)
            .join(',')
        );
      }
    }
  }
  const safe = (v: string) =>
    v
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'export';
  await recordAudit({
    actor,
    action: 'appr.enrolment.exported',
    entityType: 'appr_enrolment',
    entityId: enrolmentId,
    metadata: { rows: lines.length - 1 }
  });
  return {
    // BOM so Excel opens UTF-8 correctly.
    csv: `﻿${lines.join('\r\n')}\r\n`,
    filename: `${safe(portfolio.learner.name)}-${safe(portfolio.programme.title)}.csv`
  };
}

// ── Withdraw / reinstate (Deploy 5, migration 0038) ──

const conflict = (message: string) => new AppError(message, ErrorCodes.CONFLICT, 409);

/**
 * POST /enrolments/:id/withdraw (admin). `scope` THIS withdraws just this enrolment (its units freeze and it leaves the
 * roll-up and the gateway count; the rest of a pair carries on, and a withdrawn CARRIER row stays the apprenticeship's
 * record for reviews / OTJ / onboarding / gateway). BOTH withdraws every half: the apprenticeship is CLOSED. A lone
 * enrolment is always closed. Evidence mappings are kept. Both halves are locked in id order, then the survivors'
 * numbers are re-derived in the same transaction.
 */
export async function withdrawEnrolment(actor: Actor, enrolmentId: string, input: EnrolmentWithdrawInput) {
  const a = requireAuthed(actor);
  if (a.role !== 'ADMIN') throw new AppError('Only an admin can withdraw an enrolment', ErrorCodes.FORBIDDEN, 403);
  const target = await getEnrolmentForActor(a, enrolmentId);
  const { carrier, component } = await resolveApprenticeship(target.id);
  const halves = component ? [carrier, component] : [carrier];
  const at = new Date().toISOString();

  const result = await runInTransaction(async (tx) => {
    const locked = await lockEnrolmentsInOrder(
      tx,
      halves.map((h) => h.id)
    );
    const fresh = new Map(locked.filter((r): r is NonNullable<typeof r> => !!r).map((r) => [r.id, r]));
    const wanted = input.scope === 'BOTH' ? halves : [target];
    const targets = wanted.filter((h) => !fresh.get(h.id)?.withdrawnAt);
    if (targets.length === 0) throw conflict('This enrolment is already withdrawn');

    for (const half of targets) {
      await setApprEnrolmentWithdrawn(tx, half.id, { userId: a.userId, reason: input.reason, at });
    }
    // Re-derive the survivors (the roll-up, the gateway units and the OTJ / evidence totals changed). The recompute of a
    // pair refreshes both halves; frozen halves keep their unit cache.
    const detail = await recomputeEnrolment(tx, carrier.id, { claimGatewayReady: true });
    const closed = halves.every((h) => targets.some((t) => t.id === h.id) || !!fresh.get(h.id)?.withdrawnAt);
    return { ids: targets.map((t) => t.id), closed, claimed: !!detail?.gatewayReadyClaimed };
  });

  if (result.claimed) {
    await notifyGatewayReadyOrRelease({
      enrolmentId: carrier.id,
      learnerId: carrier.learnerId,
      organizationId: carrier.organizationId
    });
  }
  await recordAudit({
    actor,
    action: 'appr.enrolment.withdrawn',
    entityType: 'appr_enrolment',
    entityId: target.id,
    metadata: { scope: input.scope, enrolmentIds: result.ids, closed: result.closed, reason: input.reason }
  });
  return { enrolmentId: target.id, withdrawnIds: result.ids, closed: result.closed, withdrawnAt: at };
}

/**
 * POST /enrolments/:id/reinstate (admin). Clears the withdrawn columns of this enrolment (scope THIS, the default) or of
 * every withdrawn half (BOTH), re-checks the one-diploma + one-standard rule against the learner's CURRENT open
 * enrolments (409 if reinstating would now violate it, e.g. they were enrolled on another diploma meanwhile), and
 * recomputes. The only write that works on a closed apprenticeship.
 */
export async function reinstateEnrolment(actor: Actor, enrolmentId: string, input: EnrolmentReinstateInput) {
  const a = requireAuthed(actor);
  if (a.role !== 'ADMIN') throw new AppError('Only an admin can reinstate an enrolment', ErrorCodes.FORBIDDEN, 403);
  const target = await getEnrolmentForActor(a, enrolmentId);
  const { carrier, component } = await resolveApprenticeship(target.id);
  const halves = component ? [carrier, component] : [carrier];

  const result = await runInTransaction(async (tx) => {
    // Same per-learner lock as enrol / link, so a concurrent enrolment cannot slip in between the check and the write.
    await lockLearnerEnrolments(tx, target.learnerId);
    const locked = await lockEnrolmentsInOrder(
      tx,
      halves.map((h) => h.id)
    );
    const fresh = new Map(locked.filter((r): r is NonNullable<typeof r> => !!r).map((r) => [r.id, r]));
    const wanted = input.scope === 'BOTH' ? halves : [target];
    const targets = wanted.filter((h) => fresh.get(h.id)?.withdrawnAt);
    if (targets.length === 0) throw conflict('This enrolment is not withdrawn');

    const targetIds = new Set(targets.map((t) => t.id));
    const open = (await listLearnerEnrolments(a.orgId, target.learnerId, tx)).filter(
      (e) => !e.achievedAt && !e.withdrawnAt && !targetIds.has(e.id)
    );
    const incoming: PlanProgramme[] = [];
    for (const half of targets) {
      const programme = await getApprProgramme(half.programmeId, tx);
      if (!programme) throw notFound();
      incoming.push({
        id: programme.id,
        title: programme.title,
        type: programme.type,
        pairedProgrammeId: programme.pairedProgrammeId
      });
    }
    const plan = planEnrolmentPairing(incoming, open);
    if ('error' in plan) throw conflict(plan.error);

    for (const half of targets) await clearApprEnrolmentWithdrawn(tx, half.id);
    const detail = await recomputeEnrolment(tx, carrier.id, { claimGatewayReady: true });
    return { ids: targets.map((t) => t.id), claimed: !!detail?.gatewayReadyClaimed };
  });

  if (result.claimed) {
    await notifyGatewayReadyOrRelease({
      enrolmentId: carrier.id,
      learnerId: carrier.learnerId,
      organizationId: carrier.organizationId
    });
  }
  await recordAudit({
    actor,
    action: 'appr.enrolment.reinstated',
    entityType: 'appr_enrolment',
    entityId: target.id,
    metadata: { scope: input.scope, enrolmentIds: result.ids }
  });
  return { enrolmentId: target.id, reinstatedIds: result.ids };
}
