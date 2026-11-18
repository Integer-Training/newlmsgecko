import * as schema from '@db/schema';

import { and, eq, sql, type DbOrTxClient, type SQL } from '@db/drizzle';

// Gecko Apprenticeships — withdrawn state (migration 0038). An apprenticeship is CLOSED (read-only, out of every scan,
// summary and default list) when its carrier is withdrawn AND no component is still active: a standalone withdrawn
// enrolment, or a pair whose halves are both withdrawn. A withdrawn half of a pair whose other half is active is NOT
// closed: that half is just frozen and excluded from the roll-up.

/** SQL: true when the apprenticeship of the CARRIER whose id is `carrierExpr` is closed. */
function closedCarrierSql(carrierExpr: string): SQL {
  return sql.raw(
    `exists (select 1 from appr_enrolment ck where ck.id = ${carrierExpr} and ck.withdrawn_at is not null ` +
      `and not exists (select 1 from appr_enrolment cc where cc.primary_enrolment_id = ck.id and cc.withdrawn_at is null))`
  );
}

/** SQL: the apprenticeship that enrolment `enrolmentIdCol` (a raw qualified column, either half) belongs to is closed. */
export function apprenticeshipClosedSql(enrolmentIdCol: string): SQL {
  return closedCarrierSql(
    `coalesce((select ex.primary_enrolment_id from appr_enrolment ex where ex.id = ${enrolmentIdCol}), ${enrolmentIdCol})`
  );
}

/** SQL: like apprenticeshipClosedSql, for rows keyed by learner + programme (evidence, tasks) instead of enrolment id. */
export function apprenticeshipClosedByLearnerSql(learnerCol: string, programmeCol: string): SQL {
  return closedCarrierSql(
    `(select coalesce(ex.primary_enrolment_id, ex.id) from appr_enrolment ex where ex.learner_id = ${learnerCol} and ex.programme_id = ${programmeCol} limit 1)`
  );
}

/** Mark an enrolment withdrawn. */
export async function setApprEnrolmentWithdrawn(
  tx: DbOrTxClient,
  enrolmentId: string,
  by: { userId: string; reason: string; at: string }
) {
  await tx
    .update(schema.apprEnrolment)
    .set({ withdrawnAt: by.at, withdrawnBy: by.userId, withdrawalReason: by.reason })
    .where(eq(schema.apprEnrolment.id, enrolmentId));
}

/** Clear the withdrawn columns. False when the enrolment was not withdrawn. */
export async function clearApprEnrolmentWithdrawn(tx: DbOrTxClient, enrolmentId: string) {
  const rows = await tx
    .update(schema.apprEnrolment)
    .set({ withdrawnAt: null, withdrawnBy: null, withdrawalReason: null })
    .where(and(eq(schema.apprEnrolment.id, enrolmentId), sql`${schema.apprEnrolment.withdrawnAt} is not null`))
    .returning({ id: schema.apprEnrolment.id });
  return rows.length > 0;
}
