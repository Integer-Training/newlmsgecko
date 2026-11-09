import * as z from 'zod';
import {
  APPR_EPA_RESULTS,
  APPR_GATEWAY_ITEMS_MAX,
  APPR_GATEWAY_ITEM_KINDS,
  APPR_GLH_LOG_MAX_MINUTES
} from '../../constants/apprenticeship';
import { toDayNumber } from '../../functions/apprenticeship-progress';

/** Validators for the Gecko Apprenticeships GLH log, gateway checklist and EPA API. State rules live in the services. */

const isoDate = z.string().refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && toDayNumber(v) !== null, {
  message: 'Use a valid date (YYYY-MM-DD)'
});

// ── GLH logs ──

export const ZGlhLogIdParam = z.object({ id: z.uuid(), logId: z.uuid() });
export const ZGlhLogCreate = z.object({
  minutes: z.number().int().min(1).max(APPR_GLH_LOG_MAX_MINUTES),
  logDate: isoDate,
  note: z.string().trim().max(500).nullish()
});
export type GlhLogCreateInput = z.infer<typeof ZGlhLogCreate>;

// ── Gateway checklist (programme setup) ──

export const ZGatewayChecklistItem = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'Use a short lowercase key (letters, numbers, - or _)'),
  label: z.string().trim().min(1).max(120),
  kind: z.enum(APPR_GATEWAY_ITEM_KINDS)
});
export type GatewayChecklistItemInput = z.infer<typeof ZGatewayChecklistItem>;

/** `checklist: null` resets the programme to the default checklist. */
export const ZGatewayChecklistPut = z
  .object({ checklist: z.array(ZGatewayChecklistItem).min(1).max(APPR_GATEWAY_ITEMS_MAX).nullable() })
  .superRefine((v, ctx) => {
    if (!v.checklist) return;
    const keys = new Set<string>();
    for (const [i, item] of v.checklist.entries()) {
      if (keys.has(item.key))
        ctx.addIssue({ code: 'custom', message: 'Keys must be unique', path: ['checklist', i, 'key'] });
      keys.add(item.key);
    }
    for (const kind of ['AUTO_UNITS', 'AUTO_OTJ'] as const) {
      if (v.checklist.filter((i) => i.kind === kind).length > 1) {
        ctx.addIssue({ code: 'custom', message: `${kind} can be used at most once`, path: ['checklist'] });
      }
    }
  });
export type GatewayChecklistPutInput = z.infer<typeof ZGatewayChecklistPut>;

// ── Gateway ticks + EPA ──

export const ZGatewayItemParam = z.object({ id: z.uuid(), key: z.string().min(1).max(40) });
export const ZGatewayTick = z.object({ done: z.boolean(), note: z.string().trim().max(500).nullish() });
export type GatewayTickInput = z.infer<typeof ZGatewayTick>;

export const ZEpaUpdate = z
  .object({
    epaBookedDate: isoDate.nullable(),
    epaResult: z.enum(APPR_EPA_RESULTS).nullable(),
    epaResultDate: isoDate.nullable()
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type EpaUpdateInput = z.infer<typeof ZEpaUpdate>;
