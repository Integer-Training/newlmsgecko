import * as schema from '@db/schema';

import { and, asc, db, eq, ilike, inArray, or, sql, type DbOrTxClient, type SQL } from '@db/drizzle';
import { profileDisplayName } from './names';

// Gecko Apprenticeships — enrolment reads/writes. No access control here: services resolve the actor first and pass
// the scope (organization / allocated tutor / self) in. Ids only; nothing here touches diploma tables.

export interface ApprTutorRef {
  id: string;
  name: string;
}

// Allocated tutors of the enrolment's learner as a JSON array — a correlated subquery, so a list stays ONE statement.
const tutorsOf = sql<
  ApprTutorRef[]
>`coalesce((select json_agg(json_build_object('id', tp.id, 'name', coalesce(nullif(tu.name, ''), tp.fullname)) order by coalesce(nullif(tu.name, ''), tp.fullname))
  from tutor_allocation ta join profile tp on tp.id = ta.tutor_id left join "user" tu on tu.id = tp.id
  where ta.learner_id = ${sql.raw('"appr_enrolment"."learner_id"')} and ta.organization_id = ${sql.raw('"appr_enrolment"."organization_id"')}), '[]'::json)`;

export interface EnrolmentListScope {
  organizationId: string;
  programmeId?: string;
  /** Admin filter: only learners allocated to this tutor. */
  tutorId?: string;
  search?: string;
  /** TUTOR actor: only learners allocated to this tutor (the access rule). */
  restrictToTutorId?: string;
  /** LEARNER actor: only this learner. */
  restrictToLearnerId?: string;
  /** 'YYYY-MM-DD' used for the overdue-task count (default: today, UTC). */
  today?: string;
}

export interface ApprNextReviewRef {
  id: string;
  scheduledDate: string;
  status: string;
}

// Round 2 list/portfolio columns, as correlated subqueries (every column qualified — an unqualified one inside a
// subquery would silently match the subquery's own table): overdue task count and the earliest open review.
const overdueTaskCountOf = (today: string) =>
  sql<number>`(select count(*) from appr_task ot where ot.enrolment_id = ${sql.raw('"appr_enrolment"."id"')} and ot.due_date < ${today}::date and ot.status <> 'COMPLETE')::int`;
const nextReviewOf = sql<ApprNextReviewRef | null>`(select json_build_object('id', nr.id, 'scheduledDate', nr.scheduled_date, 'status', nr.status)
  from appr_review nr where nr.enrolment_id = ${sql.raw('"appr_enrolment"."id"')} and nr.status in ('SCHEDULED', 'DRAFT', 'AWAITING_SIGNATURES')
  order by nr.scheduled_date asc, nr.created_at asc limit 1)`;

