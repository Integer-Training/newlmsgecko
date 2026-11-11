import { classroomio } from '$lib/utils/services/api';
import { call } from './call';

// Gecko Apprenticeships — client for the portfolio report (the data behind the client-side PDF). Shape mirrors
// apps/api/src/services/apprenticeship/report.ts.

export interface PortfolioReport {
  generatedAt: string;
  learner: { id: string; name: string | null; email: string | null };
  programme: {
    id: string;
    title: string;
    reference: string | null;
    level: string | number | null;
    awardingBody: string | null;
    qualifications: {
      title: string;
      reference: string | null;
      level: string | number | null;
      awardingBody: string | null;
    }[];
  };
  enrolment: {
    startDate: string | null;
    plannedEndDate: string | null;
    status: string;
    statusLabel: string;
    achievedAt: string | null;
    stage: string;
    stageLabel: string;
    epaBookedDate: string | null;
    epaResult: string | null;
    epaResultDate: string | null;
  };
  tutors: { id: string; name: string | null; kind: 'NAMED' | 'PROGRAMME' }[];
  progress: { actualPct: number | null; expectedPct: number | null; status: string };
  otj: { minutesDone: number; minutesTarget: number | null; minutesExpected: number | null; status: string };
  glh: { targetMinutes: number | null; doneMinutes: number | null; expectedMinutes: number | null };
  units: {
    ref: string | null;
    title: string;
    qualificationTitle: string;
    glh: number | null;
    completePct: number | null;
    criteria: { ref: string | null; title: string; met: boolean }[];
  }[];
  evidence: {
    title: string;
    typeLabel: string;
    status: string;
    createdAt: string;
    reviewedAt: string | null;
    reviewedByName: string | null;
    criteriaRefs: string[];
    fileNames: string[];
    minutes: number;
    includeOtj: boolean;
  }[];
  tasks: { title: string; dueDate: string | null; status: string; overdue: boolean }[];
  reviews: {
    scheduledDate: string | null;
    heldDate: string | null;
    status: string;
    progressSummary: string | null;
    targets: string | null;
    tutorComment: string | null;
    learnerComment: string | null;
    employerComment: string | null;
    signatures: Record<'tutor' | 'learner' | 'employer', { name: string | null; signedAt: string | null }>;
    nextReviewDate: string | null;
  }[];
  gateway: {
    items: { label: string; done: boolean; byName: string | null; at: string | null; note: string | null }[];
    passedAt: string | null;
    passedByName: string | null;
    epaBookedDate: string | null;
    epaResult: string | null;
    epaResultDate: string | null;
  };
}

class ApprReportApi {
  get(enrolmentId: string) {
    return call<PortfolioReport>(
      () => classroomio.apprenticeship.enrolments[':id']['portfolio-report'].$get({ param: { id: enrolmentId } }),
      'Could not load the portfolio report'
    );
  }
}

export const reportApi = new ApprReportApi();
