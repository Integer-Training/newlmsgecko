import * as schema from '@db/schema';

import { and, db, eq, inArray, sql, type DbOrTxClient } from '@db/drizzle';
import { onboardingCountsSql, type ApprOnboardingCounts } from './onboarding';

// Gecko Apprenticeships — overview reads (Deploy 2): small GROUP BY counts for the learner overview pies, plus the
// carrier/component lookup. No access control here: the service resolves the actor first.

export interface ApprOverviewBreakdown {
  tasks: { PLANNED: number; SUBMITTED: number; REFERRED: number; COMPLETE: number; overdue: number };
  evidence: { SUBMITTED: number; ACCEPTED: number; REFERRED: number };
  otj: { SUBMITTED: number; VALIDATED: number; REJECTED: number };
}

/** The component enrolment linked to a carrier (appr_enrolment.primary_enrolment_id = carrier), or null. */
export async function getComponentEnrolment(carrierId: string, client: DbOrTxClient = db) {
  const [row] = await client
    .select()
    .from(schema.apprEnrolment)
    .where(eq(schema.apprEnrolment.primaryEnrolmentId, carrierId))
    .limit(1);
  return row ?? null;
}

/** Required-onboarding counts of one enrolment (same shape the learners table uses). */
export async function getOnboardingCountsForEnrolment(
  enrolmentId: string,
  client: DbOrTxClient = db
): Promise<ApprOnboardingCounts> {
  const e = schema.apprEnrolment;
  const [row] = await client.select({ counts: onboardingCountsSql() }).from(e).where(eq(e.id, enrolmentId)).limit(1);
  const c = row?.counts;
  return {
    required: Number(c?.required ?? 0),
    approved: Number(c?.approved ?? 0),
    submitted: Number(c?.submitted ?? 0),
    rejected: Number(c?.rejected ?? 0)
  };
}

/**
 * Status counts for the overview pies: tasks (per status + overdue) of the given enrolments, evidence of the learner on
 * the given programmes, and OTJ-carrying evidence mapped to the OTJ vocabulary.
 * TODO(Deploy 3): replace the OTJ part with appr_otj_log status counts plus OTJ-carrying evidence.
 */
export async function getOverviewBreakdown(
  scope: { enrolmentIds: string[]; programmeIds: string[]; learnerId: string },
  today: string,
  client: DbOrTxClient = db
): Promise<ApprOverviewBreakdown> {
  const out: ApprOverviewBreakdown = {
    tasks: { PLANNED: 0, SUBMITTED: 0, REFERRED: 0, COMPLETE: 0, overdue: 0 },
    evidence: { SUBMITTED: 0, ACCEPTED: 0, REFERRED: 0 },
    otj: { SUBMITTED: 0, VALIDATED: 0, REJECTED: 0 }
  };
  if (scope.enrolmentIds.length === 0) return out;
  const t = schema.apprTask;
  const ev = schema.apprEvidence;

  const [taskRows, evidenceRows, otjRows] = await Promise.all([
    client
      .select({
        status: t.status,
        count: sql<number>`count(*)::int`,
        overdue: sql<number>`count(*) filter (where ${t.dueDate} < ${today}::date and ${t.status} <> 'COMPLETE')::int`
      })
      .from(t)
      .where(inArray(t.enrolmentId, scope.enrolmentIds))
      .groupBy(t.status),
    client
      .select({ status: ev.status, count: sql<number>`count(*)::int` })
      .from(ev)
      .where(and(eq(ev.learnerId, scope.learnerId), inArray(ev.programmeId, scope.programmeIds)))
      .groupBy(ev.status),
    client
      .select({ status: ev.status, count: sql<number>`count(*)::int` })
      .from(ev)
      .where(
        and(eq(ev.learnerId, scope.learnerId), inArray(ev.programmeId, scope.programmeIds), eq(ev.includeOtj, true))
      )
      .groupBy(ev.status)
  ]);

  for (const r of taskRows) {
    if (r.status in out.tasks) out.tasks[r.status as 'PLANNED'] += Number(r.count);
    out.tasks.overdue += Number(r.overdue);
  }
  for (const r of evidenceRows) {
    if (r.status in out.evidence) out.evidence[r.status as 'SUBMITTED'] += Number(r.count);
  }
  const otjMap: Record<string, keyof ApprOverviewBreakdown['otj']> = {
    SUBMITTED: 'SUBMITTED',
    ACCEPTED: 'VALIDATED',
    REFERRED: 'REJECTED'
  };
  for (const r of otjRows) {
    const k = otjMap[r.status];
    if (k) out.otj[k] += Number(r.count);
  }
  return out;
}