/** The learners table: every matching enrolment of the org with learner, programme, tutors and cache columns. ONE statement. */
export async function listEnrolmentRows(scope: EnrolmentListScope, client: DbOrTxClient = db) {
  const e = schema.apprEnrolment;
  const conditions: (SQL | undefined)[] = [eq(e.organizationId, scope.organizationId)];
  if (scope.programmeId) conditions.push(eq(e.programmeId, scope.programmeId));
  if (scope.tutorId) {
    conditions.push(
      sql`exists (select 1 from tutor_allocation ta where ta.learner_id = ${sql.raw('"appr_enrolment"."learner_id"')} and ta.tutor_id = ${scope.tutorId})`
    );
  }
  if (scope.restrictToTutorId) {
    conditions.push(
      sql`exists (select 1 from tutor_allocation ta where ta.learner_id = ${sql.raw('"appr_enrolment"."learner_id"')} and ta.tutor_id = ${scope.restrictToTutorId})`
    );
  }
  if (scope.restrictToLearnerId) conditions.push(eq(e.learnerId, scope.restrictToLearnerId));
  if (scope.search) {
    const term = `%${scope.search.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(or(ilike(profileDisplayName, term), ilike(schema.profile.email, term)));
  }
  return client
    .select({
      id: e.id,
      programmeId: e.programmeId,
      programmeTitle: schema.apprProgramme.title,
      learnerId: e.learnerId,
      learnerName: profileDisplayName,
      learnerEmail: schema.profile.email,
      startDate: e.startDate,
      plannedEndDate: e.plannedEndDate,
      contractedHoursWeek: e.contractedHoursWeek,
      otjTargetMinutesOverride: e.otjTargetMinutesOverride,
      achievedAt: e.achievedAt,
      actualPct: e.actualPct,
      otjMinutes: e.otjMinutes,
      submittedCount: e.submittedCount,
      acceptedCount: e.acceptedCount,
      referredCount: e.referredCount,
      tutors: tutorsOf,
      overdueTaskCount: overdueTaskCountOf(scope.today ?? new Date().toISOString().slice(0, 10)),
      nextReview: nextReviewOf
    })
    .from(e)
    .innerJoin(schema.profile, eq(schema.profile.id, e.learnerId))
    .innerJoin(schema.apprProgramme, eq(schema.apprProgramme.id, e.programmeId))
    .where(and(...conditions))
    .orderBy(asc(profileDisplayName));
}

/** Enrolment + learner + programme + allocated tutors, for the portfolio header. One statement. */
export async function getEnrolmentOverview(
  enrolmentId: string,
  client: DbOrTxClient = db,
  today: string = new Date().toISOString().slice(0, 10)
) {
  const e = schema.apprEnrolment;
  const [row] = await client
    .select({
      enrolment: e,
      learnerName: profileDisplayName,
      learnerEmail: schema.profile.email,
      programmeTitle: schema.apprProgramme.title,
      programmeReference: schema.apprProgramme.reference,
      programmeLevel: schema.apprProgramme.level,
      tutors: tutorsOf,
      overdueTaskCount: overdueTaskCountOf(today),
      nextReview: nextReviewOf
    })
    .from(e)
    .innerJoin(schema.profile, eq(schema.profile.id, e.learnerId))
    .innerJoin(schema.apprProgramme, eq(schema.apprProgramme.id, e.programmeId))
    .where(eq(e.id, enrolmentId))
    .limit(1);
  return row ?? null;
}

export async function getLearnerProfileRef(learnerId: string, client: DbOrTxClient = db) {
  const [row] = await client
    .select({ id: schema.profile.id, name: profileDisplayName, email: schema.profile.email })
    .from(schema.profile)
    .where(eq(schema.profile.id, learnerId))
    .limit(1);
  return row ?? null;
}

export async function insertApprEnrolment(tx: DbOrTxClient, values: typeof schema.apprEnrolment.$inferInsert) {
  const [row] = await tx.insert(schema.apprEnrolment).values(values).returning();
  return row;
}

/** One enrolment-unit row per unit (dates empty until the tutor sets them or spreads). */
export async function insertEnrolmentUnits(tx: DbOrTxClient, enrolmentId: string, unitIds: string[]) {
  if (unitIds.length === 0) return;
  await tx
    .insert(schema.apprEnrolmentUnit)
    .values(unitIds.map((unitId) => ({ enrolmentId, unitId })))
    .onConflictDoNothing();
}

export async function updateApprEnrolment(
  enrolmentId: string,
  patch: Partial<{
    startDate: string;
    plannedEndDate: string;
    contractedHoursWeek: number | null;
    otjTargetMinutesOverride: number | null;
  }>,
  client: DbOrTxClient = db
) {
  await client.update(schema.apprEnrolment).set(patch).where(eq(schema.apprEnrolment.id, enrolmentId));
}

/** Set tutor dates for units of one enrolment (upsert: a unit added to the programme later has no row yet). */
export async function upsertEnrolmentUnitDates(
  tx: DbOrTxClient,
  enrolmentId: string,
  rows: { unitId: string; startDate: string | null; targetDate: string | null }[]
) {
  if (rows.length === 0) return;
  await tx
    .insert(schema.apprEnrolmentUnit)
    .values(rows.map((r) => ({ enrolmentId, ...r })))
    .onConflictDoUpdate({
      target: [schema.apprEnrolmentUnit.enrolmentId, schema.apprEnrolmentUnit.unitId],
      set: { startDate: sql`excluded.start_date`, targetDate: sql`excluded.target_date` }
    });
}

/** Per-criterion evidence counts for one learner on one programme, REFERRED excluded (they are not "in play"). */
export async function countEvidenceByCriterion(programmeId: string, learnerId: string, client: DbOrTxClient = db) {
  const ev = schema.apprEvidence;
  const rows = await client
    .select({
      criterionId: schema.apprEvidenceCriterion.criterionId,
      accepted: sql<number>`count(*) filter (where ${ev.status} = 'ACCEPTED')::int`,
      submitted: sql<number>`count(*) filter (where ${ev.status} = 'SUBMITTED')::int`
    })
    .from(schema.apprEvidenceCriterion)
    .innerJoin(ev, eq(ev.id, schema.apprEvidenceCriterion.evidenceId))
    .where(
      and(eq(ev.programmeId, programmeId), eq(ev.learnerId, learnerId), inArray(ev.status, ['ACCEPTED', 'SUBMITTED']))
    )
    .groupBy(schema.apprEvidenceCriterion.criterionId);
  return new Map(rows.map((r) => [r.criterionId, { accepted: r.accepted, submitted: r.submitted }]));
}

/** Titles of ACCEPTED evidence per criterion (CSV export). */
export async function listAcceptedEvidenceTitles(programmeId: string, learnerId: string, client: DbOrTxClient = db) {
  const ev = schema.apprEvidence;
  const rows = await client
    .select({ criterionId: schema.apprEvidenceCriterion.criterionId, title: ev.title })
    .from(schema.apprEvidenceCriterion)
    .innerJoin(ev, eq(ev.id, schema.apprEvidenceCriterion.evidenceId))
    .where(and(eq(ev.programmeId, programmeId), eq(ev.learnerId, learnerId), eq(ev.status, 'ACCEPTED')))
    .orderBy(asc(ev.createdAt));
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.criterionId, [...(map.get(r.criterionId) ?? []), r.title]);
  return map;
}

/**
 * Add-learner pickers: the org's tutors (role 2) and learners (role 3) with their FULL name (user.name, falling back to
 * the profile handle) + email, in one statement. Ordered by role then name. No KPI payload.
 */
export async function listApprPickerPeople(organizationId: string, client: DbOrTxClient = db) {
  const rows = await client
    .selectDistinct({
      id: schema.profile.id,
      name: profileDisplayName,
      email: schema.profile.email,
      roleId: schema.organizationmember.roleId
    })
    .from(schema.organizationmember)
    .innerJoin(schema.profile, eq(schema.profile.id, schema.organizationmember.profileId))
    .where(
      and(
        eq(schema.organizationmember.organizationId, organizationId),
        inArray(schema.organizationmember.roleId, [2, 3])
      )
    );
  const byName = (a: { name: string | null }, b: { name: string | null }) => (a.name ?? '').localeCompare(b.name ?? '');
  const toOption = (r: (typeof rows)[number]) => ({ id: r.id, name: r.name, email: r.email });
  return {
    tutors: rows
      .filter((r) => Number(r.roleId) === 2)
      .sort(byName)
      .map(toOption),
    learners: rows
      .filter((r) => Number(r.roleId) === 3)
      .sort(byName)
      .map(toOption)
  };
}
