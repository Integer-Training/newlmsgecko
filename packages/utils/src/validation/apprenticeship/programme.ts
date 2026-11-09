import * as z from 'zod';

/**
 * Validators for the Gecko Apprenticeships admin API (programme catalogue, structure, CSV import, org settings).
 * Statuses mirror @cio/utils/constants/apprenticeship; ownership (org / programme chain) is checked server-side.
 */
export const APPR_PROGRAMME_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;

/** Max CSV import size: 5,000 data rows or 2 MB, whichever comes first. */
export const APPR_IMPORT_MAX_ROWS = 5000;
export const APPR_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

const trimmed = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullish();

export const ZProgrammeListQuery = z.object({
  status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).default('ACTIVE')
});

export const ZProgrammeCreate = z.object({
  title: trimmed(200),
  description: optionalText(5000),
  reference: optionalText(100),
  awardingBody: optionalText(200),
  level: optionalText(50)
});
export type ProgrammeCreateInput = z.infer<typeof ZProgrammeCreate>;

export const ZProgrammeUpdate = z
  .object({
    title: trimmed(200),
    description: optionalText(5000),
    reference: optionalText(100),
    awardingBody: optionalText(200),
    level: optionalText(50),
    status: z.enum(APPR_PROGRAMME_STATUSES),
    reviewIntervalWeeks: z.number().int().min(1).max(52)
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type ProgrammeUpdateInput = z.infer<typeof ZProgrammeUpdate>;

export const ZQualificationCreate = z.object({
  title: trimmed(200),
  reference: optionalText(100),
  awardingBody: optionalText(200),
  level: optionalText(50)
});
export const ZQualificationUpdate = ZQualificationCreate.partial().refine((v) => Object.keys(v).length > 0, {
  message: 'Nothing to update'
});

export const ZUnitCreate = z.object({
  code: optionalText(100),
  title: trimmed(300),
  glh: z.number().int().min(0).max(2000).nullish()
});
export const ZUnitUpdate = ZUnitCreate.partial().refine((v) => Object.keys(v).length > 0, {
  message: 'Nothing to update'
});

export const ZCriterionCreate = z.object({
  code: trimmed(100),
  text: trimmed(5000),
  groupLabel: optionalText(200),
  requiredCount: z.number().int().min(1).max(50).default(1)
});
export const ZCriterionUpdate = ZCriterionCreate.partial().refine((v) => Object.keys(v).length > 0, {
  message: 'Nothing to update'
});

export const ZProgrammeIdParam = z.object({ id: z.uuid() });
export const ZQualificationParam = z.object({ id: z.uuid(), qid: z.uuid() });
export const ZUnitParam = z.object({ id: z.uuid(), qid: z.uuid(), uid: z.uuid() });
export const ZCriterionParam = z.object({ id: z.uuid(), qid: z.uuid(), uid: z.uuid(), cid: z.uuid() });

/** parentId = programme id (qualification), qualification id (unit) or unit id (criterion). */
export const ZReorder = z.object({
  kind: z.enum(['qualification', 'unit', 'criterion']),
  parentId: z.uuid(),
  orderedIds: z.array(z.uuid()).min(1).max(2000)
});
export type ReorderInput = z.infer<typeof ZReorder>;

export const ZImportBody = z.object({
  csv: z.string().min(1),
  mode: z.enum(['preview', 'apply'])
});
export type ImportBody = z.infer<typeof ZImportBody>;

export const ZApprSettingsUpdate = z.object({
  concernGapPct: z.number().int().min(0).max(100),
  otjFactor: z.number().min(0).max(1),
  otjWeeklyCapHours: z.number().min(1).max(60)
});
export type ApprSettingsUpdateInput = z.infer<typeof ZApprSettingsUpdate>;

export const ZEvidenceTypeCreate = z.object({ label: trimmed(100) });
export const ZEvidenceTypeUpdate = z
  .object({
    label: trimmed(100),
    active: z.boolean(),
    sort: z.number().int().min(0).max(10000)
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export const ZEvidenceTypeParam = z.object({ id: z.uuid() });
