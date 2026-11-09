import * as schema from '@db/schema';

import { and, db, eq, inArray, sql, type DbOrTxClient } from '@db/drizzle';
import {
  APPR_COUNTING_EVIDENCE_STATUSES,
  APPR_DEFAULT_EVIDENCE_TYPES,
  APPR_DEFAULT_SETTINGS,
  type ApprSettings
} from '@cio/utils/constants/apprenticeship';

// Gecko Apprenticeships — the reads that feed the progress rules and the one write of the progress cache. No access
// control here (services do that). Ids only; nothing here touches diploma tables.

/** Org rules, falling back to the defaults until the org saves its own row. */
export async function getApprSettings(organizationId: string, client: DbOrTxClient = db): Promise<ApprSettings> {
  const [row] = await client
    .select()
    .from(schema.apprSettings)
    .where(eq(schema.apprSettings.organizationId, organizationId))
    .limit(1);
  if (!row) return { ...APPR_DEFAULT_SETTINGS };
  return { concernGapPct: row.concernGapPct, otjFactor: row.otjFactor, otjWeeklyCapHours: row.otjWeeklyCapHours };
}

/** Org evidence types; seeds the defaults on first read so every org starts with the standard list. */
export async function listApprEvidenceTypes(organizationId: string, client: DbOrTxClient = db) {
  const read = () =>
    client
      .select()
      .from(schema.apprEvidenceType)
      .where(eq(schema.apprEvidenceType.organizationId, organizationId))
      .orderBy(schema.apprEvidenceType.sort);
  const rows = await read();
  if (rows.length > 0) return rows;
  await client
    .insert(schema.apprEvidenceType)
    .values(APPR_DEFAULT_EVIDENCE_TYPES.map((t, i) => ({ organizationId, key: t.key, label: t.label, sort: i })))
    .onConflictDoNothing();
  return read();
}

export async function getApprEnrolment(enrolmentId: string, client: DbOrTxClient = db) {
  const [row] = await client
    .select()
    .from(schema.apprEnrolment)
    .where(eq(schema.apprEnrolment.id, enrolmentId))
    .limit(1);
  return row ?? null;
}

export async function getApprEnrolmentByProgrammeLearner(
  programmeId: string,
  learnerId: string,
  client: DbOrTxClient = db
) {
  const [row] = await client
    .select()
    .from(schema.apprEnrolment)
    .where(and(eq(schema.apprEnrolment.programmeId, programmeId), eq(schema.apprEnrolment.learnerId, learnerId)))
    .limit(1);
  return row ?? null;
}

/** Every criterion of a programme's qualifications with its unit, in display order (3 small joined tables). */
export async function listProgrammeCriteria(programmeId: string, client: DbOrTxClient = db) {
  return client
    .select({
      criterionId: schema.apprCriterion.id,
      unitId: schema.apprUnit.id,
      qualificationId: schema.apprQualification.id,
      requiredCount: schema.apprCriterion.requiredCount
    })
    .from(schema.apprCriterion)
    .innerJoin(schema.apprUnit, eq(schema.apprUnit.id, schema.apprCriterion.unitId))
    .innerJoin(schema.apprQualification, eq(schema.apprQualification.id, schema.apprUnit.qualificationId))
    .where(eq(schema.apprQualification.programmeId, programmeId))
    .orderBy(schema.apprQualification.sort, schema.apprUnit.sort, schema.apprCriterion.sort);
}

/** Every unit of a programme in display order (units with no criteria still appear). */
export async function listProgrammeUnits(programmeId: string, client: DbOrTxClient = db) {
  return client
    .select({ unitId: schema.apprUnit.id, qualificationId: schema.apprQualification.id, glh: schema.apprUnit.glh })
    .from(schema.apprUnit)
    .innerJoin(schema.apprQualification, eq(schema.apprQualification.id, schema.apprUnit.qualificationId))
    .where(eq(schema.apprQualification.programmeId, programmeId))
    .orderBy(schema.apprQualification.sort, schema.apprUnit.sort);
}

