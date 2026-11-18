import * as schema from '@db/schema';

import { and, asc, db, desc, eq, inArray, or, sql, type DbOrTxClient, type SQL } from '@db/drizzle';
import { tutorReachSql, tutorsDisplaySql } from './tutors';
import { profileDisplayName } from './names';

// Gecko Apprenticeships — evidence reads/writes. No access control here: services resolve the actor and the enrolment
// first. Writes take the transaction client so the status/mapping change and the progress recompute land together.

export type ApprEvidenceRow = typeof schema.apprEvidence.$inferSelect;
export type ApprEvidenceFile = ApprEvidenceRow['files'][number];

const criteriaCountOf = sql<number>`(select count(*) from appr_evidence_criterion ec where ec.evidence_id = ${sql.raw('"appr_evidence"."id"')})::int`;
const fileCountOf = sql<number>`jsonb_array_length(${schema.apprEvidence.files})::int`;

export async function getApprEvidence(evidenceId: string, client: DbOrTxClient = db) {
  const [row] = await client.select().from(schema.apprEvidence).where(eq(schema.apprEvidence.id, evidenceId)).limit(1);
  return row ?? null;
}

/**
 * The Evidence tab of one learner: one statement, type label + creator name joined. `programmeIds` is the enrolment's
 * programme, plus its linked counterpart's for a Diploma + Standard pair (evidence homed on either half is listed).
 */
export async function listEvidenceForLearner(
  organizationId: string,
  programmeIds: string[],
  learnerId: string,
  filter: { status?: string; typeKey?: string },
  client: DbOrTxClient = db
) {
  const ev = schema.apprEvidence;
  const conditions: (SQL | undefined)[] = [inArray(ev.programmeId, programmeIds), eq(ev.learnerId, learnerId)];
  if (filter.status) conditions.push(eq(ev.status, filter.status));
  if (filter.typeKey) conditions.push(eq(ev.typeKey, filter.typeKey));
  return client
    .select({
      id: ev.id,
      /** The evidence's HOME programme (the service maps it to the home enrolment). */
      homeProgrammeId: ev.programmeId,
      title: ev.title,
      typeKey: ev.typeKey,
      typeLabel: schema.apprEvidenceType.label,
      status: ev.status,
      minutes: ev.minutes,
      includeOtj: ev.includeOtj,
      createdAt: ev.createdAt,
      createdBy: ev.createdBy,
      createdByName: profileDisplayName,
      reviewedBy: ev.reviewedBy,
      reviewedByName: sql<
        string | null
      >`(select coalesce(nullif(ru.name, ''), rp.fullname) from profile rp left join "user" ru on ru.id = rp.id where rp.id = ${ev.reviewedBy})`,
      reviewedAt: ev.reviewedAt,
      criteriaCount: criteriaCountOf,
      fileCount: fileCountOf
    })
    .from(ev)
    .leftJoin(
      schema.apprEvidenceType,
      and(eq(schema.apprEvidenceType.organizationId, organizationId), eq(schema.apprEvidenceType.key, ev.typeKey))
    )
    .leftJoin(schema.profile, eq(schema.profile.id, ev.createdBy))
    .where(and(...conditions))
    .orderBy(desc(ev.createdAt));
}

/**
 * Which programmes (and criterion codes) each of these evidence rows is mapped to, in programme display order. Feeds the
 * "Also counts towards..." / "From Diploma|Standard" chips for a linked pair. Evidence with no mapping is absent.
 */
export async function listEvidenceMappings(evidenceIds: string[], client: DbOrTxClient = db) {
  if (evidenceIds.length === 0) return [];
  return client
    .select({
      evidenceId: schema.apprEvidenceCriterion.evidenceId,
      programmeId: schema.apprProgramme.id,
      programmeTitle: schema.apprProgramme.title,
      programmeType: schema.apprProgramme.type,
      code: schema.apprCriterion.code
    })
    .from(schema.apprEvidenceCriterion)
    .innerJoin(schema.apprCriterion, eq(schema.apprCriterion.id, schema.apprEvidenceCriterion.criterionId))
    .innerJoin(schema.apprUnit, eq(schema.apprUnit.id, schema.apprCriterion.unitId))
    .innerJoin(schema.apprQualification, eq(schema.apprQualification.id, schema.apprUnit.qualificationId))
    .innerJoin(schema.apprProgramme, eq(schema.apprProgramme.id, schema.apprQualification.programmeId))
    .where(inArray(schema.apprEvidenceCriterion.evidenceId, evidenceIds))
    .orderBy(
      asc(schema.apprQualification.sort),
      asc(schema.apprUnit.sort),
      asc(schema.apprCriterion.sort),
      asc(schema.apprCriterion.createdAt)
    );
}

