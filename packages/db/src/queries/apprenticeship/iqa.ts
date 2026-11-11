import * as schema from '@db/schema';

import { and, db, eq, sql, type DbOrTxClient, type SQL } from '@db/drizzle';

// Gecko Apprenticeships — IQA (internal quality assurance) sampling. No access control here: the service decides who may
// see or change what. assessor = appr_evidence.reviewed_by at sampling time; one sample per evidence (unique).

const s = schema.apprIqaSample;

export type ApprIqaSampleRow = typeof s.$inferSelect;

export interface IqaFilter {
  programmeId?: string;
  assessorId?: string;
  outcome?: string;
}

/** One sample with everything the lists show (names, current evidence status, deep-link ids). */
export interface ApprIqaSampleView {
  id: string;
  outcome: string;
  feedback: string | null;
  createdAt: string;
  decidedAt: string | null;
  acknowledgedAt: string | null;
  evidenceId: string;
  evidenceTitle: string;
  evidenceStatus: string;
  evidenceTypeKey: string;
  enrolmentId: string;
  programmeId: string;
  programmeTitle: string;
  learnerId: string;
  learnerName: string | null;
  assessorId: string | null;
  assessorName: string | null;
  sampledByName: string | null;
  decidedByName: string | null;
}

/** Display name of the profile held in a column of the sample view query (same rule as profileDisplayName). */
const nameOf = (profileCol: string) =>
  sql.raw(
    `(select coalesce(nullif(nu.name, ''), np.fullname) from profile np left join "user" nu on nu.id = np.id where np.id = ${profileCol})`
  );

/** Shared SELECT for the sample views. `where` must start with "where". */
function sampleViewSql(where: SQL) {
  return sql`
    select s.id, s.outcome, s.feedback,
      s.created_at as "createdAt", s.decided_at as "decidedAt", s.acknowledged_at as "acknowledgedAt",
      s.evidence_id as "evidenceId", e.title as "evidenceTitle", e.status as "evidenceStatus", e.type_key as "evidenceTypeKey",
      s.enrolment_id as "enrolmentId", e.programme_id as "programmeId", pr.title as "programmeTitle",
      e.learner_id as "learnerId", ${nameOf('e.learner_id')} as "learnerName",
      s.assessor_id as "assessorId", ${nameOf('s.assessor_id')} as "assessorName",
      ${nameOf('s.sampled_by')} as "sampledByName", ${nameOf('s.decided_by')} as "decidedByName"
    from appr_iqa_sample s
    join appr_evidence e on e.id = s.evidence_id
    join appr_programme pr on pr.id = e.programme_id
    ${where}`;
}

export async function getIqaSampleView(
  organizationId: string,
  sampleId: string,
  client: DbOrTxClient = db
): Promise<ApprIqaSampleView | null> {
  const rows = (await client.execute(
    sampleViewSql(sql`where s.organization_id = ${organizationId}::uuid and s.id = ${sampleId}::uuid`)
  )) as unknown as ApprIqaSampleView[];
  return rows[0] ?? null;
}

export async function getIqaSampleViewByEvidence(
  organizationId: string,
  evidenceId: string,
  client: DbOrTxClient = db
): Promise<ApprIqaSampleView | null> {
  const rows = (await client.execute(
    sampleViewSql(sql`where s.organization_id = ${organizationId}::uuid and s.evidence_id = ${evidenceId}::uuid`)
  )) as unknown as ApprIqaSampleView[];
  return rows[0] ?? null;
}

/** Newest first. A tutor's own IQA feedback = the same list with assessorId set to themselves. */
export async function listIqaSampleViews(
  organizationId: string,
  filter: IqaFilter,
  client: DbOrTxClient = db
): Promise<ApprIqaSampleView[]> {
  const conds = [sql`s.organization_id = ${organizationId}::uuid`];
  if (filter.programmeId) conds.push(sql`e.programme_id = ${filter.programmeId}::uuid`);
  if (filter.assessorId) conds.push(sql`s.assessor_id = ${filter.assessorId}::uuid`);
  if (filter.outcome) conds.push(sql`s.outcome = ${filter.outcome}`);
  return (await client.execute(
    sql`${sampleViewSql(sql`where ${sql.join(conds, sql` and `)}`)} order by s.created_at desc, s.id`
  )) as unknown as ApprIqaSampleView[];
}

export async function listIqaSampleViewsByIds(
  organizationId: string,
  ids: string[],
  client: DbOrTxClient = db
): Promise<ApprIqaSampleView[]> {
  if (ids.length === 0) return [];
  const list = sql.join(
    ids.map((i) => sql`${i}::uuid`),
    sql`, `
  );
  return (await client.execute(
    sql`${sampleViewSql(sql`where s.organization_id = ${organizationId}::uuid and s.id in (${list})`)} order by s.created_at desc, s.id`
  )) as unknown as ApprIqaSampleView[];
}

