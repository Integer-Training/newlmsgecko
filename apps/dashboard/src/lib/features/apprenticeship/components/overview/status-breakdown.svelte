<script lang="ts">
  import type { OverviewBreakdown } from '../../api/overview.types';

  // Three "status breakdown" cards (tasks, evidence, off-the-job logs). Stacked bars, no chart library, so nothing here
  // can enter the SSR module graph. Counts are the API's.
  interface Props {
    breakdown: OverviewBreakdown;
  }
  let { breakdown }: Props = $props();

  interface Segment {
    key: string;
    label: string;
    value: number;
    color: string;
  }
  interface CardDef {
    key: string;
    title: string;
    segments: Segment[];
    note?: string;
  }

  const cards = $derived<CardDef[]>([
    {
      key: 'tasks',
      title: 'Tasks',
      segments: [
        { key: 'planned', label: 'Planned', value: breakdown.tasks.PLANNED, color: '#64748b' },
        { key: 'submitted', label: 'Submitted', value: breakdown.tasks.SUBMITTED, color: '#f59e0b' },
        { key: 'referred', label: 'Referred', value: breakdown.tasks.REFERRED, color: '#e11d48' },
        { key: 'complete', label: 'Complete', value: breakdown.tasks.COMPLETE, color: '#16a34a' }
      ],
      note: breakdown.tasks.overdue > 0 ? `${breakdown.tasks.overdue} overdue` : undefined
    },
    {
      key: 'evidence',
      title: 'Evidence',
      segments: [
        { key: 'submitted', label: 'To mark', value: breakdown.evidence.SUBMITTED, color: '#f59e0b' },
        { key: 'accepted', label: 'Accepted', value: breakdown.evidence.ACCEPTED, color: '#16a34a' },
        { key: 'referred', label: 'Referred', value: breakdown.evidence.REFERRED, color: '#e11d48' }
      ]
    },
    {
      key: 'otj',
      title: 'Off-the-job progress',
      segments: [
        { key: 'submitted', label: 'Submitted', value: breakdown.otj.SUBMITTED, color: '#f59e0b' },
        { key: 'validated', label: 'Validated', value: breakdown.otj.VALIDATED, color: '#16a34a' },
        { key: 'rejected', label: 'Rejected', value: breakdown.otj.REJECTED, color: '#e11d48' }
      ]
    }
  ]);
</script>

<div class="grid gap-3 md:grid-cols-3">
  {#each cards as card (card.key)}
    {@const total = card.segments.reduce((n, s) => n + s.value, 0)}
    <section class="rounded-lg border bg-(--card) p-4" aria-label="{card.title} status breakdown">
      <div class="flex items-baseline justify-between gap-2">
        <h3 class="text-sm font-semibold">{card.title} status breakdown</h3>
        <span class="text-2xl font-semibold tabular-nums">{total}</span>
      </div>
      <div
        class="mt-3 flex h-3 w-full overflow-hidden rounded-full"
        style="background-color: var(--muted)"
        role="img"
        aria-label={total === 0
          ? 'None yet'
          : card.segments
              .filter((s) => s.value > 0)
              .map((s) => `${s.value} ${s.label.toLowerCase()}`)
              .join(', ')}
      >
        {#if total > 0}
          {#each card.segments.filter((s) => s.value > 0) as s (s.key)}
            <div
              style="width: {(s.value / total) * 100}%; background-color: {s.color}"
              title="{s.label}: {s.value}"
            ></div>
          {/each}
        {/if}
      </div>
      {#if total === 0}
        <p class="mt-3 text-sm text-(--muted-foreground)">Nothing recorded yet.</p>
      {:else}
        <ul class="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          {#each card.segments as s (s.key)}
            <li class="flex items-center justify-between gap-2 {s.value === 0 ? 'text-(--muted-foreground)' : ''}">
              <span class="flex items-center gap-1.5">
                <span class="size-2.5 rounded-sm" style="background-color: {s.color}" aria-hidden="true"></span>
                {s.label}
              </span>
              <strong class="tabular-nums">{s.value}</strong>
            </li>
          {/each}
        </ul>
      {/if}
      {#if card.note}<p class="mt-2 text-xs font-medium text-rose-600">{card.note}</p>{/if}
    </section>
  {/each}
</div>
