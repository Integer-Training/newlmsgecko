import { AppError, ErrorCodes } from '@api/utils/errors';
import { buildGatewayView, resolveChecklist } from '@api/services/apprenticeship/gateway-core';
import { computeRowProgress } from '@api/services/apprenticeship/enrolment';
import { ensureOnboardingTypes } from '@api/services/apprenticeship/onboarding';
import { requireAuthed } from '@api/services/apprenticeship/access';
import { todayIso } from '@api/services/apprenticeship/progress';
import type { Actor } from '@cio/db/actor';
import {
  countEvidenceByStatus,
  countIqaOpen,
  countTasksByStatus,
  getApprSettings,
  listEnrolmentRows,
  listOverdueTasks
} from '@cio/db/queries/apprenticeship';
import type { ApprProgressStatus } from '@cio/utils/constants/apprenticeship';
import { addDays, isReviewOverdue, toDayNumber } from '@cio/utils/functions/apprenticeship-progress';
import type { SummaryQueryInput } from '@cio/utils/validation/apprenticeship';

// Gecko Apprenticeships — the Summary dashboard. ADMIN → the whole org, TUTOR → only learners in their reach (named
// tutor OR programme tutor); everyone else 403. Learner / OTJ / review / gateway / onboarding numbers are derived from
// the SAME rows and rules as the learners table (listEnrolmentRows + computeRowProgress + buildGatewayView), so the
// tiles always equal what the lists show; that is one org-sized (tutor-sized) statement, not a per-learner loop. Tasks,
// evidence and IQA are small GROUP BY counts. There is no "withdrawn" enrolment state in the module, so every enrolment
// counts; finished learners fall in the COMPLETE bucket and are excluded from the OTJ split (their target is done).

const UPCOMING_DAYS = 14;
const LIST_MAX = 10;

type OtjStatus = Exclude<ApprProgressStatus, 'COMPLETE'>;

interface ReviewItem {
  reviewId: string;
  enrolmentId: string;
  learnerId: string;
  learnerName: string;
  programmeTitle: string;
  dueDate: string;
  status: string;
}

export async function getSummary(actor: Actor, query: SummaryQueryInput, now: Date = new Date()) {
  const a = requireAuthed(actor);
  if (a.role !== 'ADMIN' && a.role !== 'TUTOR') {
    throw new AppError('You do not have access to this action', ErrorCodes.FORBIDDEN, 403);
  }
  const isTutor = a.role === 'TUTOR';
  const today = todayIso(now);
  const scope = {
    organizationId: a.orgId,
    programmeId: query.programmeId,
    restrictToTutorId: isTutor ? a.userId : undefined
  };
  // The Onboarding count uses the org's document types, so give a new org its defaults first (as the learners list does).
  await ensureOnboardingTypes(a.orgId);

  const [rows, settings, evidenceByStatus, taskByStatus, overdue, iqa] = await Promise.all([
    listEnrolmentRows({ ...scope, today }),
    getApprSettings(a.orgId),
    countEvidenceByStatus(scope),
    countTasksByStatus(scope),
    listOverdueTasks(scope, today, { limit: LIST_MAX, offset: 0 }),
    countIqaOpen({
      organizationId: a.orgId,
      programmeId: query.programmeId,
      assessorId: isTutor ? a.userId : undefined
    })
  ]);

  const byStatus: Record<ApprProgressStatus, number> = { ON_TARGET: 0, BEHIND: 0, CONCERN: 0, NOT_SET: 0, COMPLETE: 0 };
  const otjByStatus: Record<OtjStatus, number> = { ON_TARGET: 0, BEHIND: 0, CONCERN: 0, NOT_SET: 0 };
  const gateway = { ready: 0, atGateway: 0, epaBooked: 0, achieved: 0, epaFailed: 0 };
  let minutesDone = 0;
  let minutesTarget = 0;
  let onboardingIncomplete = 0;
  const overdueReviews: ReviewItem[] = [];
  const upcomingReviews: ReviewItem[] = [];
  const upcomingEnd = addDays(today, UPCOMING_DAYS) ?? today;

  for (const r of rows) {
    const p = computeRowProgress(r, settings, today);
    byStatus[p.status] += 1;
    if (p.status !== 'COMPLETE') otjByStatus[p.otjStatus as OtjStatus] += 1;
    minutesDone += r.otjMinutes;
    minutesTarget += p.otjTargetMinutes ?? 0;
    if (r.onboarding && Number(r.onboarding.approved) < Number(r.onboarding.required)) onboardingIncomplete += 1;

    const stage = buildGatewayView({
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
    }).stage;
    if (stage === 'READY_FOR_GATEWAY') gateway.ready += 1;
    else if (stage === 'AT_GATEWAY') gateway.atGateway += 1;
    else if (stage === 'EPA_BOOKED') gateway.epaBooked += 1;
    else if (stage === 'ACHIEVED') gateway.achieved += 1;
    else if (stage === 'EPA_FAILED') gateway.epaFailed += 1;

    // The "next review" is the earliest open one, exactly as the learners list shows it.
    const next = r.nextReview;
    if (next) {
      const item: ReviewItem = {
        reviewId: next.id,
        enrolmentId: r.id,
        learnerId: r.learnerId,
        learnerName: r.learnerName,
        programmeTitle: r.programmeTitle,
        dueDate: next.scheduledDate,
        status: next.status
      };
      if (isReviewOverdue(next, today)) overdueReviews.push(item);
      else if (next.scheduledDate <= upcomingEnd) upcomingReviews.push(item);
    }
  }
  const byDueDate = (x: ReviewItem, y: ReviewItem) => x.dueDate.localeCompare(y.dueDate);
  overdueReviews.sort(byDueDate);
  upcomingReviews.sort(byDueDate);

  const evidence: Record<string, number> = { SUBMITTED: 0, ACCEPTED: 0, REFERRED: 0 };
  for (const [status, n] of evidenceByStatus) evidence[status] = n;
  const tasks: Record<string, number> = { PLANNED: 0, SUBMITTED: 0, REFERRED: 0, COMPLETE: 0 };
  for (const [status, n] of taskByStatus) tasks[status] = n;
  const todayDay = toDayNumber(today) ?? 0;

  return {
    scope: isTutor ? ('TUTOR' as const) : ('ORG' as const),
    learners: { total: rows.length, byStatus },
    otj: { byStatus: otjByStatus, minutesDone, minutesTarget },
    // Same rule as the To mark list: evidence in SUBMITTED.
    toMark: evidence.SUBMITTED ?? 0,
    evidence,
    tasks: {
      byStatus: tasks,
      overdue: overdue[0]?.total ?? 0,
      overdueList: overdue.map((t) => ({
        taskId: t.id,
        title: t.title,
        dueDate: t.dueDate,
        daysOverdue: Math.max(0, todayDay - (toDayNumber(t.dueDate) ?? todayDay)),
        enrolmentId: t.enrolmentId,
        learnerId: t.learnerId,
        learnerName: t.learnerName,
        programmeTitle: t.programmeTitle
      }))
    },
    reviews: {
      overdueTotal: overdueReviews.length,
      overdue: overdueReviews.slice(0, LIST_MAX),
      upcomingTotal: upcomingReviews.length,
      upcoming: upcomingReviews.slice(0, LIST_MAX)
    },
    gateway,
    onboardingIncomplete,
    iqa
  };
}
