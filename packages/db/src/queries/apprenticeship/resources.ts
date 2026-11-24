import * as schema from '@db/schema';

import { and, asc, db, desc, eq, inArray, isNull, sql, type DbOrTxClient } from '@db/drizzle';

// Gecko Apprenticeships — resources (learning resources + workbooks). No access control here: services resolve the
// actor, the learner's (paired) programmes and the enrolment status first, then call these. Every read/write that
// takes an organizationId is org-scoped.

export type ApprResourceRow = typeof schema.apprResource.$inferSelect;
export type ApprResourceInsert = typeof schema.apprResource.$inferInsert;
export type ApprResourceFile = ApprResourceRow['file'];
export type ApprResourceActivityRow = typeof schema.apprResourceActivity.$inferSelect;

const res = schema.apprResource;
const act = schema.apprResourceActivity;

export interface ApprResourceListItem extends ApprResourceRow {
  unitTitle: string | null;
  unitCode: string | null;
  programmeTitle: string;
  /** Suggested criterion ids (empty when none). */
  criterionIds: string[];
}

export interface ListResourcesOptions {
  organizationId: string;
  programmeIds: string[];
  /** Omit = ACTIVE + ARCHIVED (staff); learners pass 'ACTIVE'. */
  status?: 'ACTIVE' | 'ARCHIVED';
  kind?: 'LEARNING' | 'WORKBOOK';
  /** undefined = any; null = programme-wide (General) only; uuid = that unit only. */
  unitId?: string | null;
  search?: string;
}

function likePattern(search: string) {
  return '%' + search.replace(/[%_\\]/g, '\\$&') + '%';
}

/** Resources of the given programmes with unit/programme labels + suggested criteria, ordered programme → General first → unit order → sort. */
export async function listResourcesForProgrammes(
  opts: ListResourcesOptions,
  client: DbOrTxClient = db
): Promise<ApprResourceListItem[]> {
  if (opts.programmeIds.length === 0) return [];
  const search = opts.search?.trim();
  const rows = await client
    .select({
      r: res,
      unitTitle: schema.apprUnit.title,
      unitCode: schema.apprUnit.code,
      programmeTitle: schema.apprProgramme.title
    })
    .from(res)
    .innerJoin(schema.apprProgramme, eq(schema.apprProgramme.id, res.programmeId))
    .leftJoin(schema.apprUnit, eq(schema.apprUnit.id, res.unitId))
    .where(
      and(
        eq(res.organizationId, opts.organizationId),
        inArray(res.programmeId, opts.programmeIds),
        opts.status ? eq(res.status, opts.status) : undefined,
        opts.kind ? eq(res.kind, opts.kind) : undefined,
        opts.unitId === undefined ? undefined : opts.unitId === null ? isNull(res.unitId) : eq(res.unitId, opts.unitId),
        search
          ? sql`(${res.title} ilike ${likePattern(search)} or ${res.description} ilike ${likePattern(search)})`
          : undefined
      )
    )
    .orderBy(
      asc(schema.apprProgramme.title),
      sql`${res.unitId} is not null`,
      asc(schema.apprUnit.sort),
      asc(res.sort),
      asc(res.createdAt)
    );
  const criteria = await listSuggestedCriteriaMap(
    rows.map((x) => x.r.id),
    client
  );
  return rows.map((x) => ({
    ...x.r,
    unitTitle: x.unitTitle,
    unitCode: x.unitCode,
    programmeTitle: x.programmeTitle,
    criterionIds: criteria.get(x.r.id) ?? []
  }));
}

/** Suggested criterion ids per resource. */
export async function listSuggestedCriteriaMap(
  resourceIds: string[],
  client: DbOrTxClient = db
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (resourceIds.length === 0) return out;
  const rows = await client
    .select({
      resourceId: schema.apprResourceCriterion.resourceId,
      criterionId: schema.apprResourceCriterion.criterionId
    })
    .from(schema.apprResourceCriterion)
    .where(inArray(schema.apprResourceCriterion.resourceId, resourceIds));
  for (const r of rows) {
    const list = out.get(r.resourceId) ?? [];
    list.push(r.criterionId);
    out.set(r.resourceId, list);
  }
  return out;
}

/** One resource by id, org-scoped (null when missing or in another org), with suggested criteria + labels. */
export async function getResource(
  resourceId: string,
  organizationId: string,
  client: DbOrTxClient = db
): Promise<ApprResourceListItem | null> {
  const [row] = await client
    .select({
      r: res,
      unitTitle: schema.apprUnit.title,
      unitCode: schema.apprUnit.code,
      programmeTitle: schema.apprProgramme.title
    })
    .from(res)
    .innerJoin(schema.apprProgramme, eq(schema.apprProgramme.id, res.programmeId))
    .leftJoin(schema.apprUnit, eq(schema.apprUnit.id, res.unitId))
    .where(and(eq(res.id, resourceId), eq(res.organizationId, organizationId)))
    .limit(1);
  if (!row) return null;
  const criteria = await listSuggestedCriteriaMap([resourceId], client);
  return {
    ...row.r,
    unitTitle: row.unitTitle,
    unitCode: row.unitCode,
    programmeTitle: row.programmeTitle,
    criterionIds: criteria.get(resourceId) ?? []
  };
}

