import * as z from 'zod';
import { APPR_ONBOARDING_FILES_MAX, APPR_ONBOARDING_LABEL_MAX, APPR_NOTE_MAX } from '../../constants/apprenticeship';
import { ZEvidenceFile } from './enrolment';

// Gecko Apprenticeships — onboarding documents. Ownership (org / enrolment / file-key prefix) is checked in the services.

const trimmed = (max: number) => z.string().trim().min(1).max(max);
const note = z.string().trim().max(APPR_NOTE_MAX);

export const ZOnboardingEnrolmentParam = z.object({ id: z.uuid() });
export const ZOnboardingDocParam = z.object({ id: z.uuid(), docTypeId: z.uuid() });
export const ZOnboardingTypeParam = z.object({ typeId: z.uuid() });

/** Learner (or admin on their behalf) saves the upload slot for one document type. */
export const ZOnboardingDocSave = z
  .object({
    files: z.array(ZEvidenceFile).max(APPR_ONBOARDING_FILES_MAX).default([]),
    notHeld: z.boolean().default(false),
    learnerNote: note.nullable().optional()
  })
  .refine((v) => v.notHeld || v.files.length > 0, { message: 'Add at least one file', path: ['files'] });
export type OnboardingDocSaveInput = z.infer<typeof ZOnboardingDocSave>;

export const ZOnboardingDocReview = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: note.nullable().optional(),
    /** The status the reviewer saw; a mismatch means someone changed it meanwhile (409). */
    expectedStatus: z.enum(['SUBMITTED', 'APPROVED', 'REJECTED'])
  })
  .refine((v) => v.decision === 'APPROVE' || (v.note && v.note.length > 0), {
    message: 'Say what needs fixing',
    path: ['note']
  });
export type OnboardingDocReviewInput = z.infer<typeof ZOnboardingDocReview>;

export const ZOnboardingPresign = z.object({
  docTypeId: z.uuid(),
  files: z
    .array(z.object({ name: trimmed(255), size: z.number().int().min(0).optional(), type: trimmed(150) }))
    .min(1)
    .max(APPR_ONBOARDING_FILES_MAX)
});
export type OnboardingPresignInput = z.infer<typeof ZOnboardingPresign>;

export const ZOnboardingDownload = z.object({ keys: z.array(z.string().min(1).max(600)).min(1).max(50) });

const typeFields = {
  label: trimmed(APPR_ONBOARDING_LABEL_MAX),
  description: z.string().trim().max(1000).nullable(),
  required: z.boolean(),
  allowNotHeld: z.boolean(),
  programmeId: z.uuid().nullable(),
  active: z.boolean()
};
export const ZOnboardingTypeCreate = z.object({
  ...typeFields,
  description: typeFields.description.optional(),
  required: typeFields.required.default(true),
  allowNotHeld: typeFields.allowNotHeld.default(false),
  programmeId: typeFields.programmeId.optional(),
  active: typeFields.active.default(true)
});
export type OnboardingTypeCreateInput = z.infer<typeof ZOnboardingTypeCreate>;
export const ZOnboardingTypeUpdate = z
  .object(typeFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type OnboardingTypeUpdateInput = z.infer<typeof ZOnboardingTypeUpdate>;
export const ZOnboardingTypeReorder = z.object({ typeIds: z.array(z.uuid()).min(1).max(200) });