/** Which of these criterion ids belong to the programme (chain join). Callers compare lengths to reject foreign ids. */
export async function filterCriterionIdsInProgramme(
  programmeId: string,
  criterionIds: string[],
  client: DbOrTxClient = db
): Promise<string[]> {
  if (criterionIds.length === 0) return [];
  const rows = await client
    .select({ id: schema.apprCriterion.id })
    .from(schema.apprCriterion)
    .innerJoin(schema.apprUnit, eq(schema.apprUnit.id, schema.apprCriterion.unitId))
    .innerJoin(schema.apprQualification, eq(schema.apprQualification.id, schema.apprUnit.qualificationId))
    .where(and(eq(schema.apprQualification.programmeId, programmeId), inArray(schema.apprCriterion.id, criterionIds)));
  return rows.map((r) => r.id);
}

export async function insertApprEvidence(tx: DbOrTxClient, values: typeof schema.apprEvidence.$inferInsert) {
  const [row] = await tx.insert(schema.apprEvidence).values(values).returning();
  return row;
}

/**
 * Update an evidence row. With `expectedStatus` the update only applies if the row is still in that status (a
 * concurrent review makes this return null instead of silently overwriting). Always bumps updatedAt.
 */
export async function updateApprEvidence(
  tx: DbOrTxClient,
  evidenceId: string,
  patch: Partial<
    Pick<
      ApprEvidenceRow,
      | 'title'
      | 'details'
      | 'typeKey'
      | 'minutes'
      | 'includeOtj'
      | 'status'
      | 'files'
      | 'reviewedBy'
      | 'reviewedAt'
      | 'taskId'
    >
  >,
  expectedStatus?: string
) {
  const [row] = await tx
    .update(schema.apprEvidence)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(
      expectedStatus
        ? and(eq(schema.apprEvidence.id, evidenceId), eq(schema.apprEvidence.status, expectedStatus))
        : eq(schema.apprEvidence.id, evidenceId)
    )
    .returning();
  return row ?? null;
}

/** Replace the whole evidence→criterion set (the review's confirmed mapping / an edit). */
export async function replaceEvidenceCriteria(
  tx: DbOrTxClient,
  evidenceId: string,
  criterionIds: string[],
  source: 'LEARNER' | 'STAFF'
) {
  await tx.delete(schema.apprEvidenceCriterion).where(eq(schema.apprEvidenceCriterion.evidenceId, evidenceId));
  if (criterionIds.length === 0) return;
  await tx
    .insert(schema.apprEvidenceCriterion)
    .values(criterionIds.map((criterionId) => ({ evidenceId, criterionId, source })));
}

export async function insertEvidenceNote(
  tx: DbOrTxClient,
  note: { evidenceId: string; authorId: string | null; kind: string; body: string; statusAtTime: string | null }
) {
  const [row] = await tx.insert(schema.apprEvidenceNote).values(note).returning();
  return row;
}