/** Next sort value in a scope (programme + unit, null unit = General). */
export async function nextResourceSort(
  programmeId: string,
  unitId: string | null,
  client: DbOrTxClient = db
): Promise<number> {
  const [row] = await client
    .select({ max: sql<number>`coalesce(max(${res.sort}), -1)::int` })
    .from(res)
    .where(and(eq(res.programmeId, programmeId), unitId ? eq(res.unitId, unitId) : isNull(res.unitId)));
  return Number(row?.max ?? -1) + 1;
}

/** Insert a resource (pass `id` to use the id the file was presigned for). */
export async function insertResource(values: ApprResourceInsert, client: DbOrTxClient = db): Promise<ApprResourceRow> {
  const [row] = await client.insert(res).values(values).returning();
  return row;
}

export type ApprResourcePatch = Partial<
  Pick<
    ApprResourceRow,
    'unitId' | 'kind' | 'title' | 'description' | 'file' | 'version' | 'evidenceTypeKey' | 'status' | 'sort'
  >
>;

/** Patch a resource (org-scoped); bumps updated_at. Returns null when not found. */
export async function updateResource(
  resourceId: string,
  organizationId: string,
  patch: ApprResourcePatch,
  client: DbOrTxClient = db
): Promise<ApprResourceRow | null> {
  const [row] = await client
    .update(res)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(and(eq(res.id, resourceId), eq(res.organizationId, organizationId)))
    .returning();
  return row ?? null;
}

/** Replace the file and bump the version (learners then see an "Updated" badge). */
export async function replaceResourceFile(
  resourceId: string,
  organizationId: string,
  file: ApprResourceFile,
  client: DbOrTxClient = db
): Promise<ApprResourceRow | null> {
  const [row] = await client
    .update(res)
    .set({ file, version: sql`${res.version} + 1`, updatedAt: new Date().toISOString() })
    .where(and(eq(res.id, resourceId), eq(res.organizationId, organizationId)))
    .returning();
  return row ?? null;
}

export function archiveResource(resourceId: string, organizationId: string, client: DbOrTxClient = db) {
  return updateResource(resourceId, organizationId, { status: 'ARCHIVED' }, client);
}

export function restoreResource(resourceId: string, organizationId: string, client: DbOrTxClient = db) {
  return updateResource(resourceId, organizationId, { status: 'ACTIVE' }, client);
}

/** Hard delete (org-scoped). Services only allow this when countEvidenceForResource() is 0. Returns the deleted row. */
export async function deleteResource(
  resourceId: string,
  organizationId: string,
  client: DbOrTxClient = db
): Promise<ApprResourceRow | null> {
  const [row] = await client
    .delete(res)
    .where(and(eq(res.id, resourceId), eq(res.organizationId, organizationId)))
    .returning();
  return row ?? null;
}

/** Write the order of the given ids (index = sort), scoped to one programme + org. */
export async function reorderResources(
  programmeId: string,
  organizationId: string,
  ids: string[],
  client: DbOrTxClient = db
) {
  for (let i = 0; i < ids.length; i++) {
    await client
      .update(res)
      .set({ sort: i })
      .where(and(eq(res.id, ids[i]), eq(res.programmeId, programmeId), eq(res.organizationId, organizationId)));
  }
}

/** Replace a resource's suggested criteria with exactly this set (callers validate the criteria belong to the programme). */
export async function setSuggestedCriteria(resourceId: string, criterionIds: string[], client: DbOrTxClient = db) {
  const unique = [...new Set(criterionIds)];
  await client.delete(schema.apprResourceCriterion).where(eq(schema.apprResourceCriterion.resourceId, resourceId));
  if (unique.length > 0) {
    await client
      .insert(schema.apprResourceCriterion)
      .values(unique.map((criterionId) => ({ resourceId, criterionId })));
  }
}

/** How many evidence rows reference a resource (delete is only allowed at 0; otherwise archive). */
export async function countEvidenceForResource(resourceId: string, client: DbOrTxClient = db): Promise<number> {
  const [row] = await client
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.apprEvidence)
    .where(eq(schema.apprEvidence.resourceId, resourceId));
  return Number(row?.n ?? 0);
}

