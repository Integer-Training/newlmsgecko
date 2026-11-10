import * as schema from '@db/schema';

import { and, asc, db, eq, inArray, isNull, or, sql, type DbOrTxClient } from '@db/drizzle';

// Gecko Apprenticeships — onboarding documents. A type applies to an enrolment when it is in the same org and either
// has no programme or the enrolment's programme. "Complete" = every ACTIVE REQUIRED applicable type has an APPROVED
// doc (computed on read, never stored). No access control here: services pass the scope in.

const t = schema.apprOnboardingDocType;
const d = schema.apprOnboardingDoc;

export type ApprOnboardingDocTypeRow = typeof t.$inferSelect;
export type ApprOnboardingDocRow = typeof d.$inferSelect;

export interface ApprOnboardingCounts {
  required: number;
  approved: number;
  submitted: number;
  rejected: number;
}

/**
 * Onboarding counts for the enrolment row of an outer query, as one JSON value (correlated subquery, so a list stays
 * ONE statement). Pass fully-qualified raw column names of the outer enrolment table.
 */
export function onboardingCountsSql(
  enrolmentIdCol = '"appr_enrolment"."id"',
  orgCol = '"appr_enrolment"."organization_id"',
  programmeCol = '"appr_enrolment"."programme_id"'
) {
  const applies = sql.raw(
    `odt.organization_id = ${orgCol} and odt.active and odt.required and (odt.programme_id is null or odt.programme_id = ${programmeCol})`
  );
  return sql<ApprOnboardingCounts>`(select json_build_object(
      'required', count(*),
      'approved', count(*) filter (where od.status = 'APPROVED'),
      'submitted', count(*) filter (where od.status = 'SUBMITTED'),
      'rejected', count(*) filter (where od.status = 'REJECTED'))
    from appr_onboarding_doc_type odt
    left join appr_onboarding_doc od on od.doc_type_id = odt.id and od.enrolment_id = ${sql.raw(enrolmentIdCol)}
    where ${applies})`;
}

/** SQL condition "this enrolment's onboarding is incomplete" (for list filters). Same outer-column rule as above. */
export function onboardingIncompleteSql(
  enrolmentIdCol = '"appr_enrolment"."id"',
  orgCol = '"appr_enrolment"."organization_id"',
  programmeCol = '"appr_enrolment"."programme_id"'
) {
  return sql`exists (select 1 from appr_onboarding_doc_type odt
    where odt.organization_id = ${sql.raw(orgCol)} and odt.active and odt.required
      and (odt.programme_id is null or odt.programme_id = ${sql.raw(programmeCol)})
      and not exists (select 1 from appr_onboarding_doc od
        where od.doc_type_id = odt.id and od.enrolment_id = ${sql.raw(enrolmentIdCol)} and od.status = 'APPROVED'))`;
}

export function isOnboardingComplete(c: ApprOnboardingCounts | null | undefined) {
  return !c || Number(c.approved) >= Number(c.required);
}

/** All types of the org (admin settings), ordered. */
export async function listOnboardingTypes(organizationId: string, client: DbOrTxClient = db) {
  return client.select().from(t).where(eq(t.organizationId, organizationId)).orderBy(asc(t.sequence), asc(t.createdAt));
}

export async function countOnboardingTypes(organizationId: string, client: DbOrTxClient = db) {
  const [row] = await client
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .where(eq(t.organizationId, organizationId));
  return row?.n ?? 0;
}

/** Types that apply to a programme (active only unless `includeInactive`). */
export async function listOnboardingTypesForProgramme(
  organizationId: string,
  programmeId: string,
  opts: { includeInactive?: boolean } = {},
  client: DbOrTxClient = db
) {
  return client
    .select()
    .from(t)
    .where(
      and(
        eq(t.organizationId, organizationId),
        or(isNull(t.programmeId), eq(t.programmeId, programmeId)),
        opts.includeInactive ? undefined : eq(t.active, true)
      )
    )
    .orderBy(asc(t.sequence), asc(t.createdAt));
}

export async function getOnboardingType(organizationId: string, typeId: string, client: DbOrTxClient = db) {
  const [row] = await client
    .select()
    .from(t)
    .where(and(eq(t.organizationId, organizationId), eq(t.id, typeId)))
    .limit(1);
  return row ?? null;
}

export async function insertOnboardingTypes(rows: (typeof t.$inferInsert)[], client: DbOrTxClient = db) {
  if (rows.length === 0) return [];
  return client.insert(t).values(rows).returning();
}

export async function updateOnboardingType(
  organizationId: string,
  typeId: string,
  patch: Partial<typeof t.$inferInsert>,
  client: DbOrTxClient = db
) {
  const [row] = await client
    .update(t)
    .set(patch)
    .where(and(eq(t.organizationId, organizationId), eq(t.id, typeId)))
    .returning();
  return row ?? null;
}

