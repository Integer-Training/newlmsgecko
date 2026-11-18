import type { TxClient } from '@cio/db/drizzle';
import { getLinkedEnrolment, lockApprEnrolment } from '@cio/db/queries/apprenticeship';

// Gecko Apprenticeships — the ONE lock order for a linked Diploma + Standard pair. Kept in its own module (no service
// imports) so progress, evidence, OTJ and link/unlink all share it and it can be unit-tested on its own.

/**
 * Row-lock enrolments in ONE global order (ascending id). Every transaction that touches a linked pair's caches takes its
 * locks through here (or through lockApprenticeshipPair), so two concurrent writers on the same pair can never hold the
 * locks in opposite order and deadlock. Re-locking a row the transaction already holds is a no-op.
 */
export async function lockEnrolmentsInOrder(tx: TxClient, ids: string[]) {
  const rows = [];
  for (const id of [...new Set(ids)].sort()) rows.push(await lockApprEnrolment(tx, id));
  return rows;
}

/**
 * Lock BOTH halves of the apprenticeship that `enrolmentId` belongs to (carrier + component, id order), or just the enrolment
 * when it is standalone. Call this FIRST in every OTJ / evidence transaction — before locking any log or evidence row —
 * so the lock order is always enrolments (by id) then the row being changed. recomputeEnrolment re-locks the same rows
 * in the same order afterwards, which is a no-op. Returns the locked carrier / component rows (null when absent).
 */
export async function lockApprenticeshipPair(tx: TxClient, enrolmentId: string) {
  const linked = await getLinkedEnrolment(enrolmentId, tx);
  const rows = await lockEnrolmentsInOrder(tx, linked ? [enrolmentId, linked.id] : [enrolmentId]);
  const live = rows.filter((r): r is NonNullable<typeof r> => !!r);
  const carrier = live.find((r) => !r.primaryEnrolmentId) ?? null;
  const component = live.find((r) => !!r.primaryEnrolmentId) ?? null;
  return { carrier, component };
}
