import * as schema from '@db/schema';

import { and, asc, db, eq, inArray, sql, type DbOrTxClient } from '@db/drizzle';

// Gecko Apprenticeships — programme catalogue + structure (qualifications → units → criteria). No access control here:
// the service resolves the programme in the caller's org first; every nested lookup below is bound to that programme
// through the join chain, so an id from another programme can never be reached.

export async function getApprProgramme(programmeId: string, client: DbOrTxClient = db) {
  const [row] = await client
    .select()
    .from(schema.apprProgramme)
    .where(eq(schema.apprProgramme.id, programmeId))
    .limit(1);
  return row ?? null;
}

/** Org programmes with structure + learner counts in ONE statement (correlated counts, no N+1). */
export async function listApprProgrammesWithCounts(organizationId: string, status: 'ACTIVE' | 'ARCHIVED' | 'ALL') {
  const p = schema.apprProgramme;
  return db
    .select({
      id: p.id,
      title: p.title,
      description: p.description,
      reference: p.reference,
      awardingBody: p.awardingBody,
      level: p.level,
      status: p.status,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      qualificationCount: sql<number>`(select count(*) from appr_qualification q where q.programme_id = ${sql.raw('"appr_programme"."id"')})::int`,
      unitCount: sql<number>`(select count(*) from appr_unit u join appr_qualification q on q.id = u.qualification_id where q.programme_id = ${sql.raw('"appr_programme"."id"')})::int`,
      criterionCount: sql<number>`(select count(*) from appr_criterion c join appr_unit u on u.id = c.unit_id join appr_qualification q on q.id = u.qualification_id where q.programme_id = ${sql.raw('"appr_programme"."id"')})::int`,
      learnerCount: sql<number>`(select count(*) from appr_enrolment e where e.programme_id = ${sql.raw('"appr_programme"."id"')})::int`
    })
    .from(p)
    .where(
      status === 'ALL'
        ? eq(p.organizationId, organizationId)
        : and(eq(p.organizationId, organizationId), eq(p.status, status))
    )
    .orderBy(asc(p.title));
}

/** Create a programme and its first qualification (same title) — call inside a transaction. */
export async function insertApprProgrammeWithQualification(
  tx: DbOrTxClient,
  input: {
    organizationId: string;
    createdBy: string;
    title: string;
    description?: string | null;
    reference?: string | null;
    awardingBody?: string | null;
    level?: string | null;
  }
) {
  const [programme] = await tx
    .insert(schema.apprProgramme)
    .values({
      organizationId: input.organizationId,
      createdBy: input.createdBy,
      title: input.title,
      description: input.description ?? null,
      reference: input.reference ?? null,
      awardingBody: input.awardingBody ?? null,
      level: input.level ?? null
    })
    .returning();
  const [qualification] = await tx
    .insert(schema.apprQualification)
    .values({
      organizationId: input.organizationId,
      programmeId: programme.id,
      title: input.title,
      reference: input.reference ?? null,
      awardingBody: input.awardingBody ?? null,
      level: input.level ?? null,
      sort: 0
    })
    .returning();
  return { programme, qualification };
}

export async function updateApprProgramme(
  programmeId: string,
  patch: Partial<{
    title: string;
    description: string | null;
    reference: string | null;
    awardingBody: string | null;
    level: string | null;
    status: string;
    reviewIntervalWeeks: number;
  }>,
  client: DbOrTxClient = db
) {
  const [row] = await client
    .update(schema.apprProgramme)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(schema.apprProgramme.id, programmeId))
    .returning();
  return row ?? null;
}

export async function listApprQualificationIds(programmeId: string, client: DbOrTxClient = db) {
  const rows = await client
    .select({ id: schema.apprQualification.id })
    .from(schema.apprQualification)
    .where(eq(schema.apprQualification.programmeId, programmeId));
  return rows.map((r) => r.id);
}

/** The whole structure of a programme as flat, display-ordered lists (3 queries; the service nests them in JS). */
export async function getApprProgrammeStructure(programmeId: string, client: DbOrTxClient = db) {
  const [qualifications, units, criteria] = await Promise.all([
    client
      .select()
      .from(schema.apprQualification)
      .where(eq(schema.apprQualification.programmeId, programmeId))
      .orderBy(asc(schema.apprQualification.sort), asc(schema.apprQualification.createdAt)),
    client
      .select({ unit: schema.apprUnit })
      .from(schema.apprUnit)
      .innerJoin(schema.apprQualification, eq(schema.apprQualification.id, schema.apprUnit.qualificationId))
      .where(eq(schema.apprQualification.programmeId, programmeId))
      .orderBy(asc(schema.apprUnit.sort), asc(schema.apprUnit.createdAt)),
    client
      .select({ criterion: schema.apprCriterion })
      .from(schema.apprCriterion)
      .innerJoin(schema.apprUnit, eq(schema.apprUnit.id, schema.apprCriterion.unitId))
      .innerJoin(schema.apprQualification, eq(schema.apprQualification.id, schema.apprUnit.qualificationId))
      .where(eq(schema.apprQualification.programmeId, programmeId))
      .orderBy(asc(schema.apprCriterion.sort), asc(schema.apprCriterion.createdAt))
  ]);
  return { qualifications, units: units.map((r) => r.unit), criteria: criteria.map((r) => r.criterion) };
}

