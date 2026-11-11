import * as z from 'zod';
import { APPR_IQA_FEEDBACK_MAX, APPR_IQA_SUGGEST_MAX } from '../../constants/apprenticeship';

/** Validators for Gecko Apprenticeships IQA sampling, the summary dashboard and the PDF portfolio report. */

// ── IQA ──

export const ZIqaSampleParam = z.object({ sampleId: z.uuid() });
export const ZIqaEvidenceParam = z.object({ evidenceId: z.uuid() });

/** Coverage + sample list filters (admin). Omitted programmeId = every programme in the org. */
export const ZIqaQuery = z.object({
  programmeId: z.uuid().optional(),
  assessorId: z.uuid().optional(),
  outcome: z.enum(['PENDING', 'AGREE', 'DISAGREE']).optional()
});
export type IqaQueryInput = z.infer<typeof ZIqaQuery>;

/** Manual "Sample for IQA" from the evidence sheet. */
export const ZIqaSampleCreate = z.object({ evidenceId: z.uuid() });
export type IqaSampleCreateInput = z.infer<typeof ZIqaSampleCreate>;

/**
 * "Suggest sample": random unsampled ACCEPTED evidence per assessor, up to the target %. `preview: true` returns the
 * picks without saving; otherwise the picks are created (an evidence sampled meanwhile is skipped, never duplicated).
 * `evidenceIds` = confirm exactly the previewed picks (re-checked server side) instead of drawing a new random set.
 */
export const ZIqaSuggest = z.object({
  programmeId: z.uuid().optional(),
  assessorId: z.uuid().optional(),
  max: z.number().int().min(1).max(APPR_IQA_SUGGEST_MAX).default(APPR_IQA_SUGGEST_MAX),
  preview: z.boolean().default(false),
  evidenceIds: z.array(z.uuid()).min(1).max(APPR_IQA_SUGGEST_MAX).optional()
});
export type IqaSuggestInput = z.infer<typeof ZIqaSuggest>;

/**
 * Record the IQA outcome. Feedback is required for DISAGREE. expectedOutcome (+ expectedDecidedAt when changing an
 * existing decision) = what the reviewer saw; anything else → 409.
 */
export const ZIqaDecide = z
  .object({
    outcome: z.enum(['AGREE', 'DISAGREE']),
    feedback: z.string().trim().max(APPR_IQA_FEEDBACK_MAX).nullish(),
    expectedOutcome: z.enum(['PENDING', 'AGREE', 'DISAGREE']),
    expectedDecidedAt: z.string().max(64).nullish()
  })
  .refine((v) => v.outcome !== 'DISAGREE' || (v.feedback ?? '').length > 0, {
    message: 'Give feedback for the assessor when you disagree',
    path: ['feedback']
  });
export type IqaDecideInput = z.infer<typeof ZIqaDecide>;

/** Acknowledge the decision the assessor saw (`decidedAt`); a decision changed since → 409. */
export const ZIqaAcknowledge = z.object({ decidedAt: z.string().max(64) });
export type IqaAcknowledgeInput = z.infer<typeof ZIqaAcknowledge>;

export const ZIqaTargetPut = z.object({ iqaTargetPct: z.number().int().min(1).max(100) });
export type IqaTargetPutInput = z.infer<typeof ZIqaTargetPut>;

// ── Summary dashboard ──

/** Admin: whole org (optionally one programme). Tutor: always scoped to their own learners by the service. */
export const ZSummaryQuery = z.object({ programmeId: z.uuid().optional() });
export type SummaryQueryInput = z.infer<typeof ZSummaryQuery>;