/** The evidence a manual sample is cut from, with its enrolment (null if the learner has none). */
export async function getIqaEvidenceContext(evidenceId: string, client: DbOrTxClient = db) {
  const [row] = await client
    .select({
      id: schema.apprEvidence.id,
      organizationId: schema.apprEvidence.organizationId,
      programmeId: schema.apprEvidence.programmeId,
      learnerId: schema.apprEvidence.learnerId,
      status: schema.apprEvidence.status,
      title: schema.apprEvidence.title,
      reviewedBy: schema.apprEvidence.reviewedBy,
      enrolmentId: schema.apprEnrolment.id
    })
    .from(schema.apprEvidence)
    .leftJoin(
      schema.apprEnrolment,
      and(
        eq(schema.apprEnrolment.programmeId, schema.apprEvidence.programmeId),
        eq(schema.apprEnrolment.learnerId, schema.apprEvidence.learnerId)
      )
    )
    .where(eq(schema.apprEvidence.id, evidenceId))
    .limit(1);
  return row ?? null;
}

export async function getIqaSample(sampleId: string, client: DbOrTxClient = db) {
  const [row] = await client.select().from(s).where(eq(s.id, sampleId)).limit(1);
  return row ?? null;
}

/** Insert one sample; null when the evidence is already sampled (unique evidence_id). */
export async function insertIqaSample(
  values: typeof s.$inferInsert,
  client: DbOrTxClient = db
): Promise<ApprIqaSampleRow | null> {
  const [row] = await client.insert(s).values(values).onConflictDoNothing({ target: s.evidenceId }).returning();
  return row ?? null;
}

/** Insert many; evidence sampled meanwhile is skipped. Returns only the rows created. */
export async function insertIqaSamples(
  values: (typeof s.$inferInsert)[],
  client: DbOrTxClient = db
): Promise<ApprIqaSampleRow[]> {
  if (values.length === 0) return [];
  return client.insert(s).values(values).onConflictDoNothing({ target: s.evidenceId }).returning();
}

/**
 * Optimistic decide: only when the outcome (and, if given, decided_at) is still what the reviewer saw, so two admins
 * editing the same decision cannot silently overwrite each other. Resets the assessor's acknowledgement.
 */
export async function decideIqaSample(
  sampleId: string,
  expected: { outcome: string; decidedAt?: string | null },
  patch: { outcome: string; feedback: string | null; decidedBy: string },
  client: DbOrTxClient = db
) {
  const sameDecision =
    expected.decidedAt === undefined
      ? undefined
      : sql`${s.decidedAt} is not distinct from ${expected.decidedAt}::timestamptz`;
  const [row] = await client
    .update(s)
    .set({ ...patch, decidedAt: sql`now()`, acknowledgedAt: null })
    .where(and(eq(s.id, sampleId), eq(s.outcome, expected.outcome), sameDecision))
    .returning();
  return row ?? null;
}

/**
 * Idempotent: keeps the first acknowledgement time. Only the assessor, only once decided, and only the decision they
 * saw (`decidedAt`) — a decision changed since returns null (caller → 409).
 */
export async function acknowledgeIqaSample(
  sampleId: string,
  assessorId: string,
  decidedAt: string,
  client: DbOrTxClient = db
) {
  const [row] = await client
    .update(s)
    .set({ acknowledgedAt: sql`coalesce(${s.acknowledgedAt}, now())` })
    .where(
      and(
        eq(s.id, sampleId),
        eq(s.assessorId, assessorId),
        sql`${s.outcome} <> 'PENDING'`,
        sql`${s.decidedAt} = ${decidedAt}::timestamptz`
      )
    )
    .returning();
  return row ?? null;
}

/** Delete only while PENDING. */
export async function deletePendingIqaSample(sampleId: string, client: DbOrTxClient = db) {
  const [row] = await client
    .delete(s)
    .where(and(eq(s.id, sampleId), eq(s.outcome, 'PENDING')))
    .returning({ id: s.id });
  return row ?? null;
}

// ── Target ──

export async function getIqaTargetPct(organizationId: string, client: DbOrTxClient = db): Promise<number | null> {
  const [row] = await client
    .select({ pct: schema.apprSettings.iqaTargetPct })
    .from(schema.apprSettings)
    .where(eq(schema.apprSettings.organizationId, organizationId))
    .limit(1);
  return row?.pct ?? null;
}

/** Upsert ONLY iqa_target_pct (a new row takes the other columns' defaults). */
export async function putIqaTargetPct(organizationId: string, pct: number, client: DbOrTxClient = db) {
  await client
    .insert(schema.apprSettings)
    .values({ organizationId, iqaTargetPct: pct })
    .onConflictDoUpdate({
      target: schema.apprSettings.organizationId,
      set: { iqaTargetPct: pct, updatedAt: sql`now()` }
    });
}