// ── Chain-bound lookups: null when the id does not belong to the programme ──

export async function getApprQualificationInProgramme(
  programmeId: string,
  qualificationId: string,
  client: DbOrTxClient = db
) {
  const [row] = await client
    .select()
    .from(schema.apprQualification)
    .where(and(eq(schema.apprQualification.id, qualificationId), eq(schema.apprQualification.programmeId, programmeId)))
    .limit(1);
  return row ?? null;
}

export async function getApprUnitInProgramme(
  programmeId: string,
  qualificationId: string,
  unitId: string,
  client: DbOrTxClient = db
) {
  const [row] = await client
    .select({ unit: schema.apprUnit })
    .from(schema.apprUnit)
    .innerJoin(schema.apprQualification, eq(schema.apprQualification.id, schema.apprUnit.qualificationId))
    .where(
      and(
        eq(schema.apprUnit.id, unitId),
        eq(schema.apprUnit.qualificationId, qualificationId),
        eq(schema.apprQualification.programmeId, programmeId)
      )
    )
    .limit(1);
  return row?.unit ?? null;
}

export async function getApprCriterionInProgramme(
  programmeId: string,
  qualificationId: string,
  unitId: string,
  criterionId: string,
  client: DbOrTxClient = db
) {
  const [row] = await client
    .select({ criterion: schema.apprCriterion })
    .from(schema.apprCriterion)
    .innerJoin(schema.apprUnit, eq(schema.apprUnit.id, schema.apprCriterion.unitId))
    .innerJoin(schema.apprQualification, eq(schema.apprQualification.id, schema.apprUnit.qualificationId))
    .where(
      and(
        eq(schema.apprCriterion.id, criterionId),
        eq(schema.apprCriterion.unitId, unitId),
        eq(schema.apprUnit.qualificationId, qualificationId),
        eq(schema.apprQualification.programmeId, programmeId)
      )
    )
    .limit(1);
  return row?.criterion ?? null;
}

// ── Inserts / updates / deletes ──

export async function insertApprQualification(
  tx: DbOrTxClient,
  input: {
    organizationId: string;
    programmeId: string;
    title: string;
    reference?: string | null;
    awardingBody?: string | null;
    level?: string | null;
  }
) {
  const [{ next }] = await tx
    .select({ next: sql<number>`coalesce(max(${schema.apprQualification.sort}), -1) + 1` })
    .from(schema.apprQualification)
    .where(eq(schema.apprQualification.programmeId, input.programmeId));
  const [row] = await tx
    .insert(schema.apprQualification)
    .values({
      ...input,
      reference: input.reference ?? null,
      awardingBody: input.awardingBody ?? null,
      level: input.level ?? null,
      sort: Number(next)
    })
    .returning();
  return row;
}

export async function updateApprQualification(
  qualificationId: string,
  patch: Partial<{ title: string; reference: string | null; awardingBody: string | null; level: string | null }>,
  client: DbOrTxClient = db
) {
  const [row] = await client
    .update(schema.apprQualification)
    .set(patch)
    .where(eq(schema.apprQualification.id, qualificationId))
    .returning();
  return row ?? null;
}

export async function deleteApprQualification(qualificationId: string, client: DbOrTxClient = db) {
  await client.delete(schema.apprQualification).where(eq(schema.apprQualification.id, qualificationId));
}

export async function insertApprUnit(
  tx: DbOrTxClient,
  input: { qualificationId: string; code?: string | null; title: string; glh?: number | null }
) {
  const [{ next }] = await tx
    .select({ next: sql<number>`coalesce(max(${schema.apprUnit.sort}), -1) + 1` })
    .from(schema.apprUnit)
    .where(eq(schema.apprUnit.qualificationId, input.qualificationId));
  const [row] = await tx
    .insert(schema.apprUnit)
    .values({
      qualificationId: input.qualificationId,
      code: input.code ?? null,
      title: input.title,
      glh: input.glh ?? null,
      sort: Number(next)
    })
    .returning();
  return row;
}

export async function updateApprUnit(
  unitId: string,
  patch: Partial<{ code: string | null; title: string; glh: number | null; externalRef: string | null }>,
  client: DbOrTxClient = db
) {
  const [row] = await client.update(schema.apprUnit).set(patch).where(eq(schema.apprUnit.id, unitId)).returning();
  return row ?? null;
}

export async function deleteApprUnit(unitId: string, client: DbOrTxClient = db) {
  await client.delete(schema.apprUnit).where(eq(schema.apprUnit.id, unitId));
}

