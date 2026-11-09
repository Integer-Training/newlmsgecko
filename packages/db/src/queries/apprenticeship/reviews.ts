import * as schema from '@db/schema';

import { and, asc, db, desc, eq, inArray, isNull, lte, ne, sql, type DbOrTxClient } from '@db/drizzle';
import { profileDisplayName } from './names';

// Gecko Apprenticeships — progress reviews. No access control here (services scope the actor first). Updates are
// conditional on the updatedAt / status the caller read, so a concurrent edit or signature is a 409, never a silent
// overwrite.

export type ApprReviewRow = typeof schema.apprReview.$inferSelect;

const r = schema.apprReview;

export async function getApprReview(reviewId: string, client: DbOrTxClient = db) {
  const [row] = await client.select().from(r).where(eq(r.id, reviewId)).limit(1);
  return row ?? null;
}

export async function listReviewsForEnrolment(enrolmentId: string, client: DbOrTxClient = db) {
  return client
    .select()
    .from(r)
    .where(eq(r.enrolmentId, enrolmentId))
    .orderBy(desc(r.scheduledDate), desc(r.createdAt));
}

export async function insertApprReview(tx: DbOrTxClient, values: typeof r.$inferInsert) {
  const [row] = await tx.insert(r).values(values).returning();
  return row;
}

type ReviewPatch = Partial<
  Pick<
    ApprReviewRow,
    | 'scheduledDate'
    | 'heldDate'
    | 'status'
    | 'snapshot'
    | 'progressSummary'
    | 'targets'
    | 'tutorComment'
    | 'learnerComment'
    | 'employerComment'
    | 'tutorSignedName'
    | 'tutorSignedAt'
    | 'tutorSignedBy'
    | 'learnerSignedName'
    | 'learnerSignedAt'
    | 'employerSignedName'
    | 'employerSignedAt'
    | 'employerRecordedBy'
    | 'nextReviewDate'
    | 'dueNotifiedAt'
  >
>;

/**
 * Update a review only if it is still exactly as the caller read it (same updatedAt). Null = someone else changed it
 * first. `requireEmpty` additionally requires that signature to still be empty (two people signing one slot → 409).
 */
export async function updateApprReviewIfUnchanged(
  tx: DbOrTxClient,
  reviewId: string,
  expectedUpdatedAt: string,
  patch: ReviewPatch,
  requireEmpty?: 'tutorSignedAt' | 'learnerSignedAt' | 'employerSignedAt'
) {
  const [row] = await tx
    .update(r)
    .set({ ...patch, updatedAt: sql`now()` as unknown as string })
    .where(
      and(eq(r.id, reviewId), eq(r.updatedAt, expectedUpdatedAt), requireEmpty ? isNull(r[requireEmpty]) : undefined)
    )
    .returning();
  return row ?? null;
}

/** Future/open reviews of an enrolment other than `exceptId` — used to avoid double-scheduling the next review. */
export async function countOpenReviewsFrom(
  tx: DbOrTxClient,
  enrolmentId: string,
  fromDate: string,
  exceptId: string
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(r)
    .where(
      and(
        eq(r.enrolmentId, enrolmentId),
        ne(r.id, exceptId),
        inArray(r.status, ['SCHEDULED', 'DRAFT', 'AWAITING_SIGNATURES']),
        sql`${r.scheduledDate} >= ${fromDate}`
      )
    );
  return row?.n ?? 0;
}

/**
 * Daily review-due scan: claim up to `limit` open reviews due within the notice window (or already overdue) by
 * stamping due_notified_at, and return what was claimed. A second run can never pick the same review.
 */
export async function claimDueReviews(dueOnOrBefore: string, limit: number, client: DbOrTxClient = db) {
  const candidates = await client
    .select({ id: r.id })
    .from(r)
    .where(and(inArray(r.status, ['SCHEDULED', 'DRAFT']), lte(r.scheduledDate, dueOnOrBefore), isNull(r.dueNotifiedAt)))
    .orderBy(asc(r.scheduledDate), asc(r.id))
    .limit(limit);
  if (candidates.length === 0) return [];
  return client
    .update(r)
    .set({ dueNotifiedAt: sql`now()` })
    .where(
      and(
        inArray(
          r.id,
          candidates.map((c) => c.id)
        ),
        inArray(r.status, ['SCHEDULED', 'DRAFT']),
        isNull(r.dueNotifiedAt)
      )
    )
    .returning({ id: r.id, enrolmentId: r.enrolmentId });
}

/** Notification deep links: review id → its enrolment and the learner's display name. */
export async function getReviewLinkTargets(reviewIds: string[], client: DbOrTxClient = db) {
  const out = new Map<string, { enrolmentId: string; learnerName: string | null }>();
  if (reviewIds.length === 0) return out;
  const rows = await client
    .select({ id: r.id, enrolmentId: r.enrolmentId, learnerName: profileDisplayName })
    .from(r)
    .innerJoin(schema.apprEnrolment, eq(schema.apprEnrolment.id, r.enrolmentId))
    .leftJoin(schema.profile, eq(schema.profile.id, schema.apprEnrolment.learnerId))
    .where(inArray(r.id, reviewIds));
  for (const row of rows) out.set(row.id, { enrolmentId: row.enrolmentId, learnerName: row.learnerName });
  return out;
}

/** Learner ids for a set of enrolments (the scans notify the learner / their tutors). */
export async function getEnrolmentLearnerIds(enrolmentIds: string[], client: DbOrTxClient = db) {
  const out = new Map<string, string>();
  if (enrolmentIds.length === 0) return out;
  const rows = await client
    .select({ id: schema.apprEnrolment.id, learnerId: schema.apprEnrolment.learnerId })
    .from(schema.apprEnrolment)
    .where(inArray(schema.apprEnrolment.id, enrolmentIds));
  for (const row of rows) out.set(row.id, row.learnerId);
  return out;
}

/**
 * Create the FIRST review of an enrolment only if it has no review rows at all (one atomic statement, so two racing
 * callers create one). Returns true when a row was inserted.
 */
export async function insertFirstReviewIfNone(
  values: { organizationId: string; enrolmentId: string; scheduledDate: string; createdBy: string | null },
  client: DbOrTxClient = db
): Promise<boolean> {
  const rows = (await client.execute(sql`
    insert into appr_review (organization_id, enrolment_id, scheduled_date, created_by)
    select ${values.organizationId}::uuid, ${values.enrolmentId}::uuid, ${values.scheduledDate}::date, ${values.createdBy}::uuid
    where not exists (select 1 from appr_review x where x.enrolment_id = ${values.enrolmentId}::uuid)
    returning id`)) as unknown as { id: string }[];
  return rows.length > 0;
}

/** Enrolments with a start date, not achieved, and no review at all (the back-fill for pre-reviews enrolments). */
export async function listEnrolmentsNeedingFirstReview(limit: number, client: DbOrTxClient = db) {
  const e = schema.apprEnrolment;
  return client
    .select({
      id: e.id,
      organizationId: e.organizationId,
      startDate: e.startDate,
      reviewIntervalWeeks: schema.apprProgramme.reviewIntervalWeeks
    })
    .from(e)
    .innerJoin(schema.apprProgramme, eq(schema.apprProgramme.id, e.programmeId))
    .where(
      and(
        isNull(e.achievedAt),
        sql`${e.startDate} is not null`,
        sql`not exists (select 1 from appr_review x where x.enrolment_id = ${sql.raw('"appr_enrolment"."id"')})`
      )
    )
    .orderBy(asc(e.createdAt))
    .limit(limit);
}
