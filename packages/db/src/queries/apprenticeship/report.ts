import * as schema from '@db/schema';

import { and, asc, db, eq, sql, type DbOrTxClient } from '@db/drizzle';

// Gecko Apprenticeships — the PDF portfolio report. No access control here: the service resolves the enrolment first.

/**
 * Every evidence piece of one learner/programme for the report, oldest first: type label, creator / reviewer names,
 * the codes of the criteria it is mapped to and the file NAMES (never keys or URLs). One statement.
 */
export async function listEvidenceForReport(
  organizationId: string,
  programmeId: string,
  learnerId: string,
  client: DbOrTxClient = db
) {
  const ev = schema.apprEvidence;
  return client
    .select({
      id: ev.id,
      title: ev.title,
      typeLabel: sql<string>`coalesce(${schema.apprEvidenceType.label}, ${ev.typeKey})`,
      status: ev.status,
      minutes: ev.minutes,
      includeOtj: ev.includeOtj,
      createdAt: ev.createdAt,
      reviewedAt: ev.reviewedAt,
      reviewedByName: sql<
        string | null
      >`(select coalesce(nullif(ru.name, ''), rp.fullname) from profile rp left join "user" ru on ru.id = rp.id where rp.id = ${ev.reviewedBy})`,
      criteriaRefs: sql<
        string[]
      >`coalesce((select array_agg(c.code order by c.code) from appr_evidence_criterion ec join appr_criterion c on c.id = ec.criterion_id where ec.evidence_id = ${sql.raw('"appr_evidence"."id"')}), '{}')`,
      fileNames: sql<string[]>`coalesce((select array_agg(f->>'name') from jsonb_array_elements(${ev.files}) f), '{}')`
    })
    .from(ev)
    .leftJoin(
      schema.apprEvidenceType,
      and(eq(schema.apprEvidenceType.organizationId, organizationId), eq(schema.apprEvidenceType.key, ev.typeKey))
    )
    .where(and(eq(ev.programmeId, programmeId), eq(ev.learnerId, learnerId)))
    .orderBy(asc(ev.createdAt), asc(ev.id));
}