/** Mapped criteria with their unit + qualification, in programme display order (the detail screen groups these). */
export async function listEvidenceCriteriaDetail(evidenceId: string, client: DbOrTxClient = db) {
  return client
    .select({
      criterionId: schema.apprCriterion.id,
      code: schema.apprCriterion.code,
      text: schema.apprCriterion.text,
      groupLabel: schema.apprCriterion.groupLabel,
      source: schema.apprEvidenceCriterion.source,
      unitId: schema.apprUnit.id,
      unitCode: schema.apprUnit.code,
      unitTitle: schema.apprUnit.title,
      qualificationId: schema.apprQualification.id,
      qualificationTitle: schema.apprQualification.title,
      programmeId: schema.apprQualification.programmeId,
      programmeType: schema.apprProgramme.type
    })
    .from(schema.apprEvidenceCriterion)
    .innerJoin(schema.apprCriterion, eq(schema.apprCriterion.id, schema.apprEvidenceCriterion.criterionId))
    .innerJoin(schema.apprUnit, eq(schema.apprUnit.id, schema.apprCriterion.unitId))
    .innerJoin(schema.apprQualification, eq(schema.apprQualification.id, schema.apprUnit.qualificationId))
    .innerJoin(schema.apprProgramme, eq(schema.apprProgramme.id, schema.apprQualification.programmeId))
    .where(eq(schema.apprEvidenceCriterion.evidenceId, evidenceId))
    .orderBy(
      asc(schema.apprQualification.sort),
      asc(schema.apprUnit.sort),
      asc(schema.apprCriterion.sort),
      asc(schema.apprCriterion.createdAt)
    );
}

export async function listEvidenceNotes(evidenceId: string, client: DbOrTxClient = db) {
  const n = schema.apprEvidenceNote;
  return client
    .select({
      id: n.id,
      authorId: n.authorId,
      authorName: profileDisplayName,
      kind: n.kind,
      body: n.body,
      statusAtTime: n.statusAtTime,
      createdAt: n.createdAt
    })
    .from(n)
    .leftJoin(schema.profile, eq(schema.profile.id, n.authorId))
    .where(eq(n.evidenceId, evidenceId))
    .orderBy(asc(n.createdAt));
}

export async function getProfileName(profileId: string, client: DbOrTxClient = db): Promise<string | null> {
  const [row] = await client
    .select({ name: profileDisplayName })
    .from(schema.profile)
    .where(eq(schema.profile.id, profileId))
    .limit(1);
  return row?.name ?? null;
}

/**
 * The "List evidence" popover: every piece of the learner mapped to one criterion, whichever programme of a linked pair
 * it is homed on (the criterion's own programme decides whose it is; the evidence's home programme is returned).
 */
export async function listEvidenceForCriterion(
  programmeId: string,
  learnerId: string,
  criterionId: string,
  client: DbOrTxClient = db
) {
  const ev = schema.apprEvidence;
  return client
    .select({
      id: ev.id,
      homeProgrammeId: ev.programmeId,
      title: ev.title,
      snippet: sql<string>`left(${ev.details}, 200)`,
      status: ev.status,
      fileCount: fileCountOf,
      createdAt: ev.createdAt
    })
    .from(schema.apprEvidenceCriterion)
    .innerJoin(ev, eq(ev.id, schema.apprEvidenceCriterion.evidenceId))
    .innerJoin(schema.apprCriterion, eq(schema.apprCriterion.id, schema.apprEvidenceCriterion.criterionId))
    .innerJoin(schema.apprUnit, eq(schema.apprUnit.id, schema.apprCriterion.unitId))
    .innerJoin(schema.apprQualification, eq(schema.apprQualification.id, schema.apprUnit.qualificationId))
    .where(
      and(
        eq(schema.apprEvidenceCriterion.criterionId, criterionId),
        eq(schema.apprQualification.programmeId, programmeId),
        eq(ev.learnerId, learnerId)
      )
    )
    .orderBy(desc(ev.createdAt));
}

/** How many tasks (of these enrolments) target one criterion: the Tasks tile of the criterion popover. */
export async function countTasksForCriterion(enrolmentIds: string[], criterionId: string, client: DbOrTxClient = db) {
  if (enrolmentIds.length === 0) return 0;
  const [row] = await client
    .select({ n: sql<number>`count(distinct ${schema.apprTask.id})::int` })
    .from(schema.apprTaskCriterion)
    .innerJoin(schema.apprTask, eq(schema.apprTask.id, schema.apprTaskCriterion.taskId))
    .where(
      and(eq(schema.apprTaskCriterion.criterionId, criterionId), inArray(schema.apprTask.enrolmentId, enrolmentIds))
    );
  return row?.n ?? 0;
}

