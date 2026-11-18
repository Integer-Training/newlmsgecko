import { getEnrolmentForActor } from '@api/services/apprenticeship/access';
import { getPortfolio } from '@api/services/apprenticeship/enrolment';
import { listEnrolmentTasks } from '@api/services/apprenticeship/tasks';
import { nameGatewayActors } from '@api/services/apprenticeship/gateway-names';
import { buildApprenticeshipProgress } from '@api/services/apprenticeship/gateway';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import {
  getApprEnrolment,
  getApprProgrammeStructure,
  getLinkedEnrolment,
  listEvidenceForReport,
  listOtjLogsForReport,
  listReviewsForEnrolment
} from '@cio/db/queries/apprenticeship';
import { APPR_PROGRESS_STATUS_LABELS } from '@cio/utils/constants/apprenticeship';

// Gecko Apprenticeships — the data behind the client-side PDF portfolio report. ONE JSON payload assembled from the
// existing portfolio / tasks / evidence / reviews / gateway reads (so the PDF can never disagree with the screens).
// Access = getEnrolmentForActor (admin, tutor in reach, learner self; anything else 404). By design NOT included: IQA
// samples, onboarding documents, and any file key / URL (evidence files are reported by NAME only).

/** The report is of the whole apprenticeship: either half's id gives the carrier's report, with both qualifications. */
export async function getPortfolioReport(actor: Actor, enrolmentId: string, now: Date = new Date()) {
  const opened = await getEnrolmentForActor(actor, enrolmentId);
  const carrierRow = opened.primaryEnrolmentId ? await getApprEnrolment(opened.primaryEnrolmentId) : null;
  const enrolment = carrierRow ?? opened;
  const component = await getLinkedEnrolment(enrolment.id);
  const [portfolio, tasks, evidence, reviews, structure] = await Promise.all([
    getPortfolio(actor, enrolment.id),
    listEnrolmentTasks(actor, enrolment.id, now),
    listEvidenceForReport(enrolment.organizationId, enrolment.programmeId, enrolment.learnerId),
    listReviewsForEnrolment(enrolment.id),
    getApprProgrammeStructure(enrolment.programmeId)
  ]);
  // The other qualification of a pair: its units, evidence and tasks join the report; the gateway is the pair's.
  const [otherPortfolio, otherTasks, otherEvidence, otherStructure, pairProgress] = component
    ? await Promise.all([
        getPortfolio(actor, component.id),
        listEnrolmentTasks(actor, component.id, now),
        listEvidenceForReport(component.organizationId, component.programmeId, component.learnerId),
        getApprProgrammeStructure(component.programmeId),
        buildApprenticeshipProgress(enrolment.id)
      ])
    : [null, null, null, null, null];
  const otjLogs = await listOtjLogsForReport(component ? [enrolment.id, component.id] : [enrolment.id]);
  const gateway = await nameGatewayActors(pairProgress?.gateway ?? portfolio.gateway);
  const glhByUnit = new Map([...structure.units, ...(otherStructure?.units ?? [])].map((u) => [u.id, u.glh ?? null]));
  const qualifications = [
    ...portfolio.qualifications.map((q) => ({ ...q, programmeTitle: portfolio.programme.title })),
    ...(otherPortfolio?.qualifications ?? []).map((q) => ({ ...q, programmeTitle: otherPortfolio!.programme.title }))
  ];
  const allEvidence = [...evidence, ...(otherEvidence ?? [])].sort((x, y) =>
    String(x.createdAt).localeCompare(String(y.createdAt))
  );
  const allTasks = [...tasks.items, ...(otherTasks?.items ?? [])];
  const firstQualification = qualifications[0];

  await recordAudit({
    actor,
    action: 'appr.portfolio.report',
    entityType: 'appr_enrolment',
    entityId: enrolment.id,
    metadata: { evidence: allEvidence.length, linked: Boolean(component) }
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
      qualifications: qualifications.map((q) => ({
        programmeTitle: q.programmeTitle,
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
      stage: gateway.stage,
      stageLabel: gateway.stageLabel,
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
    units: qualifications.flatMap((q) =>
      q.units.map((u) => ({
        ref: u.code,
        title: u.title,
        qualificationTitle: q.title,
        programmeTitle: q.programmeTitle,
        glh: glhByUnit.get(u.id) ?? null,
        completePct: u.actualPct,
        achievedAt: u.achievedAt,
        criteria: u.criteria.map((c) => ({ ref: c.code, title: c.text, met: c.met, achievedAt: c.achievedAt }))
      }))
    ),
    evidence: allEvidence.map((ev) => ({
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
    tasks: allTasks.map((t) => ({
      title: t.title,
      dueDate: t.dueDate,
      status: t.status,
      overdue: t.overdue
    })),
    // Off-the-job log: validated + pending entries (rejected are left out), both halves of a pair.
    otjLog: otjLogs.map((l) => ({
      title: l.title,
      logDate: l.logDate,
      minutes: l.minutes,
      isOtj: l.isOtj,
      status: l.status
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