// ── Coverage ──

export interface IqaAssessorCoverageRow {
  assessorId: string;
  name: string | null;
  accepted: number;
  sampled: number;
  /** Samples whose evidence is still ACCEPTED: the numerator for % and the Suggest quota (never above `accepted`). */
  sampledAccepted: number;
  pending: number;
  agree: number;
  disagree: number;
  awaitingAck: number;
}

/** Per assessor: current ACCEPTED evidence they reviewed vs the samples taken from them. ONE statement. */
export async function listIqaAssessorCoverage(
  organizationId: string,
  filter: Pick<IqaFilter, 'programmeId' | 'assessorId'>,
  client: DbOrTxClient = db
): Promise<IqaAssessorCoverageRow[]> {
  const accCond = [
    sql`e.organization_id = ${organizationId}::uuid`,
    sql`e.status = 'ACCEPTED'`,
    sql`e.reviewed_by is not null`
  ];
  const smpCond = [sql`s.organization_id = ${organizationId}::uuid`, sql`s.assessor_id is not null`];
  if (filter.programmeId) {
    accCond.push(sql`e.programme_id = ${filter.programmeId}::uuid`);
    smpCond.push(sql`e.programme_id = ${filter.programmeId}::uuid`);
  }
  if (filter.assessorId) {
    accCond.push(sql`e.reviewed_by = ${filter.assessorId}::uuid`);
    smpCond.push(sql`s.assessor_id = ${filter.assessorId}::uuid`);
  }
  return (await client.execute(sql`
    with acc as (
      select e.reviewed_by as a, count(*)::int as n from appr_evidence e
      where ${sql.join(accCond, sql` and `)} group by e.reviewed_by),
    smp as (
      select s.assessor_id as a, count(*)::int as sampled,
        (count(*) filter (where e.status = 'ACCEPTED'))::int as sampled_accepted,
        (count(*) filter (where s.outcome = 'PENDING'))::int as pending,
        (count(*) filter (where s.outcome = 'AGREE'))::int as agree,
        (count(*) filter (where s.outcome = 'DISAGREE'))::int as disagree,
        (count(*) filter (where s.outcome <> 'PENDING' and s.acknowledged_at is null))::int as awaiting_ack
      from appr_iqa_sample s join appr_evidence e on e.id = s.evidence_id
      where ${sql.join(smpCond, sql` and `)} group by s.assessor_id)
    select coalesce(acc.a, smp.a) as "assessorId",
      (select coalesce(nullif(u.name, ''), p.fullname) from profile p left join "user" u on u.id = p.id where p.id = coalesce(acc.a, smp.a)) as name,
      coalesce(acc.n, 0) as accepted, coalesce(smp.sampled, 0) as sampled,
      coalesce(smp.sampled_accepted, 0) as "sampledAccepted", coalesce(smp.pending, 0) as pending,
      coalesce(smp.agree, 0) as agree, coalesce(smp.disagree, 0) as disagree, coalesce(smp.awaiting_ack, 0) as "awaitingAck"
    from acc full join smp on smp.a = acc.a
    order by name nulls last, "assessorId"`)) as unknown as IqaAssessorCoverageRow[];
}

export interface IqaUnitCoverageRow {
  unitId: string;
  unitTitle: string;
  unitRef: string | null;
  programmeId: string;
  programmeTitle: string;
  accepted: number;
  sampled: number;
}

/** Per unit that has accepted evidence: distinct ACCEPTED evidence mapped to one of its criteria vs how much is sampled. */
export async function listIqaUnitCoverage(
  organizationId: string,
  filter: Pick<IqaFilter, 'programmeId'>,
  client: DbOrTxClient = db
): Promise<IqaUnitCoverageRow[]> {
  const programmeCond = filter.programmeId ? sql`and e.programme_id = ${filter.programmeId}::uuid` : sql``;
  return (await client.execute(sql`
    with ue as (
      select distinct c.unit_id, ec.evidence_id
      from appr_evidence_criterion ec
      join appr_criterion c on c.id = ec.criterion_id
      join appr_evidence e on e.id = ec.evidence_id
      where e.organization_id = ${organizationId}::uuid and e.status = 'ACCEPTED' ${programmeCond})
    select un.id as "unitId", un.title as "unitTitle", un.code as "unitRef", pr.id as "programmeId", pr.title as "programmeTitle",
      count(*)::int as accepted,
      (count(*) filter (where exists (select 1 from appr_iqa_sample x where x.evidence_id = ue.evidence_id)))::int as sampled
    from ue
    join appr_unit un on un.id = ue.unit_id
    join appr_qualification q on q.id = un.qualification_id
    join appr_programme pr on pr.id = q.programme_id
    group by un.id, un.title, un.code, un.sort, pr.id, pr.title, q.sort
    order by pr.title, q.sort, un.sort, un.title`)) as unknown as IqaUnitCoverageRow[];
}

