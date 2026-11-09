import * as schema from '@db/schema';

import { and, db, eq, inArray, isNotNull, isNull, sql, type DbOrTxClient } from '@db/drizzle';
import { profileDisplayName } from './names';
import { ROLE } from '@cio/utils/constants';

// Gecko Apprenticeships — gateway checklist ticks, gateway confirmation, EPA fields, and the "ready" notification flag.
// No access control here (services scope the actor first). Writes take the transaction client.

const e = schema.apprEnrolment;

export type ApprGatewayTick = { done: boolean; by?: string | null; at?: string | null; note?: string | null };

/** Merge ONE manual tick into gateway_items — only while the gateway is not confirmed. Null = already confirmed. */
export async function setGatewayTick(tx: DbOrTxClient, enrolmentId: string, key: string, tick: ApprGatewayTick) {
  const [row] = await tx
    .update(e)
    .set({ gatewayItems: sql`${e.gatewayItems} || jsonb_build_object(${key}::text, ${JSON.stringify(tick)}::jsonb)` })
    .where(and(eq(e.id, enrolmentId), isNull(e.gatewayPassedAt)))
    .returning();
  return row ?? null;
}

/** Confirm the gateway (locks the checklist). Null = it was already confirmed. */
export async function passGateway(tx: DbOrTxClient, enrolmentId: string, by: string) {
  const [row] = await tx
    .update(e)
    .set({ gatewayPassedAt: sql`now()`, gatewayPassedBy: by })
    .where(and(eq(e.id, enrolmentId), isNull(e.gatewayPassedAt)))
    .returning();
  return row ?? null;
}

/** Reopen the gateway (ticks are kept). Null = it was not confirmed, or an EPA result exists. */
export async function reopenGateway(tx: DbOrTxClient, enrolmentId: string) {
  const [row] = await tx
    .update(e)
    .set({ gatewayPassedAt: null, gatewayPassedBy: null, epaBookedDate: null })
    .where(and(eq(e.id, enrolmentId), isNotNull(e.gatewayPassedAt), isNull(e.epaResult)))
    .returning();
  return row ?? null;
}

export async function setEpa(
  tx: DbOrTxClient,
  enrolmentId: string,
  patch: {
    epaBookedDate?: string | null;
    epaResult?: string | null;
    epaResultDate?: string | null;
    achievedAt?: string | null;
  }
) {
  const [row] = await tx
    .update(e)
    .set(patch)
    .where(and(eq(e.id, enrolmentId), isNotNull(e.gatewayPassedAt)))
    .returning();
  return row ?? null;
}

/** First time the learner becomes ready: stamp the flag. True = this call claimed it (so this caller notifies). */
export async function claimGatewayReady(tx: DbOrTxClient, enrolmentId: string): Promise<boolean> {
  const rows = await tx
    .update(e)
    .set({ gatewayReadyNotifiedAt: sql`now()` })
    .where(and(eq(e.id, enrolmentId), isNull(e.gatewayReadyNotifiedAt), isNull(e.gatewayPassedAt)))
    .returning({ id: e.id });
  return rows.length > 0;
}

/** Readiness dropped (evidence referred): clear the flag so the notification can fire again. */
export async function clearGatewayReady(tx: DbOrTxClient, enrolmentId: string) {
  await tx
    .update(e)
    .set({ gatewayReadyNotifiedAt: null })
    .where(and(eq(e.id, enrolmentId), isNotNull(e.gatewayReadyNotifiedAt), isNull(e.gatewayPassedAt)));
}

/** Active admins of an organization (profile ids) — recipients of "learner ready for gateway". */
export async function listOrgAdminIds(organizationId: string, client: DbOrTxClient = db): Promise<string[]> {
  const rows = await client
    .select({ id: schema.profile.id })
    .from(schema.organizationmember)
    .innerJoin(schema.profile, eq(schema.profile.id, schema.organizationmember.profileId))
    .where(
      and(
        eq(schema.organizationmember.organizationId, organizationId),
        eq(schema.organizationmember.roleId, ROLE.ADMIN),
        eq(schema.profile.status, 'ACTIVE')
      )
    );
  return rows.map((r) => r.id);
}

/** Notification deep links: enrolment id -> the learner's display name (gateway-ready alerts). */
export async function getEnrolmentLinkTargets(enrolmentIds: string[], client: DbOrTxClient = db) {
  const out = new Map<string, { learnerName: string | null }>();
  if (enrolmentIds.length === 0) return out;
  const rows = await client
    .select({ id: e.id, learnerName: profileDisplayName })
    .from(e)
    .leftJoin(schema.profile, eq(schema.profile.id, e.learnerId))
    .where(inArray(e.id, enrolmentIds));
  for (const r of rows) out.set(r.id, { learnerName: r.learnerName });
  return out;
}

/** Same as claimGatewayReady, for callers outside a transaction (the daily scan). */
export async function claimGatewayReadyNow(enrolmentId: string, client: DbOrTxClient = db): Promise<boolean> {
  return claimGatewayReady(client, enrolmentId);
}

/**
 * Enrolments that might be ready for the gateway but were never flagged (readiness was first reached by a recompute
 * that does not claim, e.g. a programme-level one): not confirmed, not achieved, not yet notified. Carries the cached
 * progress the readiness rule needs; the scan decides who is actually ready.
 */
export async function listGatewayReadyCandidates(limit: number, client: DbOrTxClient = db) {
  const p = schema.apprProgramme;
  return client
    .select({
      id: e.id,
      organizationId: e.organizationId,
      learnerId: e.learnerId,
      startDate: e.startDate,
      plannedEndDate: e.plannedEndDate,
      contractedHoursWeek: e.contractedHoursWeek,
      otjTargetMinutesOverride: e.otjTargetMinutesOverride,
      otjMinutes: e.otjMinutes,
      gatewayItems: e.gatewayItems,
      gatewayChecklist: p.gatewayChecklist,
      otjFactor: schema.apprSettings.otjFactor,
      otjWeeklyCapHours: schema.apprSettings.otjWeeklyCapHours,
      unitsTotal: sql<number>`(select count(*) from appr_enrolment_unit eu where eu.enrolment_id = ${sql.raw('"appr_enrolment"."id"')})::int`,
      unitsComplete: sql<number>`(select count(*) from appr_enrolment_unit ec where ec.enrolment_id = ${sql.raw('"appr_enrolment"."id"')} and ec.completed_at is not null)::int`
    })
    .from(e)
    .innerJoin(p, eq(p.id, e.programmeId))
    .leftJoin(schema.apprSettings, eq(schema.apprSettings.organizationId, e.organizationId))
    .where(and(isNull(e.gatewayPassedAt), isNull(e.gatewayReadyNotifiedAt), isNull(e.achievedAt)))
    .orderBy(e.createdAt)
    .limit(limit);
}
