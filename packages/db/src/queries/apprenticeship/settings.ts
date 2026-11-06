import * as schema from '@db/schema';

import { and, db, eq, sql, type DbOrTxClient } from '@db/drizzle';

// Gecko Apprenticeships — org settings + evidence-type writes (the reads live in progress.ts: getApprSettings,
// listApprEvidenceTypes). Org-scoped by the caller's resolved actor.

export async function upsertApprSettings(
  organizationId: string,
  input: { concernGapPct: number; otjFactor: number; otjWeeklyCapHours: number },
  client: DbOrTxClient = db
) {
  await client
    .insert(schema.apprSettings)
    .values({ organizationId, ...input })
    .onConflictDoUpdate({
      target: schema.apprSettings.organizationId,
      set: { ...input, updatedAt: new Date().toISOString() }
    });
}

export async function insertApprEvidenceType(
  organizationId: string,
  key: string,
  label: string,
  client: DbOrTxClient = db
) {
  const [{ next }] = await client
    .select({ next: sql<number>`coalesce(max(${schema.apprEvidenceType.sort}), -1) + 1` })
    .from(schema.apprEvidenceType)
    .where(eq(schema.apprEvidenceType.organizationId, organizationId));
  const [row] = await client
    .insert(schema.apprEvidenceType)
    .values({ organizationId, key, label, sort: Number(next) })
    .returning();
  return row;
}

/** Update a type that belongs to the org; null when the id is not in this org. */
export async function updateApprEvidenceType(
  organizationId: string,
  id: string,
  patch: Partial<{ label: string; active: boolean; sort: number }>,
  client: DbOrTxClient = db
) {
  const [row] = await client
    .update(schema.apprEvidenceType)
    .set(patch)
    .where(and(eq(schema.apprEvidenceType.id, id), eq(schema.apprEvidenceType.organizationId, organizationId)))
    .returning();
  return row ?? null;
}
