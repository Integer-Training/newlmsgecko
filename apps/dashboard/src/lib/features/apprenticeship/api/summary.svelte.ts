import { classroomio } from '$lib/utils/services/api';
import type { ApprProgressStatus } from '@cio/utils/constants/apprenticeship';
import { call } from './call';

// Gecko Apprenticeships — client for the summary dashboard. Shape mirrors apps/api/src/services/apprenticeship/summary.ts.
// Admin sees the whole org; a tutor only their own learners (scope says which).

export interface SummaryReview {
  reviewId: string;
  enrolmentId: string;
  learnerId: string;
  learnerName: string | null;
  programmeTitle: string;
  dueDate: string;
  status: string;
}

export interface SummaryOverdueTask {
  taskId: string;
  title: string;
  dueDate: string;
  daysOverdue: number;
  enrolmentId: string;
  learnerId: string;
  learnerName: string | null;
  programmeTitle: string;
}

export interface ApprSummary {
  scope: string;
  learners: { total: number; byStatus: Record<ApprProgressStatus, number> };
  otj: {
    byStatus: Record<Exclude<ApprProgressStatus, 'COMPLETE'>, number>;
    minutesDone: number;
    minutesTarget: number;
  };
  toMark: number;
  evidence: { SUBMITTED: number; ACCEPTED: number; REFERRED: number };
  tasks: {
    byStatus: { PLANNED: number; SUBMITTED: number; REFERRED: number; COMPLETE: number };
    overdue: number;
    overdueList: SummaryOverdueTask[];
  };
  reviews: {
    overdueTotal: number;
    overdue: SummaryReview[];
    upcomingTotal: number;
    upcoming: SummaryReview[];
  };
  gateway: { ready: number; atGateway: number; epaBooked: number; achieved: number; epaFailed: number };
  onboardingIncomplete: number;
  iqa: { pending: number; awaitingAck: number };
}

class ApprSummaryApi {
  get(programmeId?: string) {
    return call<ApprSummary>(() =>
      classroomio.apprenticeship.summary.$get({ query: programmeId ? { programmeId } : {} })
    );
  }
}

export const apprSummaryApi = new ApprSummaryApi();
