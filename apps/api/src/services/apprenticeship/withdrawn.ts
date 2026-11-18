// Gecko Apprenticeships — withdrawn halves, pure rules (migration 0038). No imports: shared by the learners list, the
// summary, the portfolio, the overview and the progress builder so they can never disagree.
//
//   CLOSED apprenticeship  = every half is withdrawn (a lone enrolment, or both halves of a pair). Read-only, hidden from
//                            the default lists, out of every scan. Its frozen numbers still count for display.
//   A withdrawn half of a pair whose other half is ACTIVE is excluded from the roll-up, the gateway unit count and the
//   learner-level evidence totals; its units stay frozen and its mappings are kept.

export interface CountedHalves {
  /** The enrolment's own (carrier / standalone) numbers count. */
  own: boolean;
  /** The linked component's numbers count. */
  linked: boolean;
  /** Every half is withdrawn. */
  closed: boolean;
}

/** `linkedWithdrawn` is null when there is no component. */
export function countedHalves(ownWithdrawn: boolean, linkedWithdrawn: boolean | null): CountedHalves {
  const closed = ownWithdrawn && (linkedWithdrawn === null || linkedWithdrawn);

  return {
    own: closed || !ownWithdrawn,
    linked: linkedWithdrawn !== null && (closed || !linkedWithdrawn),
    closed
  };
}
