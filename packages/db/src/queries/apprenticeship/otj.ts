import * as schema from '@db/schema';

import { and, asc, db, desc, eq, inArray, sql, type DbOrTxClient, type SQL } from '@db/drizzle';
import { profileDisplayName } from './names';
import { tutorReachSql } from './tutors';

// Gecko Apprenticeships — the off-the-job training log. No access control here: services resolve the actor and the
// carrier enrolment first. Logs are always stored on the CARRIER enrolment of an apprenticeship.

export type ApprOtjLogRow = typeof schema.apprOtjLog.$inferSelect;
export type ApprOtjLogInsert = typeof schema.apprOtjLog.$inferInsert;

const log = schema.apprOtjLog;

/** Total minutes of VALIDATED off-the-job log entries (is_otj = true) for an enrolment. */
export async function sumValidatedOtjLogMinutes(enrolmentId: string, client: DbOrTxClient = db): Promise<number> {
  const [row] = await client
    .select({ total: sql<number>`coalesce(sum(${log.minutes}), 0)::int` })
    .from(log)
    .where(and(eq(log.enrolmentId, enrolmentId), eq(log.status, 'VALIDATED'), eq(log.isOtj, true)));
  return Number(row?.total ?? 0);
}

/** Minutes of SUBMITTED (waiting for validation) off-the-job log entries for an enrolment. */
export async function sumPendingOtjLogMinutes(enrolmentId: string, client: DbOrTxClient = db): Promise<number> {
  const [row] = await client
    .select({ total: sql<number>`coalesce(sum(${log.minutes}), 0)::int` })
    .from(log)
    .where(and(eq(log.enrolmentId, enrolmentId), eq(log.status, 'SUBMITTED'), eq(log.isOtj, true)));
  return Number(row?.total ?? 0);
}

/** An enrolment's log rows (newest log date first) with the creator's display name; optional status filter. */
export async function listOtjLogs(enrolmentId: string, status?: string, client: DbOrTxClient = db) {
  return client
    .select({ log, byName: profileDisplayName })
    .from(log)
    .leftJoin(schema.profile, eq(schema.profile.id, log.createdBy))
    .where(and(eq(log.enrolmentId, enrolmentId), status ? eq(log.status, status) : undefined))
    .orderBy(desc(log.logDate), desc(log.createdAt))
    .then((rows) => rows.map((r) => ({ ...r.log, byName: r.byName as string | null })));
}

export async function getOtjLog(logId: string, client: DbOrTxClient = db): Promise<ApprOtjLogRow | null> {
  const [row] = await client.select().from(log).where(eq(log.id, logId));
  return row ?? null;
}

/** Row-locked read, for review / edit / delete inside their transaction. */
export async function lockOtjLog(tx: DbOrTxClient, logId: string): Promise<ApprOtjLogRow | null> {
  const [row] = await tx.select().from(log).where(eq(log.id, logId)).for('update');
  return row ?? null;
}

export async function insertOtjLog(tx: DbOrTxClient, values: ApprOtjLogInsert): Promise<ApprOtjLogRow> {
  const [row] = await tx.insert(log).values(values).returning();
  return row;
}

export async function updateOtjLog(
  tx: DbOrTxClient,
  logId: string,
  patch: Partial<
    Pick<
      ApprOtjLogRow,
      'title' | 'details' | 'logDate' | 'minutes' | 'isOtj' | 'status' | 'reviewNote' | 'reviewedBy' | 'reviewedAt'
    >
  >
): Promise<ApprOtjLogRow | null> {
  const [row] = await tx
    .update(log)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(log.id, logId))
    .returning();
  return row ?? null;
}

/**
 * Re-home every log of one enrolment onto another (linking a pair: the component's logs move to the carrier, where all
 * of an apprenticeship's logs live). Returns how many rows moved.
 */
export async function moveOtjLogs(tx: DbOrTxClient, fromEnrolmentId: string, toEnrolmentId: string): Promise<number> {
  const rows = await tx
    .update(log)
    .set({ enrolmentId: toEnrolmentId })
    .where(eq(log.enrolmentId, fromEnrolmentId))
    .returning({ id: log.id });
  return rows.length;
}

export async function deleteOtjLog(tx: DbOrTxClient, logId: string): Promise<void> {
  await tx.delete(log).where(eq(log.id, logId));
}