/** Per-criterion count of COUNTING (accepted) evidence for one learner on one programme. */
export async function countAcceptedByCriterion(programmeId: string, learnerId: string, client: DbOrTxClient = db) {
  const rows = await client
    .select({ criterionId: schema.apprEvidenceCriterion.criterionId, count: sql<number>`count(*)::int` })
    .from(schema.apprEvidenceCriterion)
    .innerJoin(schema.apprEvidence, eq(schema.apprEvidence.id, schema.apprEvidenceCriterion.evidenceId))
    .where(
      and(
        eq(schema.apprEvidence.programmeId, programmeId),
        eq(schema.apprEvidence.learnerId, learnerId),
        inArray(schema.apprEvidence.status, [...APPR_COUNTING_EVIDENCE_STATUSES])
      )
    )
    .groupBy(schema.apprEvidenceCriterion.criterionId);
  return new Map(rows.map((r) => [r.criterionId, r.count]));
}

/** Evidence totals for one learner on one programme: count per status + counting OTJ minutes. One query. */
export async function getEvidenceTotals(programmeId: string, learnerId: string, client: DbOrTxClient = db) {
  const counting = sql.join(
    APPR_COUNTING_EVIDENCE_STATUSES.map((s) => sql`${s}`),
    sql`, `
  );
  const [row] = await client
    .select({
      submitted: sql<number>`count(*) filter (where ${schema.apprEvidence.status} = 'SUBMITTED')::int`,
      accepted: sql<number>`count(*) filter (where ${schema.apprEvidence.status} = 'ACCEPTED')::int`,
      referred: sql<number>`count(*) filter (where ${schema.apprEvidence.status} = 'REFERRED')::int`,
      otjMinutes: sql<number>`coalesce(sum(${schema.apprEvidence.minutes}) filter (where ${schema.apprEvidence.includeOtj} and ${schema.apprEvidence.status} in (${counting})), 0)::int`
    })
    .from(schema.apprEvidence)
    .where(and(eq(schema.apprEvidence.programmeId, programmeId), eq(schema.apprEvidence.learnerId, learnerId)));
  return row ?? { submitted: 0, accepted: 0, referred: 0, otjMinutes: 0 };
}

export async function listEnrolmentUnitRows(enrolmentId: string, client: DbOrTxClient = db) {
  return client.select().from(schema.apprEnrolmentUnit).where(eq(schema.apprEnrolmentUnit.enrolmentId, enrolmentId));
}

/**
 * Write the progress cache for one enrolment: the learner row + one row per unit (upsert keeps tutor-set dates).
 * Called only by the recompute service, inside the same transaction as the change that triggered it.
 */
export async function writeEnrolmentCache(
  enrolmentId: string,
  cache: {
    actualPct: number | null;
    otjMinutes: number;
    submittedCount: number;
    acceptedCount: number;
    referredCount: number;
    /** GLH done (units + logs), minutes. */
    glhMinutes?: number;
    units: { unitId: string; actualPct: number | null; complete: boolean }[];
  },
  client: DbOrTxClient = db
): Promise<void> {
  const now = new Date().toISOString();
  await client
    .update(schema.apprEnrolment)
    .set({
      actualPct: cache.actualPct,
      otjMinutes: cache.otjMinutes,
      submittedCount: cache.submittedCount,
      acceptedCount: cache.acceptedCount,
      referredCount: cache.referredCount,
      ...(cache.glhMinutes !== undefined ? { glhMinutes: cache.glhMinutes } : {}),
      recomputedAt: now
    })
    .where(eq(schema.apprEnrolment.id, enrolmentId));
  if (cache.units.length === 0) return;
  await client
    .insert(schema.apprEnrolmentUnit)
    .values(
      cache.units.map((u) => ({
        enrolmentId,
        unitId: u.unitId,
        actualPct: u.actualPct,
        completedAt: u.complete ? now : null
      }))
    )
    .onConflictDoUpdate({
      target: [schema.apprEnrolmentUnit.enrolmentId, schema.apprEnrolmentUnit.unitId],
      set: {
        actualPct: sql`excluded.actual_pct`,
        // Keep the first completion time; clear it if the unit is no longer complete (e.g. evidence referred).
        completedAt: sql`case when excluded.completed_at is null then null else coalesce(${schema.apprEnrolmentUnit.completedAt}, excluded.completed_at) end`
      }
    });
}
