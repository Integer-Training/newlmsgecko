import * as z from 'zod';
import { APPR_OTJ_LOG_TITLE_MAX } from '../../constants/apprenticeship';

// Apprenticeship Standard — off-the-job training log. "Not in the future" and ownership are enforced in the service.

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const title = z.string().trim().min(1).max(APPR_OTJ_LOG_TITLE_MAX);
const minutes = z.number().int().min(1).max(100000);

export const ZOtjLogParam = z.object({ id: z.uuid(), logId: z.uuid() });

export const ZOtjLogCreate = z.object({
  title,
  details: z.string().trim().max(4000).optional(),
  logDate: isoDate,
  minutes,
  isOtj: z.boolean().default(true),
  status: z.enum(['SUBMITTED', 'VALIDATED']).optional()
});

export const ZOtjLogUpdate = z.object({
  title: title.optional(),
  details: z.string().trim().max(4000).optional(),
  logDate: isoDate.optional(),
  minutes: minutes.optional(),
  isOtj: z.boolean().optional()
});

export const ZOtjLogReview = z
  .object({
    decision: z.enum(['VALIDATE', 'REJECT', 'REOPEN']),
    note: z.string().trim().max(2000).optional(),
    expectedStatus: z.enum(['SUBMITTED', 'VALIDATED', 'REJECTED'])
  })
  .refine((v) => v.decision !== 'REJECT' || (v.note && v.note.length > 0), {
    message: 'A note is required when rejecting',
    path: ['note']
  });

export const ZOtjListQuery = z.object({
  status: z.enum(['SUBMITTED', 'VALIDATED', 'REJECTED']).optional()
});