export async function deleteOnboardingType(organizationId: string, typeId: string, client: DbOrTxClient = db) {
  await client.delete(t).where(and(eq(t.organizationId, organizationId), eq(t.id, typeId)));
}

export async function isOnboardingTypeInUse(typeId: string, client: DbOrTxClient = db) {
  const [row] = await client.select({ id: d.id }).from(d).where(eq(d.docTypeId, typeId)).limit(1);
  return Boolean(row);
}

/** Set sequence = position for the given ids (all must be in the org; caller validated). */
export async function reorderOnboardingTypes(organizationId: string, typeIds: string[], client: DbOrTxClient = db) {
  for (const [i, id] of typeIds.entries()) {
    await client
      .update(t)
      .set({ sequence: i })
      .where(and(eq(t.organizationId, organizationId), eq(t.id, id)));
  }
}

/** Docs of an enrolment, with reviewer / submitter display names. */
export async function listOnboardingDocs(enrolmentId: string, client: DbOrTxClient = db) {
  return client
    .select({
      doc: d,
      reviewedByName: sql<
        string | null
      >`(select coalesce(nullif(u.name, ''), p.fullname) from profile p left join "user" u on u.id = p.id where p.id = ${d.reviewedBy})`,
      submittedByName: sql<
        string | null
      >`(select coalesce(nullif(u.name, ''), p.fullname) from profile p left join "user" u on u.id = p.id where p.id = ${d.submittedBy})`
    })
    .from(d)
    .where(eq(d.enrolmentId, enrolmentId));
}

export async function getOnboardingDoc(enrolmentId: string, docTypeId: string, client: DbOrTxClient = db) {
  const [row] = await client
    .select()
    .from(d)
    .where(and(eq(d.enrolmentId, enrolmentId), eq(d.docTypeId, docTypeId)))
    .limit(1);
  return row ?? null;
}

/** Insert or replace the slot's upload; always back to SUBMITTED, clearing any previous review. */
export async function upsertOnboardingDoc(
  row: {
    organizationId: string;
    enrolmentId: string;
    learnerId: string;
    docTypeId: string;
    files: ApprOnboardingDocRow['files'];
    notHeld: boolean;
    learnerNote: string | null;
    submittedBy: string | null;
  },
  client: DbOrTxClient = db
) {
  const [saved] = await client
    .insert(d)
    .values({ ...row, status: 'SUBMITTED' })
    .onConflictDoUpdate({
      target: [d.enrolmentId, d.docTypeId],
      set: {
        files: row.files,
        notHeld: row.notHeld,
        learnerNote: row.learnerNote,
        submittedBy: row.submittedBy,
        status: 'SUBMITTED',
        reviewNote: null,
        reviewedBy: null,
        reviewedAt: null,
        submittedAt: sql`now()`,
        updatedAt: sql`now()`
      }
    })
    .returning();
  return saved!;
}

/** Review only if the status is still what the reviewer saw. Returns null on a stale status (caller → 409). */
export async function reviewOnboardingDoc(
  docId: string,
  expectedStatus: string,
  patch: { status: string; reviewNote: string | null; reviewedBy: string },
  client: DbOrTxClient = db
) {
  const [row] = await client
    .update(d)
    .set({ ...patch, reviewedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(d.id, docId), eq(d.status, expectedStatus)))
    .returning();
  return row ?? null;
}

export async function deleteOnboardingDoc(docId: string, client: DbOrTxClient = db) {
  await client.delete(d).where(eq(d.id, docId));
}

/** Every file key held on onboarding docs of these enrolments (to mark removed before an enrolment is deleted). */
export async function listOnboardingFileKeysForEnrolments(enrolmentIds: string[], client: DbOrTxClient = db) {
  if (enrolmentIds.length === 0) return [];
  const rows = await client.select({ files: d.files }).from(d).where(inArray(d.enrolmentId, enrolmentIds));
  return rows.flatMap((r) => r.files.map((f) => f.key));
}

/** Bell enrichment: the doc's slot label, outcome and reason, plus its enrolment (for the deep link). */
export async function getOnboardingDocLinkTargets(docIds: string[], client: DbOrTxClient = db) {
  const out = new Map<string, { enrolmentId: string; label: string; status: string; reviewNote: string | null }>();
  if (docIds.length === 0) return out;
  const rows = await client
    .select({ id: d.id, enrolmentId: d.enrolmentId, label: t.label, status: d.status, reviewNote: d.reviewNote })
    .from(d)
    .innerJoin(t, eq(t.id, d.docTypeId))
    .where(inArray(d.id, docIds));
  for (const r of rows) out.set(r.id, r);
  return out;
}
