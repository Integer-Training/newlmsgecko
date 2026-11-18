<script lang="ts">
  import { Button } from '@cio/ui/base/button';
  import type { OtjSummary } from '../../api/otj.svelte';
  import StatusChip from '../shared/status-chip.svelte';
  import { fmtHoursMinutes } from '../shared/format';

  // Off-the-job training progress overview: Current / Expected / Required, the overall completion bar and the
  // status. Every number is the API's; nothing is recomputed here.

  interface Props {
    summary: OtjSummary;
    isAdmin: boolean;
    onEditHours: () => void;
  }
  let { summary, isAdmin, onEditHours }: Props = $props();

  const pct = $derived(summary.completionPct ?? 0);
  const source = $derived(
    summary.source === 'OVERRIDE'
      ? 'Manual override'
      : summary.source === 'CALCULATED'
        ? `Calculated from ${summary.contractedHoursWeek ?? '—'} contracted hours a week`
        : 'Not set. Add contracted hours or an override.'
  );
</script>

<section class="space-y-4 rounded-lg border p-4" aria-label="Off-the-job training progress overview">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="font-semibold">Off-the-job training progress overview</h3>
    <div class="flex items-center gap-2">
      <StatusChip status={summary.status} />
      {#if isAdmin}
        <Button variant="outline" size="sm" onclick={onEditHours}>Edit hours</Button>
      {/if}
    </div>
  </div>

  <dl class="grid grid-cols-1 gap-3 sm:grid-cols-3">
    <div class="rounded-lg border p-3">
      <dt class="text-xs text-(--muted-foreground)">Current</dt>
      <dd class="text-lg font-semibold">{fmtHoursMinutes(summary.doneMinutes)}</dd>
    </div>
    <div class="rounded-lg border p-3">
      <dt class="text-xs text-(--muted-foreground)">Expected</dt>
      <dd class="text-lg font-semibold">
        {summary.expectedMinutes === null ? '—' : fmtHoursMinutes(summary.expectedMinutes)}
      </dd>
    </div>
    <div class="rounded-lg border p-3">
      <dt class="text-xs text-(--muted-foreground)">Required</dt>
      <dd class="text-lg font-semibold">
        {summary.targetMinutes === null ? 'Not set' : fmtHoursMinutes(summary.targetMinutes)}
      </dd>
    </div>
  </dl>

  <div class="space-y-1">
    <div class="flex justify-between text-sm">
      <span>Overall completion</span>
      <span class="font-medium">{summary.completionPct === null ? '—' : `${summary.completionPct}%`}</span>
    </div>
    <div
      class="h-2 w-full rounded-full"
      style="background-color: var(--muted)"
      role="progressbar"
      aria-label="Overall completion"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div class="h-full rounded-full transition-all" style="width: {pct}%; background-color: var(--primary)"></div>
    </div>
  </div>
  <p class="text-xs text-(--muted-foreground)">{source}</p>
</section>
