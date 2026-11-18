<script lang="ts">
  import AwardIcon from '@lucide/svelte/icons/award';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import type { OverviewCard } from '../../api/overview.types';
  import ProgrammeTypeChip from '../shared/programme-type-chip.svelte';
  import { fmtDate } from '../shared/format';

  // "Achieved qualifications" — the enrolments with an `achievedAt` date. Collapsed by default.
  interface Props {
    cards: OverviewCard[];
  }
  let { cards }: Props = $props();

  let expanded = $state(false);
  const achieved = $derived(cards.filter((c) => c.achievedAt !== null));
</script>

<section class="overflow-hidden rounded-lg border bg-(--muted)/40" aria-label="Achieved qualifications">
  <button
    type="button"
    class="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
    aria-expanded={expanded}
    aria-controls="achieved-panel-body"
    onclick={() => (expanded = !expanded)}
  >
    <span>
      <span class="flex items-center gap-2 text-base font-semibold">
        <AwardIcon size={18} aria-hidden="true" /> Achieved qualifications
      </span>
      <span class="text-sm text-(--muted-foreground)"
        >{achieved.length} qualification{achieved.length === 1 ? '' : 's'}</span
      >
    </span>
    <ChevronDownIcon size={18} class="transition-transform {expanded ? 'rotate-180' : ''}" />
  </button>
  {#if expanded}
    <ul id="achieved-panel-body" class="divide-y border-t bg-(--card)">
      {#each achieved as c (c.enrolmentId)}
        <li class="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
          <span class="flex items-center gap-2 font-medium">{c.title} <ProgrammeTypeChip type={c.type} /></span>
          <span class="text-emerald-700 dark:text-emerald-400">Achieved {fmtDate(c.achievedAt)}</span>
        </li>
      {:else}
        <li class="px-4 py-3 text-sm text-(--muted-foreground)">Nothing achieved yet.</li>
      {/each}
    </ul>
  {/if}
</section>
