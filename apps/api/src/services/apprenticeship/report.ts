import { getEnrolmentForActor } from '@api/services/apprenticeship/access';
import { getPortfolio } from '@api/services/apprenticeship/enrolment';
import { listEnrolmentTasks } from '@api/services/apprenticeship/tasks';
import { nameGatewayActors } from '@api/services/apprenticeship/gateway-names';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import {
  getApprProgrammeStructure,
  listEvidenceForReport,
  listReviewsForEnrolment
} from '@cio/db/queries/apprenticeship';
import { APPR_PROGRESS_STATUS_LABELS } from '@cio/utils/constants/apprenticeship';

// Gecko Apprenticeships — the data behind the client-side PDF portfolio report. ONE JSON payload assembled from the
// existing portfolio / tasks / evidence / reviews / gateway reads (so the PDF can never disagree with the screens).
// Access = getEnrolmentForActor (admin, tutor in reach, learner self; anything else 404). By design NOT included: IQA
// samples, onboarding documents, and any file key / URL (evidence files are reported by NAME only).

export async function getPortfolioReport(actor: Actor, enrolmentId: string, now: Date = new Date()) {
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  const [portfolio, tasks, evidence, reviews, structure] = await Promise.all([
    getPortfolio(actor, enrolment.id),
    listEnrolmentTasks(actor, enrolment.id, now),
    listEvidenceForReport(enrolment.organizationId, enrolment.programmeId, enrolment.learnerId),
    listReviewsForEnrolment(enrolment.id),
    getApprProgrammeStructure(enrolment.programmeId)
  ]);
  const gateway = await nameGatewayActors(portfolio.gateway);
  const glhByUnit = new Map(structure.units.map((u) => [u.id, u.glh ?? null]));
  const firstQualification = portfolio.qualifications[0];

  await recordAudit({
    actor,
    action: 'appr.portfolio.report',
    entityType: 'appr_enrolment',
    entityId: enrolment.id,
    metadata: { evidence: evidence.length }
  });

  const e = portfolio.enrolment;
  const s = portfolio.summary;
  return {
    generatedAt: now.toISOString(),
    learner: portfolio.learner,
    programme: {
      id: portfolio.programme.id,
      title: portfolio.programme.title,
      reference: portfolio.programme.reference,
      level: portfolio.programme.level,
      awardingBody: firstQualification?.awardingBody ?? null,
      qualifications: portfolio.qualifications.map((q) => ({
        title: q.title,
        reference: q.reference,
        level: q.level,
        awardingBody: q.awardingBody
      }))
    },
    enrolment: {
      startDate: e.startDate,
      plannedEndDate: e.plannedEndDate,
      status: s.status,
      statusLabel: APPR_PROGRESS_STATUS_LABELS[s.status],
      achievedAt: e.achievedAt,
      stage: s.stage,
      stageLabel: s.stageLabel,
      epaBookedDate: gateway.epaBookedDate,
      epaResult: gateway.epaResult,
      epaResultDate: gateway.epaResultDate
    },
    tutors: portfolio.tutors,
    progress: { actualPct: s.actualPct, expectedPct: s.expectedPct, status: s.status },
    otj: {
      minutesDone: s.otj.minutes,
      minutesTarget: s.otj.targetMinutes,
      minutesExpected: s.otj.expectedMinutes,
      status: s.otj.status
    },
    glh: s.glh,
    units: portfolio.qualifications.flatMap((q) =>
      q.units.map((u) => ({
        ref: u.code,
        title: u.title,
        qualificationTitle: q.title,
        glh: glhByUnit.get(u.id) ?? null,
        completePct: u.actualPct,
        criteria: u.criteria.map((c) => ({ ref: c.code, title: c.text, met: c.met }))
      }))
    ),
    evidence: evidence.map((ev) => ({
      title: ev.title,
      typeLabel: ev.typeLabel,
      status: ev.status,
      createdAt: ev.createdAt,
      reviewedAt: ev.reviewedAt,
      reviewedByName: ev.reviewedByName,
      criteriaRefs: ev.criteriaRefs,
      fileNames: ev.fileNames,
      minutes: ev.minutes,
      includeOtj: ev.includeOtj
    })),
    tasks: tasks.items.map((t) => ({
      title: t.title,
      dueDate: t.dueDate,
      status: t.status,
      overdue: t.overdue
    })),
    reviews: reviews.map((r) => ({
      scheduledDate: r.scheduledDate,
      heldDate: r.heldDate,
      status: r.status,
      progressSummary: r.progressSummary,
      targets: r.targets,
      tutorComment: r.tutorComment,
      learnerComment: r.learnerComment,
      employerComment: r.employerComment,
      signatures: {
        tutor: { name: r.tutorSignedName, signedAt: r.tutorSignedAt },
        learner: { name: r.learnerSignedName, signedAt: r.learnerSignedAt },
        employer: { name: r.employerSignedName, signedAt: r.employerSignedAt }
      },
      nextReviewDate: r.nextReviewDate
    })),
    gateway: {
      items: gateway.items.map((i) => ({
        label: i.label,
        done: i.done,
        byName: i.byName ?? null,
        at: i.at,
        note: i.note
      })),
      passedAt: gateway.gatewayPassedAt,
      passedByName: gateway.gatewayPassedByName ?? null,
      epaBookedDate: gateway.epaBookedDate,
      epaResult: gateway.epaResult,
      epaResultDate: gateway.epaResultDate
    }
  };
}
