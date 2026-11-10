import * as z from 'zod';
import {
  APPR_EVIDENCE_DETAILS_MAX,
  APPR_EVIDENCE_TITLE_MAX,
  APPR_NOTE_KINDS,
  APPR_NOTE_MAX,
  APPR_PROGRESS_STATUSES
} from '../../constants/apprenticeship';
import { toDayNumber } from '../../functions/apprenticeship-progress';

/**
 * Validators for the Gecko Apprenticeships enrolment + evidence API. Ownership (org / enrolment / programme chain,
 * file-key prefix) is checked server-side in the services; these only check shape and ranges.
 */

const trimmed = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.string().refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && toDayNumber(v) !== null, {
  message: 'Use a valid date (YYYY-MM-DD)'
});

// ── Enrolments ──

export const ZEnrolmentIdParam = z.object({ id: z.uuid() });

export const ZEnrolmentListQuery = z.object({
  programmeId: z.uuid().optional(),
  tutorId: z.uuid().optional(),
  status: z.enum(APPR_PROGRESS_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
  // 'true' → learners with neither a named tutor nor a programme tutor.
  noTutor: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === 'true' ? true : undefined)),
  // 'incomplete' → learners whose required onboarding documents are not all approved.
  onboarding: z.enum(['incomplete']).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
});
export type EnrolmentListQuery = z.infer<typeof ZEnrolmentListQuery>;

const learnerRef = z.union([
  z.object({ learnerId: z.uuid() }),
  z.object({ firstName: trimmed(100), lastName: trimmed(100), email: z.email().max(254) })
]);

export const ZEnrolmentCreate = z
  .object({
    programmeId: z.uuid(),
    learner: learnerRef,
    tutorId: z.uuid(),
    startDate: isoDate,
    plannedEndDate: isoDate,
    contractedHoursWeek: z.number().min(0.5).max(168).nullish(),
    otjTargetMinutesOverride: z.number().int().min(0).max(10_000_000).nullish()
  })
  .refine((v) => toDayNumber(v.plannedEndDate)! >= toDayNumber(v.startDate)!, {
    message: 'Planned end date must be on or after the start date',
    path: ['plannedEndDate']
  });
export type EnrolmentCreateInput = z.infer<typeof ZEnrolmentCreate>;

export const ZEnrolmentUpdate = z
  .object({
    startDate: isoDate,
    plannedEndDate: isoDate,
    contractedHoursWeek: z.number().min(0.5).max(168).nullable(),
    otjTargetMinutesOverride: z.number().int().min(0).max(10_000_000).nullable()
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type EnrolmentUpdateInput = z.infer<typeof ZEnrolmentUpdate>;

export const ZUnitDatesUpdate = z.object({
  units: z
    .array(
      z
        .object({ unitId: z.uuid(), startDate: isoDate.nullable(), targetDate: isoDate.nullable() })
        .refine((u) => !u.startDate || !u.targetDate || toDayNumber(u.targetDate)! >= toDayNumber(u.startDate)!, {
          message: 'Target date must be on or after the start date',
          path: ['targetDate']
        })
    )
    .min(1)
    .max(2000)
});
export type UnitDatesUpdateInput = z.infer<typeof ZUnitDatesUpdate>;

export const ZUnitDatesSpread = z.object({
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  onlyEmpty: z.boolean().default(false)
});
export type UnitDatesSpreadInput = z.infer<typeof ZUnitDatesSpread>;

export const ZExportQuery = z.object({ unitId: z.uuid().optional() });

// ── Evidence ──

export const APPR_STAFF_EVIDENCE_STATUSES = ['SUBMITTED', 'ACCEPTED'] as const;

export const ZEvidenceIdParam = z.object({ id: z.uuid() });
export const ZCriterionIdParam = z.object({ criterionId: z.uuid() });

export const ZEvidenceFile = z.object({
  key: z.string().min(1).max(600),
  name: trimmed(255),
  size: z.number().int().min(0).optional(),
  type: z.string().max(150).optional()
});
export type EvidenceFileInput = z.infer<typeof ZEvidenceFile>;

const ZEvidenceNoteInput = z.object({
  body: trimmed(APPR_NOTE_MAX),
  kind: z.enum(APPR_NOTE_KINDS).default('GENERAL')
});

const evidenceFields = {
  title: trimmed(APPR_EVIDENCE_TITLE_MAX),
  details: z.string().trim().max(APPR_EVIDENCE_DETAILS_MAX),
  typeKey: trimmed(100),
  minutes: z.number().int().min(0).max(100000),
  includeOtj: z.boolean(),
  criterionIds: z.array(z.uuid()).min(1).max(500),
  files: z.array(ZEvidenceFile).max(20)
};

export const ZEvidenceCreate = z.object({
  ...evidenceFields,
  details: evidenceFields.details.default(''),
  files: evidenceFields.files.default([]),
  includeOtj: evidenceFields.includeOtj.default(false),
  minutes: evidenceFields.minutes.default(0),
  /** Staff only; a learner's evidence is always SUBMITTED. */
  status: z.enum(APPR_STAFF_EVIDENCE_STATUSES).optional(),
  /** The id the files were presigned for. Required when files are attached. */
  evidenceId: z.uuid().optional(),
  /** The task this evidence answers (same learner + programme; checked server-side). */
  taskId: z.uuid().optional(),
  note: ZEvidenceNoteInput.optional()
});
export type EvidenceCreateInput = z.infer<typeof ZEvidenceCreate>;

export const ZEvidenceUpdate = z
  .object({
    title: evidenceFields.title,
    details: evidenceFields.details,
    typeKey: evidenceFields.typeKey,
    minutes: evidenceFields.minutes,
    includeOtj: evidenceFields.includeOtj,
    criterionIds: evidenceFields.criterionIds,
    files: evidenceFields.files,
    /** Link to / unlink from a task. */
    taskId: z.uuid().nullable(),
    note: ZEvidenceNoteInput
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type EvidenceUpdateInput = z.infer<typeof ZEvidenceUpdate>;

export const ZEvidenceReview = z.object({
  decision: z.enum(['ACCEPT', 'REFER']),
  criterionIds: z.array(z.uuid()).max(500).default([]),
  note: ZEvidenceNoteInput.optional()
});
export type EvidenceReviewInput = z.infer<typeof ZEvidenceReview>;

export const ZEvidenceNoteCreate = ZEvidenceNoteInput;
export type EvidenceNoteCreateInput = z.infer<typeof ZEvidenceNoteCreate>;

export const ZEvidenceListQuery = z.object({
  status: z.enum(['SUBMITTED', 'ACCEPTED', 'REFERRED']).optional(),
  typeKey: z.string().trim().max(100).optional()
});

export const ZEvidencePresign = z.object({
  enrolmentId: z.uuid(),
  /** Omit for new evidence (the server issues the id); pass the existing id when adding files to it. */
  evidenceId: z.uuid().optional(),
  files: z
    .array(z.object({ name: trimmed(255), size: z.number().int().min(0).optional(), type: trimmed(150) }))
    .min(1)
    .max(20)
});
export type EvidencePresignInput = z.infer<typeof ZEvidencePresign>;

export const ZEvidenceDownload = z.object({
  evidenceId: z.uuid(),
  keys: z.array(z.string().min(1).max(600)).min(1).max(50)
});

export const ZCriterionEvidenceQuery = z.object({ enrolmentId: z.uuid() });

export const ZToMarkQuery = z.object({
  programmeId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
});
