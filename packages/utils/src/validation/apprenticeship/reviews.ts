import * as z from 'zod';
import { APPR_REVIEW_TARGETS_MAX } from '../../constants/apprenticeship';
import { toDayNumber } from '../../functions/apprenticeship-progress';

/** Validators for the Gecko Apprenticeships progress-review API. Lifecycle + lock rules live in the service. */

const trimmed = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.string().refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && toDayNumber(v) !== null, {
  message: 'Use a valid date (YYYY-MM-DD)'
});
const longText = z.string().trim().max(10000);

export const ZReviewIdParam = z.object({ id: z.uuid() });

export const ZReviewCreate = z.object({ scheduledDate: isoDate });
export type ReviewCreateInput = z.infer<typeof ZReviewCreate>;

export const ZReviewTarget = z.object({ text: trimmed(1000), due: isoDate.nullish() });

/** The statuses a user may move a review to by hand (COMPLETE happens by itself on the last signature). */
export const APPR_REVIEW_EDIT_STATUSES = ['SCHEDULED', 'DRAFT', 'AWAITING_SIGNATURES'] as const;

export const ZReviewUpdate = z
  .object({
    scheduledDate: isoDate,
    heldDate: isoDate.nullable(),
    progressSummary: longText.nullable(),
    targets: z.array(ZReviewTarget).max(APPR_REVIEW_TARGETS_MAX),
    tutorComment: longText.nullable(),
    employerComment: longText.nullable(),
    /** Learner-only (before they sign); staff cannot write it. */
    learnerComment: longText.nullable(),
    status: z.enum(APPR_REVIEW_EDIT_STATUSES),
    /** Optimistic concurrency: the updatedAt the editor loaded. A mismatch is a 409. */
    expectedUpdatedAt: z.string().max(64).optional()
  })
  .partial()
  .refine((v) => Object.keys(v).filter((k) => k !== 'expectedUpdatedAt').length > 0, {
    message: 'Nothing to update'
  });
export type ReviewUpdateInput = z.infer<typeof ZReviewUpdate>;

export const APPR_REVIEW_SIGN_ROLES = ['TUTOR', 'LEARNER', 'EMPLOYER'] as const;
export const ZReviewSign = z.object({ role: z.enum(APPR_REVIEW_SIGN_ROLES), name: trimmed(200) });
export type ReviewSignInput = z.infer<typeof ZReviewSign>;
