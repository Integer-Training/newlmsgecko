import * as schema from '@db/schema';

import { and, asc, db, eq, ilike, inArray, isNull, or, sql, type DbOrTxClient, type SQL } from '@db/drizzle';
import { noTutorSql, tutorReachSql, tutorsDisplaySql } from './tutors';
import { onboardingCountsSql, onboardingIncompleteSql } from './onboarding';
import { profileDisplayName } from './names';

// Gecko Apprenticeships — enrolment reads/writes. No access control here: services resolve the actor first and pass
// the scope (organization / allocated tutor / self) in. Ids only; nothing here touches diploma tables.

export interface ApprTutorRef {
  id: string;
  name: string;
  kind?: 'NAMED' | 'PROGRAMME';
}

// Tutors to display for the enrolment (named, else programme) as a JSON array — see tutorsDisplaySql.
const tutorsOf = tutorsDisplaySql(
  '"appr_enrolment"."learner_id"',
  '"appr_enrolment"."programme_id"',
  '"appr_enrolment"."organization_id"'
);

export interface EnrolmentListScope {
  organizationId: string;
  /** Matches the row's own programme OR the programme of the enrolment linked to it (a pair is one row). */
  programmeId?: string;
  /** Programme type (DIPLOMA / STANDARD): matches the row's own programme OR its linked one. */
  type?: 'DIPLOMA' | 'STANDARD';
  /** Admin filter: only learners whose NAMED tutor (allocation) is this tutor. */
  tutorId?: string;
  search?: string;
  /** Admin/tutor filter: learners with neither a named tutor nor a programme tutor. */
  noTutor?: boolean;
  /** Filter: learners whose required onboarding documents are not all approved yet. */
  onboardingIncomplete?: boolean;
  /** TUTOR actor: only enrolments this tutor reaches — named tutor OR programme tutor (the access rule). */
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
// GLH target (minutes) of the enrolment's programme = sum of unit GLH; null when no unit has GLH.
const glhTargetOf = sql<
  number | null
>`(select sum(gu.glh) * 60 from appr_unit gu join appr_qualification gq on gq.id = gu.qualification_id where gq.programme_id = ${sql.raw('"appr_enrolment"."programme_id"')} and gu.glh > 0)::int`;
// Units of the learner and how many are complete (from the progress cache) — feeds the gateway AUTO_UNITS item.
const unitsTotalOf = sql<number>`(select count(*) from appr_enrolment_unit eu where eu.enrolment_id = ${sql.raw('"appr_enrolment"."id"')})::int`;
const unitsCompleteOf = sql<number>`(select count(*) from appr_enrolment_unit ec where ec.enrolment_id = ${sql.raw('"appr_enrolment"."id"')} and ec.completed_at is not null)::int`;

const nextReviewOf = sql<ApprNextReviewRef | null>`(select json_build_object('id', nr.id, 'scheduledDate', nr.scheduled_date, 'status', nr.status)
  from appr_review nr where nr.enrolment_id = ${sql.raw('"appr_enrolment"."id"')} and nr.status in ('SCHEDULED', 'DRAFT', 'AWAITING_SIGNATURES')
  order by nr.scheduled_date asc, nr.created_at asc limit 1)`;

/** The component of a linked pair, as raw columns (the service derives expected % / status). One JSON object or null. */
export interface ApprLinkedRowRef {
  id: string;
  programmeId: string;
  programmeTitle: string;
  programmeType: 'DIPLOMA' | 'STANDARD';
  startDate: string | null;
  plannedEndDate: string | null;
  actualPct: number | null;
  achievedAt: string | null;
}
const linkedOf = sql<ApprLinkedRowRef | null>`(select json_build_object('id', lc.id, 'programmeId', lc.programme_id, 'programmeTitle', lp.title,
  'programmeType', lp.type, 'startDate', lc.start_date, 'plannedEndDate', lc.planned_end_date, 'actualPct', lc.actual_pct,
  'achievedAt', lc.achieved_at)
  from appr_enrolment lc join appr_programme lp on lp.id = lc.programme_id
  where lc.primary_enrolment_id = ${sql.raw('"appr_enrolment"."id"')} limit 1)`;

/**
 * The learners table: one row per APPRENTICESHIP — a linked pair is folded into its carrier (components are not rows;
 * the carrier row gains `linked`). Every matching enrolment of the org with learner, programme, tutors and cache columns. ONE statement. */
export async function listEnrolmentRows(scope: EnrolmentListScope, client: DbOrTxClient = db) {
  const e = schema.apprEnrolment;
  const conditions: (SQL | undefined)[] = [eq(e.organizationId, scope.organizationId), isNull(e.primaryEnrolmentId)];
  const ownId = sql.raw('"appr_enrolment"."id"');
  if (scope.programmeId) {
    conditions.push(
      or(
        eq(e.programmeId, scope.programmeId),
        sql`exists (select 1 from appr_enrolment lc where lc.primary_enrolment_id = ${ownId} and lc.programme_id = ${scope.programmeId})`
      )
    );
  }
  if (scope.type) {
    conditions.push(
      or(
        eq(schema.apprProgramme.type, scope.type),
        sql`exists (select 1 from appr_enrolment lc join appr_programme lp on lp.id = lc.programme_id where lc.primary_enrolment_id = ${ownId} and lp.type = ${scope.type})`
      )
    );
  }
  if (scope.tutorId) {
    conditions.push(
      sql`exists (select 1 from tutor_allocation ta where ta.learner_id = ${sql.raw('"appr_enrolment"."learner_id"')} and ta.tutor_id = ${scope.tutorId})`
    );
  }
  if (scope.restrictToTutorId) {
    conditions.push(
      tutorReachSql('"appr_enrolment"."learner_id"', '"appr_enrolment"."programme_id"', scope.restrictToTutorId)
    );
  }
  if (scope.restrictToLearnerId) conditions.push(eq(e.learnerId, scope.restrictToLearnerId));
  if (scope.noTutor) {
    conditions.push(
      noTutorSql(
        '"appr_enrolment"."learner_id"',
        '"appr_enrolment"."programme_id"',
        '"appr_enrolment"."organization_id"'
      )
    );
  }
  if (scope.onboardingIncomplete) conditions.push(onboardingIncompleteSql());
  if (scope.search) {
    const term = `%${scope.search.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(or(ilike(profileDisplayName, term), ilike(schema.profile.email, term)));
  }
  return client
    .select({
      id: e.id,
      programmeId: e.programmeId,
      programmeTitle: schema.apprProgramme.title,
      programmeType: schema.apprProgramme.type,
      linked: linkedOf,
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
      onboarding: onboardingCountsSql(),
      overdueTaskCount: overdueTaskCountOf(scope.today ?? new Date().toISOString().slice(0, 10)),
      nextReview: nextReviewOf,
      glhMinutes: e.glhMinutes,
      glhTargetMinutes: glhTargetOf,
      unitsTotal: unitsTotalOf,
      unitsComplete: unitsCompleteOf,
      gatewayItems: e.gatewayItems,
      gatewayPassedAt: e.gatewayPassedAt,
      epaBookedDate: e.epaBookedDate,
      epaResult: e.epaResult,
      epaResultDate: e.epaResultDate,
      gatewayChecklist: schema.apprProgramme.gatewayChecklist
    })
    .from(e)
    .innerJoin(schema.profile, eq(schema.profile.id, e.learnerId))
    .innerJoin(schema.apprProgramme, eq(schema.apprProgramme.id, e.programmeId))
    .where(and(...conditions))
    .orderBy(asc(profileDisplayName));
}

// The other half of a linked pair (component <-> carrier) as one JSON object, or null when standalone.
const counterpartOf = sql<{
  enrolmentId: string;
  programmeId: string;
  title: string;
  type: string;
} | null>`(select json_build_object('enrolmentId', lc.id, 'programmeId', lc.programme_id, 'title', lp.title, 'type', lp.type)
  from appr_enrolment lc join appr_programme lp on lp.id = lc.programme_id
  where lc.primary_enrolment_id = ${sql.raw('"appr_enrolment"."id"')} or lc.id = ${sql.raw('"appr_enrolment"."primary_enrolment_id"')} limit 1)`;

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
      programmeType: schema.apprProgramme.type,
      counterpart: counterpartOf,
      tutors: tutorsOf,
      overdueTaskCount: overdueTaskCountOf(today),
      nextReview: nextReviewOf,
      gatewayChecklist: schema.apprProgramme.gatewayChecklist
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

/**
 * Per-criterion evidence counts for one learner on one programme, REFERRED excluded (they are not "in play"). Counted
 * by the CRITERION's programme (criterion -> unit -> qualification), not the evidence's home programme, so evidence
 * homed on the other half of a linked pair still counts. Unlinked data gives the same result as before.
 */
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
    .innerJoin(schema.apprCriterion, eq(schema.apprCriterion.id, schema.apprEvidenceCriterion.criterionId))
    .innerJoin(schema.apprUnit, eq(schema.apprUnit.id, schema.apprCriterion.unitId))
    .innerJoin(schema.apprQualification, eq(schema.apprQualification.id, schema.apprUnit.qualificationId))
    .where(
      and(
        eq(schema.apprQualification.programmeId, programmeId),
        eq(ev.learnerId, learnerId),
        inArray(ev.status, ['ACCEPTED', 'SUBMITTED'])
      )
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
    .innerJoin(schema.apprCriterion, eq(schema.apprCriterion.id, schema.apprEvidenceCriterion.criterionId))
    .innerJoin(schema.apprUnit, eq(schema.apprUnit.id, schema.apprCriterion.unitId))
    .innerJoin(schema.apprQualification, eq(schema.apprQualification.id, schema.apprUnit.qualificationId))
    .where(
      and(eq(schema.apprQualification.programmeId, programmeId), eq(ev.learnerId, learnerId), eq(ev.status, 'ACCEPTED'))
    )
    .orderBy(asc(ev.createdAt));
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.criterionId, [...(map.get(r.criterionId) ?? []), r.title]);
  return map;
}

/**
 * ACCEPTED evidence dates per criterion (ascending ISO UTC strings): coalesce(reviewed_at, updated_at). Feeds the
 * criterion / unit achieved date. Scoped by the criterion's programme (see countEvidenceByCriterion).
 */
export async function listCriterionAcceptedDates(programmeId: string, learnerId: string, client: DbOrTxClient = db) {
  const ev = schema.apprEvidence;
  const acceptedAt = sql<string>`to_char(coalesce(${ev.reviewedAt}, ${ev.updatedAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  const rows = await client
    .select({ criterionId: schema.apprEvidenceCriterion.criterionId, acceptedAt })
    .from(schema.apprEvidenceCriterion)
    .innerJoin(ev, eq(ev.id, schema.apprEvidenceCriterion.evidenceId))
    .innerJoin(schema.apprCriterion, eq(schema.apprCriterion.id, schema.apprEvidenceCriterion.criterionId))
    .innerJoin(schema.apprUnit, eq(schema.apprUnit.id, schema.apprCriterion.unitId))
    .innerJoin(schema.apprQualification, eq(schema.apprQualification.id, schema.apprUnit.qualificationId))
    .where(
      and(eq(schema.apprQualification.programmeId, programmeId), eq(ev.learnerId, learnerId), eq(ev.status, 'ACCEPTED'))
    )
    .orderBy(sql`coalesce(${ev.reviewedAt}, ${ev.updatedAt}) asc`, asc(ev.id));
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.criterionId, [...(map.get(r.criterionId) ?? []), r.acceptedAt]);
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

// ── Linked (Diploma + Standard) enrolments — migration 0036 ──

export type ApprEnrolmentRow = typeof schema.apprEnrolment.$inferSelect;

/**
 * The other half of a linked pair: the COMPONENT when `enrolmentId` is the carrier, the CARRIER when it is the
 * component; null for a standalone enrolment. (Row only — fetch the programme separately if you need its type.)
 */
export async function getLinkedEnrolment(enrolmentId: string, client: DbOrTxClient = db) {
  const e = schema.apprEnrolment;
  const [row] = await client
    .select()
    .from(e)
    .where(
      or(
        eq(e.primaryEnrolmentId, enrolmentId),
        eq(e.id, sql`(select x.primary_enrolment_id from appr_enrolment x where x.id = ${enrolmentId})`)
      )
    )
    .limit(1);
  return row ?? null;
}

export interface ApprLearnerEnrolmentRef {
  id: string;
  programmeId: string;
  programmeTitle: string;
  type: 'DIPLOMA' | 'STANDARD';
  level: string | null;
  pairedProgrammeId: string | null;
  pairedProgrammeTitle: string | null;
  primaryEnrolmentId: string | null;
  /** The enrolment linked to this one as its component, if this is a carrier. */
  componentId: string | null;
  achievedAt: string | null;
  createdAt: string | null;
}

/**
 * Serialise every enrol / link decision for one learner (transaction-scoped advisory lock, released at commit/rollback).
 * The one-open-diploma + one-open-standard rule is a read-then-write check, so two concurrent requests would both pass
 * it; taking this lock FIRST inside the transaction and re-reading the learner's enrolments makes the second wait and
 * then see the first one's rows. Keyed on the learner id, so it also covers a brand-new learner (uniform code path).
 */
export async function lockLearnerEnrolments(tx: DbOrTxClient, learnerId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`appr_enrol:${learnerId}`}))`);
}

/** Every apprenticeship enrolment of a learner in the org with its programme (type, level, pair) and link, oldest first. */
export async function listLearnerEnrolments(
  organizationId: string,
  learnerId: string,
  client: DbOrTxClient = db
): Promise<ApprLearnerEnrolmentRef[]> {
  const e = schema.apprEnrolment;
  const p = schema.apprProgramme;
  const rows = await client
    .select({
      id: e.id,
      programmeId: e.programmeId,
      programmeTitle: p.title,
      type: p.type,
      level: p.level,
      pairedProgrammeId: p.pairedProgrammeId,
      pairedProgrammeTitle: sql<
        string | null
      >`(select pp.title from appr_programme pp where pp.id = ${p.pairedProgrammeId})`,
      primaryEnrolmentId: e.primaryEnrolmentId,
      componentId: sql<
        string | null
      >`(select c.id from appr_enrolment c where c.primary_enrolment_id = ${e.id} limit 1)`,
      achievedAt: e.achievedAt,
      createdAt: e.createdAt
    })
    .from(e)
    .innerJoin(p, eq(p.id, e.programmeId))
    .where(and(eq(e.organizationId, organizationId), eq(e.learnerId, learnerId)))
    .orderBy(asc(e.createdAt), asc(e.id));
  return rows.map((r) => ({ ...r, type: r.type === 'STANDARD' ? ('STANDARD' as const) : ('DIPLOMA' as const) }));
}

/** Link two standalone enrolments: `componentId` points at `carrierId`. False when the component is already linked. */
export async function linkApprEnrolments(tx: DbOrTxClient, carrierId: string, componentId: string) {
  const e = schema.apprEnrolment;
  const rows = await tx
    .update(e)
    .set({ primaryEnrolmentId: carrierId })
    .where(and(eq(e.id, componentId), isNull(e.primaryEnrolmentId)))
    .returning({ id: e.id });
  return rows.length > 0;
}

/** Clear a component's link (it becomes standalone). */
export async function unlinkApprEnrolment(tx: DbOrTxClient, componentId: string) {
  await tx
    .update(schema.apprEnrolment)
    .set({ primaryEnrolmentId: null })
    .where(eq(schema.apprEnrolment.id, componentId));
}

/**
 * Evidence of the learner homed on one programme of the pair but mapped to criteria of the OTHER one (Deploy 3 creates
 * these; until then this is always 0). Distinct evidence count.
 */
export async function countCrossMappedEvidence(
  learnerId: string,
  programmeIds: [string, string],
  client: DbOrTxClient = db
) {
  const ec = schema.apprEvidenceCriterion;
  const ev = schema.apprEvidence;
  const [row] = await client
    .select({ n: sql<number>`count(distinct ${ev.id})::int` })
    .from(ec)
    .innerJoin(ev, eq(ev.id, ec.evidenceId))
    .innerJoin(schema.apprCriterion, eq(schema.apprCriterion.id, ec.criterionId))
    .innerJoin(schema.apprUnit, eq(schema.apprUnit.id, schema.apprCriterion.unitId))
    .innerJoin(schema.apprQualification, eq(schema.apprQualification.id, schema.apprUnit.qualificationId))
    .where(
      and(
        eq(ev.learnerId, learnerId),
        inArray(ev.programmeId, programmeIds),
        sql`${schema.apprQualification.programmeId} <> ${ev.programmeId}`
      )
    );
  return row?.n ?? 0;
}

/**
 * Linked pairs that still matter (at least one side not achieved) between a diploma and one Standard, in either
 * carrier/component order. Gates changing or clearing the diploma's pair.
 */
export async function countOpenLinkedPairs(diplomaId: string, standardId: string, client: DbOrTxClient = db) {
  const rows = (await client.execute(
    sql`select count(*)::int as n from appr_enrolment c join appr_enrolment k on k.id = c.primary_enrolment_id
      where ((c.programme_id = ${diplomaId}::uuid and k.programme_id = ${standardId}::uuid)
        or (c.programme_id = ${standardId}::uuid and k.programme_id = ${diplomaId}::uuid))
        and (c.achieved_at is null or k.achieved_at is null)`
  )) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

/** Which of these enrolment ids are components of a linked pair (the daily scans skip them). */
export async function listComponentEnrolmentIds(enrolmentIds: string[], client: DbOrTxClient = db) {
  if (enrolmentIds.length === 0) return new Set<string>();
  const e = schema.apprEnrolment;
  const rows = await client
    .select({ id: e.id })
    .from(e)
    .where(and(inArray(e.id, enrolmentIds), sql`${e.primaryEnrolmentId} is not null`));
  return new Set(rows.map((r) => r.id));
}

/**
 * Like listEnrolmentsNeedingFirstReview (reviews.ts) but for CARRIERS / standalone enrolments only: a linked component
 * never has its own review (reviews are learner-level, on the carrier), so the back-fill must not see it — and, since
 * the batch is limited, components must be filtered in SQL or they would crowd real candidates out.
 */
export async function listCarrierEnrolmentsNeedingFirstReview(limit: number, client: DbOrTxClient = db) {
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
        isNull(e.primaryEnrolmentId),
        sql`${e.startDate} is not null`,
        sql`not exists (select 1 from appr_review x where x.enrolment_id = ${sql.raw('"appr_enrolment"."id"')})`
      )
    )
    .orderBy(asc(e.createdAt))
    .limit(limit);
}

/** A profile that is a LEARNER (role 3) of the org, by email (case-insensitive). Null when none — never reveals other orgs. */
export async function getOrgLearnerByEmail(organizationId: string, email: string, client: DbOrTxClient = db) {
  const [row] = await client
    .select({ id: schema.profile.id })
    .from(schema.profile)
    .innerJoin(
      schema.organizationmember,
      and(
        eq(schema.organizationmember.profileId, schema.profile.id),
        eq(schema.organizationmember.organizationId, organizationId),
        eq(schema.organizationmember.roleId, 3)
      )
    )
    .where(sql`lower(${schema.profile.email}) = ${email.trim().toLowerCase()}`)
    .limit(1);
  return row ?? null;
}

/** Courses of the org the profile is a member of (the regular, non-apprenticeship learning). */
export async function countRegularCourses(organizationId: string, learnerId: string, client: DbOrTxClient = db) {
  const [row] = await client
    .select({ n: sql<number>`count(distinct ${schema.course.id})::int` })
    .from(schema.groupmember)
    .innerJoin(schema.group, eq(schema.group.id, schema.groupmember.groupId))
    .innerJoin(schema.course, eq(schema.course.groupId, schema.group.id))
    .where(and(eq(schema.group.organizationId, organizationId), eq(schema.groupmember.profileId, learnerId)));
  return row?.n ?? 0;
}