export async function insertApprCriterion(
  tx: DbOrTxClient,
  input: { unitId: string; code: string; text: string; groupLabel?: string | null; requiredCount: number }
) {
  const [{ next }] = await tx
    .select({ next: sql<number>`coalesce(max(${schema.apprCriterion.sort}), -1) + 1` })
    .from(schema.apprCriterion)
    .where(eq(schema.apprCriterion.unitId, input.unitId));
  const [row] = await tx
    .insert(schema.apprCriterion)
    .values({ ...input, groupLabel: input.groupLabel ?? null, sort: Number(next) })
    .returning();
  return row;
}

export async function updateApprCriterion(
  criterionId: string,
  patch: Partial<{
    code: string;
    text: string;
    groupLabel: string | null;
    requiredCount: number;
    externalRef: string | null;
  }>,
  client: DbOrTxClient = db
) {
  const [row] = await client
    .update(schema.apprCriterion)
    .set(patch)
    .where(eq(schema.apprCriterion.id, criterionId))
    .returning();
  return row ?? null;
}

export async function deleteApprCriterion(criterionId: string, client: DbOrTxClient = db) {
  await client.delete(schema.apprCriterion).where(eq(schema.apprCriterion.id, criterionId));
}

/** Criterion ids under a qualification / unit (to count the evidence mappings a delete would cascade away). */
export async function listCriterionIdsForQualification(
  qualificationId: string,
  client: DbOrTxClient = db
): Promise<string[]> {
  const rows = await client
    .select({ id: schema.apprCriterion.id })
    .from(schema.apprCriterion)
    .innerJoin(schema.apprUnit, eq(schema.apprUnit.id, schema.apprCriterion.unitId))
    .where(eq(schema.apprUnit.qualificationId, qualificationId));
  return rows.map((r) => r.id);
}

export async function listCriterionIdsForUnit(unitId: string, client: DbOrTxClient = db): Promise<string[]> {
  const rows = await client
    .select({ id: schema.apprCriterion.id })
    .from(schema.apprCriterion)
    .where(eq(schema.apprCriterion.unitId, unitId));
  return rows.map((r) => r.id);
}

export async function countEvidenceMappingsForCriteria(
  criterionIds: string[],
  client: DbOrTxClient = db
): Promise<number> {
  if (criterionIds.length === 0) return 0;
  const [row] = await client
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.apprEvidenceCriterion)
    .where(inArray(schema.apprEvidenceCriterion.criterionId, criterionIds));
  return row?.n ?? 0;
}

/** Every enrolment of a programme — recomputed after any structure change that alters progress. */
export async function listEnrolmentIdsForProgramme(programmeId: string, client: DbOrTxClient = db): Promise<string[]> {
  const rows = await client
    .select({ id: schema.apprEnrolment.id })
    .from(schema.apprEnrolment)
    .where(eq(schema.apprEnrolment.programmeId, programmeId));
  return rows.map((r) => r.id);
}

// ── Reorder: ids that belong to a parent, and the sort write ──

export async function listChildIds(
  kind: 'qualification' | 'unit' | 'criterion',
  parentId: string,
  client: DbOrTxClient = db
): Promise<string[]> {
  if (kind === 'qualification') {
    const rows = await client
      .select({ id: schema.apprQualification.id })
      .from(schema.apprQualification)
      .where(eq(schema.apprQualification.programmeId, parentId));
    return rows.map((r) => r.id);
  }
  if (kind === 'unit') {
    const rows = await client
      .select({ id: schema.apprUnit.id })
      .from(schema.apprUnit)
      .where(eq(schema.apprUnit.qualificationId, parentId));
    return rows.map((r) => r.id);
  }
  const rows = await client
    .select({ id: schema.apprCriterion.id })
    .from(schema.apprCriterion)
    .where(eq(schema.apprCriterion.unitId, parentId));
  return rows.map((r) => r.id);
}

export async function writeSortOrder(
  kind: 'qualification' | 'unit' | 'criterion',
  items: { id: string; order: number }[],
  client: DbOrTxClient = db
) {
  const table =
    kind === 'qualification' ? schema.apprQualification : kind === 'unit' ? schema.apprUnit : schema.apprCriterion;
  for (const item of items) {
    await client.update(table).set({ sort: item.order }).where(eq(table.id, item.id));
  }
}

// ── CSV import support: chunked so a 5,000-row import never builds one giant statement ──

const CHUNK = 500;

export async function insertApprUnits(tx: DbOrTxClient, rows: (typeof schema.apprUnit.$inferInsert)[]) {
  for (let i = 0; i < rows.length; i += CHUNK) await tx.insert(schema.apprUnit).values(rows.slice(i, i + CHUNK));
}

export async function insertApprCriteria(tx: DbOrTxClient, rows: (typeof schema.apprCriterion.$inferInsert)[]) {
  for (let i = 0; i < rows.length; i += CHUNK) await tx.insert(schema.apprCriterion).values(rows.slice(i, i + CHUNK));
}