// ── Suggest ──

export interface IqaCandidate {
  evidenceId: string;
  enrolmentId: string;
  assessorId: string;
  assessorName: string | null;
  evidenceTitle: string;
  evidenceStatus: string;
  evidenceTypeKey: string;
  programmeId: string;
  programmeTitle: string;
  learnerId: string;
  learnerName: string | null;
}

/**
 * Random unsampled ACCEPTED evidence: up to `n` per assessor (`quotas`), the whole set in random order capped at `max`.
 * Evidence whose learner has no enrolment is skipped (a sample belongs to an enrolment).
 */
export async function pickIqaCandidates(
  organizationId: string,
  quotas: { assessorId: string; n: number }[],
  filter: Pick<IqaFilter, 'programmeId'>,
  max: number,
  client: DbOrTxClient = db
): Promise<IqaCandidate[]> {
  const wanted = quotas.filter((q) => q.n > 0);
  if (wanted.length === 0 || max <= 0) return [];
  const programmeCond = filter.programmeId ? sql`and e.programme_id = ${filter.programmeId}::uuid` : sql``;
  const json = JSON.stringify(wanted.map((q) => ({ a: q.assessorId, n: q.n })));
  return (await client.execute(sql`
    select c."evidenceId", c."enrolmentId", c."assessorId", c."assessorName", c."evidenceTitle", c."evidenceStatus",
      c."evidenceTypeKey", c."programmeId", c."programmeTitle", c."learnerId", c."learnerName" from (
      select e.id as "evidenceId", en.id as "enrolmentId", e.reviewed_by as "assessorId", ${nameOf('e.reviewed_by')} as "assessorName",
        e.title as "evidenceTitle", e.status as "evidenceStatus", e.type_key as "evidenceTypeKey",
        e.programme_id as "programmeId", pr.title as "programmeTitle", e.learner_id as "learnerId", ${nameOf('e.learner_id')} as "learnerName",
        x.n, row_number() over (partition by e.reviewed_by order by random()) as rn
      from appr_evidence e
      join appr_programme pr on pr.id = e.programme_id
      join appr_enrolment en on en.programme_id = e.programme_id and en.learner_id = e.learner_id
      join jsonb_to_recordset(${json}::jsonb) as x(a uuid, n int) on x.a = e.reviewed_by
      where e.organization_id = ${organizationId}::uuid and e.status = 'ACCEPTED' ${programmeCond}
        and not exists (select 1 from appr_iqa_sample ex where ex.evidence_id = e.id)) c
    where c.rn <= c.n
    order by random()
    limit ${max}`)) as unknown as IqaCandidate[];
}

/**
 * Confirming a previewed suggestion: the given evidence ids that are STILL eligible (this org, ACCEPTED, has a reviewer
 * and an enrolment, not yet sampled, inside the same programme/assessor filters). Ineligible ids are silently dropped.
 */
export async function getIqaCandidatesByIds(
  organizationId: string,
  evidenceIds: string[],
  filter: Pick<IqaFilter, 'programmeId' | 'assessorId'>,
  client: DbOrTxClient = db
): Promise<IqaCandidate[]> {
  if (evidenceIds.length === 0) return [];
  const ids = sql.join(
    evidenceIds.map((i) => sql`${i}::uuid`),
    sql`, `
  );
  const programmeCond = filter.programmeId ? sql`and e.programme_id = ${filter.programmeId}::uuid` : sql``;
  const assessorCond = filter.assessorId ? sql`and e.reviewed_by = ${filter.assessorId}::uuid` : sql``;
  return (await client.execute(sql`
    select distinct on (e.id) e.id as "evidenceId", en.id as "enrolmentId", e.reviewed_by as "assessorId",
      ${nameOf('e.reviewed_by')} as "assessorName", e.title as "evidenceTitle", e.status as "evidenceStatus",
      e.type_key as "evidenceTypeKey", e.programme_id as "programmeId", pr.title as "programmeTitle",
      e.learner_id as "learnerId", ${nameOf('e.learner_id')} as "learnerName"
    from appr_evidence e
    join appr_programme pr on pr.id = e.programme_id
    join appr_enrolment en on en.programme_id = e.programme_id and en.learner_id = e.learner_id
    where e.organization_id = ${organizationId}::uuid and e.id in (${ids})
      and e.status = 'ACCEPTED' and e.reviewed_by is not null ${programmeCond} ${assessorCond}
      and not exists (select 1 from appr_iqa_sample ex where ex.evidence_id = e.id)
    order by e.id`)) as unknown as IqaCandidate[];
}
