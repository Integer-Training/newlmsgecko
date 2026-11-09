import * as schema from '@db/schema';

import { and, asc, db, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql, type DbOrTxClient } from '@db/drizzle';

// Gecko Apprenticeships — upload tracking (appr_upload). One row per presigned key, so keys that never reach a record
// (abandoned forms) or are later dropped from one can be deleted from storage by the daily clean-up job.

export type ApprUploadRow = typeof schema.apprUpload.$inferSelect;

/** Record freshly issued keys. A key that is already tracked is left alone (presign is retry-safe). */
export async function insertApprUploads(
  rows: { organizationId: string; learnerId: string | null; ownerId: string | null; key: string }[],
  client: DbOrTxClient = db
) {
  if (rows.length === 0) return;
  await client.insert(schema.apprUpload).values(rows).onConflictDoNothing({ target: schema.apprUpload.key });
}

/** Keys now saved on a record: attached (and un-removed, if they were dropped and then re-added). */
export async function markUploadsAttached(keys: string[], client: DbOrTxClient = db) {
  if (keys.length === 0) return;
  await client
    .update(schema.apprUpload)
    .set({ attachedAt: sql`coalesce(${schema.apprUpload.attachedAt}, now())`, removedAt: null })
    .where(inArray(schema.apprUpload.key, keys));
}

/** Keys dropped from a record: start their grace period (only tracked, previously attached keys qualify). */
export async function markUploadsRemoved(keys: string[], client: DbOrTxClient = db) {
  if (keys.length === 0) return;
  await client
    .update(schema.apprUpload)
    .set({ removedAt: sql`now()` })
    .where(
      and(
        inArray(schema.apprUpload.key, keys),
        isNotNull(schema.apprUpload.attachedAt),
        isNull(schema.apprUpload.removedAt)
      )
    );
}

/** Which of these keys were issued to this organization (key-injection guard for plan / task brief files). */
export async function filterUploadKeysInOrg(organizationId: string, keys: string[], client: DbOrTxClient = db) {
  if (keys.length === 0) return [];
  const rows = await client
    .select({ key: schema.apprUpload.key })
    .from(schema.apprUpload)
    .where(and(eq(schema.apprUpload.organizationId, organizationId), inArray(schema.apprUpload.key, keys)));
  return rows.map((r) => r.key);
}

/** Rows to clean up: never attached and older than the grace period, or removed longer ago than the grace period. */
export async function listUploadsForCleanup(
  cutoffIso: string,
  limit: number,
  excludeIds: string[] = [],
  client: DbOrTxClient = db
) {
  return client
    .select()
    .from(schema.apprUpload)
    .where(
      and(
        or(
          and(isNull(schema.apprUpload.attachedAt), lt(schema.apprUpload.createdAt, cutoffIso)),
          and(isNotNull(schema.apprUpload.removedAt), lt(schema.apprUpload.removedAt, cutoffIso))
        ),
        excludeIds.length > 0 ? notInArray(schema.apprUpload.id, excludeIds) : undefined
      )
    )
    .orderBy(asc(schema.apprUpload.createdAt), asc(schema.apprUpload.id))
    .limit(limit);
}

export async function deleteUploadRows(ids: string[], client: DbOrTxClient = db) {
  if (ids.length === 0) return 0;
  const rows = await client
    .delete(schema.apprUpload)
    .where(inArray(schema.apprUpload.id, ids))
    .returning({ id: schema.apprUpload.id });
  return rows.length;
}

/**
 * Which of these keys are still listed on a live evidence / task / task plan / plan item. The clean-up job never
 * deletes these, whatever the tracking row says (belt and braces for shared plan files and rows missed by tracking).
 */
export async function listReferencedUploadKeys(keys: string[], client: DbOrTxClient = db): Promise<Set<string>> {
  const out = new Set<string>();
  if (keys.length === 0) return out;
  const list = sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `
  );
  for (const table of ['appr_evidence', 'appr_task', 'appr_task_plan', 'appr_task_plan_item']) {
    const rows = (await client.execute(
      sql`select distinct f->>'key' as key from ${sql.raw(table)} t, jsonb_array_elements(t.files) f where f->>'key' in (${list})`
    )) as unknown as { key: string }[];
    for (const r of rows) out.add(r.key);
  }
  return out;
}