/** ACTIVE resource counts for a programme's setup badges: key = unitId, or 'general' for programme-wide. */
export async function countResourcesByScope(
  programmeId: string,
  organizationId: string,
  client: DbOrTxClient = db
): Promise<Record<string, number>> {
  const rows = await client
    .select({ unitId: res.unitId, n: sql<number>`count(*)::int` })
    .from(res)
    .where(and(eq(res.programmeId, programmeId), eq(res.organizationId, organizationId), eq(res.status, 'ACTIVE')))
    .groupBy(res.unitId);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.unitId ?? 'general'] = Number(r.n);
  return out;
}

// ── Activity ──

/**
 * Record a first view or a download for an enrolment (upsert). 'view' sets first_viewed_at once; 'download' also
 * bumps download_count / last_downloaded_at. last_version is set to the resource's current version.
 */
export async function recordResourceActivity(
  input: { resourceId: string; enrolmentId: string; learnerId: string; type: 'view' | 'download'; version: number },
  client: DbOrTxClient = db
): Promise<ApprResourceActivityRow> {
  const now = new Date().toISOString();
  const isDownload = input.type === 'download';
  const [row] = await client
    .insert(act)
    .values({
      resourceId: input.resourceId,
      enrolmentId: input.enrolmentId,
      learnerId: input.learnerId,
      firstViewedAt: now,
      firstDownloadedAt: isDownload ? now : null,
      lastDownloadedAt: isDownload ? now : null,
      downloadCount: isDownload ? 1 : 0,
      lastVersion: input.version
    })
    .onConflictDoUpdate({
      target: [act.resourceId, act.enrolmentId],
      set: {
        firstViewedAt: sql`coalesce(${act.firstViewedAt}, ${now})`,
        ...(isDownload
          ? {
              // Only a download moves last_version, so viewing never clears the "Updated since you downloaded" badge.
              lastVersion: input.version,
              firstDownloadedAt: sql`coalesce(${act.firstDownloadedAt}, ${now})`,
              lastDownloadedAt: now,
              downloadCount: sql`${act.downloadCount} + 1`
            }
          : {})
      }
    })
    .returning();
  return row;
}

/** Activity rows for one enrolment (all resources) — drives "Updated" badges and Downloaded status. */
export async function listResourceActivityForEnrolment(
  enrolmentId: string,
  client: DbOrTxClient = db
): Promise<ApprResourceActivityRow[]> {
  return client.select().from(act).where(eq(act.enrolmentId, enrolmentId));
}

/** Activity rows for a learner across all their enrolments (a paired learner has two); optional resource filter. */
export async function listResourceActivityForLearner(
  learnerId: string,
  resourceIds?: string[],
  client: DbOrTxClient = db
): Promise<ApprResourceActivityRow[]> {
  return client
    .select()
    .from(act)
    .where(
      and(
        eq(act.learnerId, learnerId),
        resourceIds && resourceIds.length > 0 ? inArray(act.resourceId, resourceIds) : undefined
      )
    )
    .orderBy(desc(act.lastDownloadedAt));
}

/**
 * The latest evidence status per resource for a learner (most recent evidence by created_at that references the
 * resource). Map key = resourceId, value = ApprEvidenceStatus ('SUBMITTED' | 'ACCEPTED' | 'REFERRED').
 */
export async function latestEvidenceStatusByResource(
  learnerId: string,
  resourceIds?: string[],
  client: DbOrTxClient = db
): Promise<Map<string, string>> {
  const ev = schema.apprEvidence;
  const rows = await client
    .selectDistinctOn([ev.resourceId], { resourceId: ev.resourceId, status: ev.status })
    .from(ev)
    .where(
      and(
        eq(ev.learnerId, learnerId),
        sql`${ev.resourceId} is not null`,
        resourceIds && resourceIds.length > 0 ? inArray(ev.resourceId, resourceIds) : undefined
      )
    )
    .orderBy(ev.resourceId, desc(ev.createdAt));
  const out = new Map<string, string>();
  for (const r of rows) if (r.resourceId) out.set(r.resourceId, r.status);
  return out;
}

/** Like latestEvidenceStatusByResource but also returns the evidence id (for "open my submission"). */
export async function latestEvidenceByResource(
  learnerId: string,
  resourceIds?: string[],
  client: DbOrTxClient = db
): Promise<Map<string, { id: string; status: string }>> {
  const ev = schema.apprEvidence;
  const rows = await client
    .selectDistinctOn([ev.resourceId], { resourceId: ev.resourceId, id: ev.id, status: ev.status })
    .from(ev)
    .where(
      and(
        eq(ev.learnerId, learnerId),
        sql`${ev.resourceId} is not null`,
        resourceIds && resourceIds.length > 0 ? inArray(ev.resourceId, resourceIds) : undefined
      )
    )
    .orderBy(ev.resourceId, desc(ev.createdAt));
  const out = new Map<string, { id: string; status: string }>();
  for (const r of rows) if (r.resourceId) out.set(r.resourceId, { id: r.id, status: r.status });
  return out;
}
