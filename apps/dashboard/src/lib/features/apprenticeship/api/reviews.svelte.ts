import type { ApprReviewStatus } from '@cio/utils/constants/apprenticeship';
import { classroomio } from '$lib/utils/services/api';
import { call } from './call';
import type { ProgressSummary } from './enrolments.svelte';

// Gecko Apprenticeships — client for progress reviews. Shapes mirror apps/api/src/services/apprenticeship/reviews.ts.

export interface ReviewTarget {
  text: string;
  due?: string | null;
}

export interface ReviewSnapshot extends Partial<ProgressSummary> {
  units?: { total: number; complete: number };
  capturedAt?: string;
}

export interface ReviewItem {
  id: string;
  enrolmentId: string;
  scheduledDate: string;
  heldDate: string | null;
  status: ApprReviewStatus;
  statusLabel: string;
  overdue: boolean;
  locked: boolean;
  snapshot: ReviewSnapshot | null;
  progressSummary: string | null;
  targets: ReviewTarget[];
  tutorComment: string | null;
  learnerComment: string | null;
  employerComment: string | null;
  tutorSignedName: string | null;
  tutorSignedAt: string | null;
  learnerSignedName: string | null;
  learnerSignedAt: string | null;
  employerSignedName: string | null;
  employerSignedAt: string | null;
  nextReviewDate: string | null;
  updatedAt: string;
  signatures: { tutor: boolean; learner: boolean; employer: boolean };
  /** Only on the response to the signature that completed the review. */
  scheduledNext?: boolean;
}

export interface ReviewList {
  items: ReviewItem[];
  counts: { total: number; overdue: number };
}

export interface ReviewUpdateBody {
  scheduledDate?: string;
  heldDate?: string | null;
  progressSummary?: string | null;
  targets?: { text: string; due?: string | null }[];
  tutorComment?: string | null;
  employerComment?: string | null;
  learnerComment?: string | null;
  status?: 'SCHEDULED' | 'DRAFT' | 'AWAITING_SIGNATURES';
  expectedUpdatedAt?: string;
}

class ReviewsApi {
  forEnrolment(enrolmentId: string) {
    return call<ReviewList>(() =>
      classroomio.apprenticeship.reviews.enrolments[':id'].reviews.$get({ param: { id: enrolmentId } })
    );
  }

  schedule(enrolmentId: string, scheduledDate: string) {
    return call<ReviewItem>(() =>
      classroomio.apprenticeship.reviews.enrolments[':id'].reviews.$post({
        param: { id: enrolmentId },
        json: { scheduledDate }
      })
    );
  }

  update(id: string, body: ReviewUpdateBody) {
    return call<ReviewItem>(() => classroomio.apprenticeship.reviews[':id'].$patch({ param: { id }, json: body }));
  }

  sign(id: string, role: 'TUTOR' | 'LEARNER' | 'EMPLOYER', name: string) {
    return call<ReviewItem>(() =>
      classroomio.apprenticeship.reviews[':id'].sign.$post({ param: { id }, json: { role, name } })
    );
  }

  cancel(id: string) {
    return call<ReviewItem>(() => classroomio.apprenticeship.reviews[':id'].cancel.$post({ param: { id } }));
  }
}

export const reviewsApi = new ReviewsApi();
