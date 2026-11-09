<script lang="ts">
  import type { ReviewSnapshot } from '../../api/reviews.svelte';
  import ProgressBar from '../shared/progress-bar.svelte';
  import StatusChip from '../shared/status-chip.svelte';
  import { fmtDate, fmtMinutes, fmtPct } from '../shared/format';

  // Read-only progress snapshot for a review: actual vs expected, off-the-job hours and a units summary. For an open
  // review it is the learner's live position; for a completed one it is what was captured when the last signature
  // went on. All numbers are the API's, shown as given.

  interface Props {
    snapshot: ReviewSnapshot;
    /** True when this is the frozen snapshot of a completed review. */
    captured?: boolean;
  }
  let { snapshot, captured = false }: Props = $props();

  const otj = $derived(snapshot.otj);
</script>

<section class="space-y-3 rounded-lg border bg-(--muted)/30 p-3" aria-label="Progress snapshot">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="text-sm font-semibold">Progress snapshot</h3>
    <span class="text-xs text-(--muted-foreground)">
      {captured && snapshot.capturedAt
        ? `Captured ${fmtDate(snapshot.capturedAt)}`
        : 'Live — updates until the review is complete'}
    </span>
  </div>
  <div class="grid gap-3 md:grid-cols-2">
    <div class="space-y-1">
      <div class="flex justify-between text-sm">
        <span class="font-medium">Qualification</span>
        <span>{fmtPct(snapshot.actualPct)} · expected {fmtPct(snapshot.expectedPct)}</span>
      </div>
      <ProgressBar
        actual={snapshot.actualPct ?? null}
        expected={snapshot.expectedPct ?? null}
        label="Qualification progress"
      />
    </div>
    {#if otj}
      <div class="space-y-1">
        <div class="flex justify-between text-sm">
          <span class="font-medium">Off-the-job</span>
          <span
            >{fmtMinutes(otj.minutes)} of {fmtMinutes(otj.targetMinutes)} · expected {fmtMinutes(
              otj.expectedMinutes
            )}</span
          >
        </div>
        <ProgressBar
          actual={otj.targetMinutes ? Math.floor((otj.minutes / otj.targetMinutes) * 100) : null}
          expected={otj.targetMinutes && otj.expectedMinutes !== null && otj.expectedMinutes !== undefined
            ? Math.round((otj.expectedMinutes / otj.targetMinutes) * 100)
            : null}
          label="Off-the-job hours"
        />
      </div>
    {/if}
  </div>
  <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
    {#if snapshot.status}<span class="inline-flex items-center gap-1.5"
        >Status <StatusChip status={snapshot.status} /></span
      >{/if}
    {#if snapshot.units}
      <span>Units: <strong>{snapshot.units.complete}</strong> of {snapshot.units.total} complete</span>
    {/if}
    {#if snapshot.counts}
      <span class="text-(--muted-foreground)">
        Evidence: {snapshot.counts.accepted} accepted · {snapshot.counts.submitted} to mark · {snapshot.counts.referred}
        referred
      </span>
    {/if}
  </div>
</section>