export interface ToMarkScope {
  organizationId: string;
  programmeId?: string;
  /** TUTOR actor: only rows this tutor reaches (named tutor or programme tutor). */
  restrictToTutorId?: string;
}

/** The marking queue: SUBMITTED evidence, oldest first, one page (+ total via a window count). */
export async function listToMark(
  scope: ToMarkScope,
  page: { limit: number; offset: number },
  client: DbOrTxClient = db
) {
  const ev = schema.apprEvidence;
  const conditions: (SQL | undefined)[] = [eq(ev.organizationId, scope.organizationId), eq(ev.status, 'SUBMITTED')];
  if (scope.programmeId) {
    // Home programme, or mapped to one of its criteria (evidence homed on the other half of a pair shows in both queues).
    conditions.push(
      or(
        eq(ev.programmeId, scope.programmeId),
        sql`exists (select 1 from appr_evidence_criterion mc join appr_criterion mcr on mcr.id = mc.criterion_id
          join appr_unit mu on mu.id = mcr.unit_id join appr_qualification mq on mq.id = mu.qualification_id
          where mc.evidence_id = ${ev.id} and mq.programme_id = ${scope.programmeId})`
      )
    );
  }
  if (scope.restrictToTutorId) {
    conditions.push(
      tutorReachSql('"appr_evidence"."learner_id"', '"appr_evidence"."programme_id"', scope.restrictToTutorId)
    );
  }
  return client
    .select({
      id: ev.id,
      title: ev.title,
      typeKey: ev.typeKey,
      typeLabel: schema.apprEvidenceType.label,
      createdAt: ev.createdAt,
      learnerId: ev.learnerId,
      learnerName: profileDisplayName,
      programmeId: ev.programmeId,
      programmeTitle: schema.apprProgramme.title,
      criteriaCount: criteriaCountOf,
      submittedAt: ev.updatedAt,
      taskId: ev.taskId,
      taskTitle: sql<string | null>`(select tt.title from appr_task tt where tt.id = ${ev.taskId})`,
      taskDueDate: sql<string | null>`(select tt.due_date from appr_task tt where tt.id = ${ev.taskId})`,
      tutors: tutorsDisplaySql(
        '"appr_evidence"."learner_id"',
        '"appr_evidence"."programme_id"',
        '"appr_evidence"."organization_id"'
      ),
      total: sql<number>`count(*) over()::int`
    })
    .from(ev)
    .innerJoin(schema.profile, eq(schema.profile.id, ev.learnerId))
    .innerJoin(schema.apprProgramme, eq(schema.apprProgramme.id, ev.programmeId))
    .leftJoin(
      schema.apprEvidenceType,
      and(eq(schema.apprEvidenceType.organizationId, ev.organizationId), eq(schema.apprEvidenceType.key, ev.typeKey))
    )
    .where(and(...conditions))
    .orderBy(asc(ev.createdAt), asc(ev.id))
    .limit(page.limit)
    .offset(page.offset);
}

/**
 * Notification deep links (one statement for a whole bell page): evidence id → its enrolment, title and the learner's
 * display name. Evidence whose enrolment is gone is simply absent (the bell falls back to the home page).
 */
export async function getEvidenceLinkTargets(evidenceIds: string[], client: DbOrTxClient = db) {
  const out = new Map<string, { enrolmentId: string; title: string; learnerName: string | null }>();
  if (evidenceIds.length === 0) return out;
  const ev = schema.apprEvidence;
  const rows = await client
    .select({ id: ev.id, title: ev.title, enrolmentId: schema.apprEnrolment.id, learnerName: profileDisplayName })
    .from(ev)
    .innerJoin(
      schema.apprEnrolment,
      and(eq(schema.apprEnrolment.programmeId, ev.programmeId), eq(schema.apprEnrolment.learnerId, ev.learnerId))
    )
    .leftJoin(schema.profile, eq(schema.profile.id, ev.learnerId))
    .where(inArray(ev.id, evidenceIds));
  for (const r of rows) out.set(r.id, { enrolmentId: r.enrolmentId, title: r.title, learnerName: r.learnerName });
  return out;
}
