import * as z from 'zod';
import {
  APPR_RESOURCE_DESCRIPTION_MAX,
  APPR_RESOURCE_KINDS,
  APPR_RESOURCE_STATUSES,
  APPR_RESOURCE_TITLE_MAX
} from '../../constants/apprenticeship';

/**
 * Validators for apprenticeship resources (learning resources + workbooks). Org/programme ownership, file type per
 * kind (apprResourceMimeForFile) and key ownership (appr_upload) are checked in the services.
 */

const title = z.string().trim().min(1).max(APPR_RESOURCE_TITLE_MAX);
const description = z.string().trim().max(APPR_RESOURCE_DESCRIPTION_MAX);

export const ZResourceIdParam = z.object({ id: z.uuid() });
export const ZProgrammeResourceParam = z.object({ id: z.uuid() });

/** File descriptor registered on a resource after presigned upload; the key must match the presign for this programme. */
export const ZResourceFile = z.object({
  key: z.string().trim().min(1).max(1024),
  name: z.string().trim().min(1).max(255),
  size: z.number().int().min(0),
  type: z.string().trim().min(1).max(150)
});
export type ResourceFileInput = z.infer<typeof ZResourceFile>;

export const ZResourceCreate = z.object({
  /** The id the file was presigned for (key = apprenticeship/resources/{programmeId}/{resourceId}/…). */
  resourceId: z.uuid().optional(),
  /** null / omitted = programme-wide ("General"). */
  unitId: z.uuid().nullable().optional(),
  kind: z.enum(APPR_RESOURCE_KINDS),
  title,
  description: description.default(''),
  file: ZResourceFile,
  evidenceTypeKey: z.string().trim().min(1).max(100).nullable().optional(),
  /** Suggested (non-binding) criteria, pre-ticked on the evidence form. */
  criterionIds: z.array(z.uuid()).max(500).default([])
});
export type ResourceCreateInput = z.infer<typeof ZResourceCreate>;

export const ZResourceUpdate = z
  .object({
    unitId: z.uuid().nullable(),
    kind: z.enum(APPR_RESOURCE_KINDS),
    title,
    description,
    /** Replacing the file bumps version. */
    file: ZResourceFile,
    evidenceTypeKey: z.string().trim().min(1).max(100).nullable(),
    criterionIds: z.array(z.uuid()).max(500)
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type ResourceUpdateInput = z.infer<typeof ZResourceUpdate>;

/** Reorder: ids in the new order within one programme (and optionally one unit scope; unitId null = General). */
export const ZResourceReorder = z.object({
  programmeId: z.uuid(),
  unitId: z.uuid().nullable().optional(),
  ids: z.array(z.uuid()).min(1).max(500)
});
export type ResourceReorderInput = z.infer<typeof ZResourceReorder>;

export const ZResourceSuggestedCriteria = z.object({ criterionIds: z.array(z.uuid()).max(500) });
export type ResourceSuggestedCriteriaInput = z.infer<typeof ZResourceSuggestedCriteria>;

export const ZResourcePresign = z.object({
  programmeId: z.uuid(),
  kind: z.enum(APPR_RESOURCE_KINDS),
  /** Omit for a new resource (the server issues the id); pass the existing id when replacing its file. */
  resourceId: z.uuid().optional(),
  files: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(255),
        size: z.number().int().min(0).optional(),
        type: z.string().trim().min(1).max(150)
      })
    )
    .min(1)
    .max(20)
});
export type ResourcePresignInput = z.infer<typeof ZResourcePresign>;

export const ZResourceListQuery = z.object({
  programmeId: z.uuid().optional(),
  unitId: z.uuid().optional(),
  kind: z.enum(APPR_RESOURCE_KINDS).optional(),
  /** Staff only; learners always get ACTIVE. */
  status: z.enum(APPR_RESOURCE_STATUSES).optional(),
  search: z.string().trim().max(100).optional()
});
export type ResourceListQueryInput = z.infer<typeof ZResourceListQuery>;
