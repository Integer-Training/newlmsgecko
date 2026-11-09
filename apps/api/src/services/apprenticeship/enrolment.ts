import { AppError, ErrorCodes } from '@api/utils/errors';
import {
  assertStaff,
  canAccessLearner,
  getEnrolmentForActor,
  getProgrammeForActor,
  requireAuthed
} from '@api/services/apprenticeship/access';
import { buildGatewayView, buildGlhView, resolveChecklist } from '@api/services/apprenticeship/gateway-core';
import { notifyGatewayReady, notifySafely } from '@api/services/apprenticeship/notifications';
import { recomputeEnrolment, todayIso, type EnrolmentProgressDetail } from '@api/services/apprenticeship/progress';
import { createOrgUser } from '@api/services/organization/users';
import { createTutorAllocation } from '@api/services/organization/allocation';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import { runInTransaction, type TxClient } from '@cio/db/drizzle';
import { getOrgMemberRoleId } from '@cio/db/queries/allocation';
import {
  countEvidenceByCriterion,
  getApprEnrolmentByProgrammeLearner,
  getApprProgrammeStructure,
  getApprSettings,
  getEnrolmentOverview,
  getEvidenceTotals,
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
  listApprPickerPeople,
  listEnrolmentRows,
  listEnrolmentUnitRows,
  updateApprEnrolment,
  upsertEnrolmentUnitDates
} from '@cio/db/queries/apprenticeship';
import {
  APPR_PROGRESS_STATUS_LABELS,
  type ApprProgressStatus,
  type ApprSettings
} from '@cio/utils/constants/apprenticeship';
import { ROLE } from '@cio/utils/constants';
import { isUniqueConstraintViolation } from '@cio/utils/errors';
import {
  averagePct,
  computeEnrolmentProgress,
  criterionMet,
  expectedPct,
  firstReviewDate,
  glhExpectedMinutes,
  isReviewOverdue,
  otjExpectedMinutes,
  otjTargetMinutes,
  progressStatus,
  spreadUnitDates,
  taskDueDate,
  toDayNumber,
  type ApprUnitInput
} from '@cio/utils/functions/apprenticeship-progress';
import type {
  EnrolmentCreateInput,
  EnrolmentListQuery,
  EnrolmentUpdateInput,
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
    tutorId: query.tutorId,
    search: query.search || undefined,
    today: todayIso(now)
  };
  if (a.role === 'TUTOR') scope.restrictToTutorId = a.userId;
  else if (a.role === 'LEARNER') scope.restrictToLearnerId = a.userId;
  else if (a.role !== 'ADMIN') throw new AppError('You do not have access to this action', ErrorCodes.FORBIDDEN, 403);

  const [rows, settings] = await Promise.all([listEnrolmentRows(scope), getApprSettings(a.orgId)]);
  const today = todayIso(now);

  const computed = rows.map((r) => {
    const p = computeRowProgress(r, settings, today);
    const gateway = buildGatewayView({
      checklist: resolveChecklist(r.gatewayChecklist),
      manual: r.gatewayItems,
      unitsTotal: r.unitsTotal ?? 0,
      unitsComplete: r.unitsComplete ?? 0,
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
    return {
      id: r.id,
      programmeId: r.programmeId,
      programmeTitle: r.programmeTitle,
      learner: { id: r.learnerId, name: r.learnerName, email: r.learnerEmail },
      tutors: r.tutors ?? [],
      startDate: r.startDate,
      plannedEndDate: r.plannedEndDate,
      achievedAt: r.achievedAt,
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
  for (const c of computed) statusCounts[c.status] += 1;

  const filtered = query.status ? computed.filter((c) => c.status === query.status) : computed;
  filtered.sort(
    (x, y) => STATUS_RANK[x.status] - STATUS_RANK[y.status] || x.learner.name.localeCompare(y.learner.name)
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

export async function createEnrolment(actor: Actor, input: EnrolmentCreateInput) {
  const a = requireAuthed(actor);
  if (a.role !== 'ADMIN') throw new AppError('Only an admin can enrol a learner', ErrorCodes.FORBIDDEN, 403);

  const programme = await getProgrammeForActor(a, input.programmeId);
  if (programme.status !== 'ACTIVE') throw badRequest('This programme is archived', 'programmeId');

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
    if (await getApprEnrolmentByProgrammeLearner(programme.id, learnerId)) {
      throw new AppError('This learner is already enrolled on this programme', ErrorCodes.CONFLICT, 409, 'learner');
    }
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

  const structure = await getApprProgrammeStructure(programme.id);
  let enrolmentId: string;
  try {
    enrolmentId = await runInTransaction(async (tx) => {
      const row = await insertApprEnrolment(tx, {
        organizationId: a.orgId,
        programmeId: programme.id,
        learnerId,
        startDate: input.startDate,
        plannedEndDate: input.plannedEndDate,
        contractedHoursWeek: input.contractedHoursWeek ?? null,
        otjTargetMinutesOverride: input.otjTargetMinutesOverride ?? null,
        createdBy: a.userId
      });
      await insertEnrolmentUnits(
        tx,
        row.id,
        structure.units.map((u) => u.id)
      );
      // The first progress review: learner start + the programme's review interval (staff can reschedule it).
      const firstReview = firstReviewDate(input.startDate, programme.reviewIntervalWeeks, todayIso());
      if (firstReview) {
        await insertApprReview(tx, {
          organizationId: a.orgId,
          enrolmentId: row.id,
          scheduledDate: firstReview,
          createdBy: a.userId
        });
      }
      await recomputeEnrolment(tx, row.id);
      return row.id;
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new AppError('This learner is already enrolled on this programme', ErrorCodes.CONFLICT, 409, 'learner');
    }
    throw error;
  }

  await recordAudit({
    actor,
    action: 'appr.enrolment.created',
    entityType: 'appr_enrolment',
    entityId: enrolmentId,
    metadata: {
      programmeId: programme.id,
      learnerId,
      tutorId: input.tutorId,
      newLearner: temporaryPassword !== undefined
    }
  });
  return { id: enrolmentId, learnerId, programmeId: programme.id, ...(temporaryPassword ? { temporaryPassword } : {}) };
}

// ── Portfolio ──

/** Everything the portfolio page needs, loaded in one parallel round after the overview/access check. */
async function loadPortfolio(actor: Actor, enrolmentId: string, now: Date = new Date()) {
  requireAuthed(actor);
  const overview = await getEnrolmentOverview(enrolmentId, undefined, todayIso(now));
  if (!overview || !(await canAccessLearner(actor, overview.enrolment.organizationId, overview.enrolment.learnerId))) {
    throw notFound();
  }
  const { enrolment } = overview;
  const [structure, counts, totals, unitRows, settings, loggedGlh] = await Promise.all([
    getApprProgrammeStructure(enrolment.programmeId),
    countEvidenceByCriterion(enrolment.programmeId, enrolment.learnerId),
    getEvidenceTotals(enrolment.programmeId, enrolment.learnerId),
    listEnrolmentUnitRows(enrolment.id),
    getApprSettings(enrolment.organizationId),
    sumGlhLogMinutes(enrolment.id)
  ]);

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
    const units = structure.units
      .filter((u) => u.qualificationId === q.id)
      .map((u) => {
        const p = progressByUnit.get(u.id);
        return {
          id: u.id,
          code: u.code,
          title: u.title,
          startDate: datesByUnit.get(u.id)?.startDate ?? null,
          targetDate: datesByUnit.get(u.id)?.targetDate ?? null,
          actualPct: p?.actualPct ?? null,
          expectedPct: p?.expectedPct ?? null,
          status: p?.status ?? ('NOT_SET' as ApprProgressStatus),
          criteria: (criteriaByUnit.get(u.id) ?? []).map((c) => {
            const n = counts.get(c.id) ?? { accepted: 0, submitted: 0 };
            return {
              id: c.id,
              code: c.code,
              text: c.text,
              groupLabel: c.groupLabel,
              requiredCount: c.requiredCount,
              acceptedCount: n.accepted,
              met: criterionMet(n.accepted, c.requiredCount),
              evidenceCount: n.accepted + n.submitted,
              pendingCount: n.submitted
            };
          })
        };
      });
    return {
      id: q.id,
      title: q.title,
      reference: q.reference,
      awardingBody: q.awardingBody,
      level: q.level,
      actualPct: averagePct(units.map((u) => u.actualPct)),
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
  const gateway = buildGatewayView({
    checklist: resolveChecklist(overview.gatewayChecklist),
    manual: enrolment.gatewayItems,
    unitsTotal: structure.units.length,
    unitsComplete: structure.units.filter((u) => progressByUnit.get(u.id)?.status === 'COMPLETE').length,
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
      recomputedAt: enrolment.recomputedAt
    },
    learner: { id: enrolment.learnerId, name: overview.learnerName, email: overview.learnerEmail },
    programme: {
      id: enrolment.programmeId,
      title: overview.programmeTitle,
      reference: overview.programmeReference,
      level: overview.programmeLevel
    },
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
    if (due !== task.dueDate) await updateApprTask(tx, task.id, { dueDate: due, overdueNotifiedAt: null }, 'PLANNED');
  }
}

export async function updateEnrolment(actor: Actor, enrolmentId: string, patch: EnrolmentUpdateInput) {
  const a = assertStaff(actor);
  // Programme dates / contracted hours / OTJ override set the learner's targets — admin only (the route says so too).
  if (a.role !== 'ADMIN')
    throw new AppError('Only an admin can change programme dates and hours', ErrorCodes.FORBIDDEN, 403);
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
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
    await notifySafely('gateway ready', () =>
      notifyGatewayReady({
        enrolmentId,
        learnerId: enrolment.learnerId,
        organizationId: enrolment.organizationId
      })
    );
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
    'GLH expected (h)'
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
            ...glhCells
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