/** Log counts per status for an enrolment (all three keys always present). */
export async function countOtjLogsByStatus(enrolmentId: string, client: DbOrTxClient = db) {
  const rows = await client
    .select({ status: log.status, count: sql<number>`count(*)::int` })
    .from(log)
    .where(eq(log.enrolmentId, enrolmentId))
    .groupBy(log.status);
  const out = { SUBMITTED: 0, VALIDATED: 0, REJECTED: 0 };
  for (const r of rows) if (r.status in out) out[r.status as keyof typeof out] = r.count;
  return out;
}

/** OTJ-flagged evidence of a learner on the given programmes (an apprenticeship's one or two), for the merged log. */
export async function listOtjEvidenceRows(programmeIds: string[], learnerId: string, client: DbOrTxClient = db) {
  if (programmeIds.length === 0) return [];
  const ev = schema.apprEvidence;
  return client
    .select({
      id: ev.id,
      title: ev.title,
      details: ev.details,
      minutes: ev.minutes,
      status: ev.status,
      programmeId: ev.programmeId,
      reviewedAt: ev.reviewedAt,
      createdAt: ev.createdAt,
      byName: profileDisplayName
    })
    .from(ev)
    .leftJoin(schema.profile, eq(schema.profile.id, ev.createdBy))
    .where(and(inArray(ev.programmeId, programmeIds), eq(ev.learnerId, learnerId), eq(ev.includeOtj, true)))
    .orderBy(asc(ev.createdAt));
}

/** evidenceId → distinct titles of the programmes its mapped criteria belong to (for "names both qualifications"). */
export async function getEvidenceProgrammeTitles(evidenceIds: string[], client: DbOrTxClient = db) {
  const out = new Map<string, string[]>();
  if (evidenceIds.length === 0) return out;
  const rows = await client
    .selectDistinct({ evidenceId: schema.apprEvidenceCriterion.evidenceId, title: schema.apprProgramme.title })
    .from(schema.apprEvidenceCriterion)
    .innerJoin(schema.apprCriterion, eq(schema.apprCriterion.id, schema.apprEvidenceCriterion.criterionId))
    .innerJoin(schema.apprUnit, eq(schema.apprUnit.id, schema.apprCriterion.unitId))
    .innerJoin(schema.apprQualification, eq(schema.apprQualification.id, schema.apprUnit.qualificationId))
    .innerJoin(schema.apprProgramme, eq(schema.apprProgramme.id, schema.apprQualification.programmeId))
    .where(inArray(schema.apprEvidenceCriterion.evidenceId, evidenceIds))
    .orderBy(asc(schema.apprProgramme.title));
  for (const r of rows) out.set(r.evidenceId, [...(out.get(r.evidenceId) ?? []), r.title]);
  return out;
}

export const OTJ_QUEUE_CAP = 500;

/**
 * Cross-learner queue of log entries in a status (oldest first, capped). Admin = whole org; with `restrictToTutorId` only
 * learners that tutor reaches (named, programme tutor, or the linked half of a pair — judged on the carrier's programme).
 */
export async function listOtjLogQueue(
  scope: { organizationId: string; status: string; restrictToTutorId?: string },
  client: DbOrTxClient = db
) {
  const conditions: (SQL | undefined)[] = [eq(log.organizationId, scope.organizationId), eq(log.status, scope.status)];
  if (scope.restrictToTutorId) {
    conditions.push(
      tutorReachSql('"appr_otj_log"."learner_id"', '"appr_enrolment"."programme_id"', scope.restrictToTutorId)
    );
  }
  const rows = await client
    .select({
      id: log.id,
      enrolmentId: log.enrolmentId,
      learnerId: log.learnerId,
      learnerName: sql<
        string | null
      >`coalesce(nullif((select u.name from "user" u where u.id = ${log.learnerId}), ''), (select p.fullname from profile p where p.id = ${log.learnerId}))`,
      programmeTitle: schema.apprProgramme.title,
      title: log.title,
      minutes: log.minutes,
      isOtj: log.isOtj,
      logDate: log.logDate,
      status: log.status,
      createdAt: log.createdAt,
      byName: sql<
        string | null
      >`coalesce(nullif((select u.name from "user" u where u.id = ${log.createdBy}), ''), (select p.fullname from profile p where p.id = ${log.createdBy}))`
    })
    .from(log)
    .innerJoin(schema.apprEnrolment, eq(schema.apprEnrolment.id, log.enrolmentId))
    .innerJoin(schema.apprProgramme, eq(schema.apprProgramme.id, schema.apprEnrolment.programmeId))
    .where(and(...conditions))
    .orderBy(asc(log.createdAt), asc(log.id))
    .limit(OTJ_QUEUE_CAP);
  return rows;
}
