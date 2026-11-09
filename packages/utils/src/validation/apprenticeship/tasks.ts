import * as z from 'zod';
import {
  APPR_EVIDENCE_DETAILS_MAX,
  APPR_TASK_MONTH_OFFSET_MAX,
  APPR_TASK_PLAN_STATUSES,
  APPR_TASK_TITLE_MAX
} from '../../constants/apprenticeship';
import { toDayNumber } from '../../functions/apprenticeship-progress';
import { ZEvidenceFile } from './enrolment';

/**
 * Validators for the Gecko Apprenticeships task plans + tasks API. Ownership (org / programme chain / file-key prefix)
 * is checked server-side in the services; these only check shape and ranges.
 */

const trimmed = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.string().refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && toDayNumber(v) !== null, {
  message: 'Use a valid date (YYYY-MM-DD)'
});
const files = z.array(ZEvidenceFile).max(20);
const presignFiles = z
  .array(z.object({ name: trimmed(255), size: z.number().int().min(0).optional(), type: trimmed(150) }))
  .min(1)
  .max(20);

const windowRefine = (v: { validFrom?: string | null; validTo?: string | null }) =>
  !v.validFrom || !v.validTo || toDayNumber(v.validTo)! >= toDayNumber(v.validFrom)!;
const windowMessage = { message: 'Valid to must be on or after valid from', path: ['validTo'] };

// ── Task plans ──

export const ZTaskPlanIdParam = z.object({ id: z.uuid() });
export const ZTaskPlanItemParam = z.object({ id: z.uuid(), itemId: z.uuid() });

export const ZTaskPlanListQuery = z.object({
  programmeId: z.uuid().optional(),
  status: z.enum(APPR_TASK_PLAN_STATUSES).optional()
});

export const ZTaskPlanCreate = z
  .object({
    /** The id the brief files were presigned for. Required when files are attached. */
    id: z.uuid().optional(),
    programmeId: z.uuid(),
    title: trimmed(APPR_TASK_TITLE_MAX),
    validFrom: isoDate.nullish(),
    validTo: isoDate.nullish(),
    files: files.default([])
  })
  .refine(windowRefine, windowMessage);
export type TaskPlanCreateInput = z.infer<typeof ZTaskPlanCreate>;

export const ZTaskPlanUpdate = z
  .object({
    title: trimmed(APPR_TASK_TITLE_MAX),
    validFrom: isoDate.nullable(),
    validTo: isoDate.nullable(),
    files
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
  .refine(windowRefine, windowMessage);
export type TaskPlanUpdateInput = z.infer<typeof ZTaskPlanUpdate>;

export const ZTaskPlanPresign = z.object({
  /** Omit for a new plan (the server issues the id); pass the existing id when adding files to a plan. */
  planId: z.uuid().optional(),
  files: presignFiles
});
export type TaskPlanPresignInput = z.infer<typeof ZTaskPlanPresign>;

const itemFields = {
  title: trimmed(APPR_TASK_TITLE_MAX),
  details: z.string().trim().max(APPR_EVIDENCE_DETAILS_MAX),
  typeKey: trimmed(100),
  sequence: z.number().int().min(0).max(100000),
  monthOffset: z.number().int().min(0).max(APPR_TASK_MONTH_OFFSET_MAX),
  expectedMinutes: z.number().int().min(0).max(100000),
  files,
  criterionIds: z.array(z.uuid()).max(500)
};

export const ZTaskPlanItemCreate = z.object({
  ...itemFields,
  details: itemFields.details.default(''),
  sequence: itemFields.sequence.optional(),
  monthOffset: itemFields.monthOffset.default(0),
  expectedMinutes: itemFields.expectedMinutes.default(0),
  files: itemFields.files.default([]),
  criterionIds: itemFields.criterionIds.default([])
});
export type TaskPlanItemCreateInput = z.infer<typeof ZTaskPlanItemCreate>;

export const ZTaskPlanItemUpdate = z
  .object(itemFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type TaskPlanItemUpdateInput = z.infer<typeof ZTaskPlanItemUpdate>;

export const ZTaskPlanReorder = z.object({ orderedIds: z.array(z.uuid()).min(1).max(500) });

export const ZTaskPlanAssign = z.object({ enrolmentIds: z.array(z.uuid()).min(1).max(500) });
export type TaskPlanAssignInput = z.infer<typeof ZTaskPlanAssign>;

// ── Tasks ──

export const ZTaskIdParam = z.object({ id: z.uuid() });

export const ZTaskCreate = z.object({
  /** The id the brief files were presigned for. Required when files are attached. */
  id: z.uuid().optional(),
  title: trimmed(APPR_TASK_TITLE_MAX),
  details: itemFields.details.default(''),
  typeKey: itemFields.typeKey,
  dueDate: isoDate.nullish(),
  expectedMinutes: itemFields.expectedMinutes.default(0),
  files: files.default([]),
  criterionIds: itemFields.criterionIds.default([])
});
export type TaskCreateInput = z.infer<typeof ZTaskCreate>;

export const ZTaskUpdate = z
  .object({
    title: itemFields.title,
    details: itemFields.details,
    typeKey: itemFields.typeKey,
    dueDate: isoDate.nullable(),
    expectedMinutes: itemFields.expectedMinutes,
    files,
    criterionIds: itemFields.criterionIds
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type TaskUpdateInput = z.infer<typeof ZTaskUpdate>;

export const ZTaskPresign = z.object({
  enrolmentId: z.uuid(),
  /** Omit for a new task (the server issues the id); pass the existing id when adding files to a task. */
  taskId: z.uuid().optional(),
  files: presignFiles
});
export type TaskPresignInput = z.infer<typeof ZTaskPresign>;

export const ZTaskDownload = z
  .object({
    taskId: z.uuid().optional(),
    planId: z.uuid().optional(),
    keys: z.array(z.string().min(1).max(600)).min(1).max(50)
  })
  .refine((v) => Boolean(v.taskId) !== Boolean(v.planId), { message: 'Provide exactly one of taskId or planId' });
export type TaskDownloadInput = z.infer<typeof ZTaskDownload>;

export const ZTaskOverdueQuery = z.object({
  programmeId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
});
