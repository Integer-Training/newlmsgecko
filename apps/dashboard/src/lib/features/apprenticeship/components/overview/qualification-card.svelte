<script lang="ts">
  import ArrowRightIcon from '@lucide/svelte/icons/circle-arrow-right';
  import AwardIcon from '@lucide/svelte/icons/award';
  import CalendarIcon from '@lucide/svelte/icons/calendar';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import ListChecksIcon from '@lucide/svelte/icons/list-checks';
  import type { OverviewCard } from '../../api/overview.types';
  import ProgrammeTypeChip from '../shared/programme-type-chip.svelte';
  import ProgressBar from '../shared/progress-bar.svelte';
  import StatusChip from '../shared/status-chip.svelte';
  import { fmtDate, fmtPct } from '../shared/format';

  // One qualification (enrolment) of the apprenticeship: type chip, dates, status, ACTUAL and EXPECTED bars, a "View"
  // link to the qualification page and a "Units x / y" expander whose rows open the unit page. Numbers are the API's.
  interface Props {
    card: OverviewCard;
    mode: 'staff' | 'learner';
    /** Qualification page. */
    href: string;
    /** Unit page for one unit of this qualification. */
    unitHref: (unitId: string) => string;
  }
  let { card, mode, href, unitHref }: Props = $props();

  let expanded = $state(false);
  const done = $derived(card.achievedAt !== null);
</script>

<section class="overflow-hidden rounded-lg border bg-(--card)" aria-label={card.title}>
  <div class="flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-4 py-3">
    <h3 class="flex min-w-48 flex-[1_1_16rem] items-center gap-2 text-base font-semibold">
      <AwardIcon size={18} class="shrink-0" aria-hidden="true" />
      <span class="min-w-0 break-words">{card.title}</span>
      <ProgrammeTypeChip type={card.type} />
    </h3>
    <p class="flex items-center gap-1.5 text-sm">
      <CalendarIcon size={14} aria-hidden="true" />
      <span class="font-medium">Start date</span>
      <span class="text-(--muted-foreground)">{fmtDate(card.startDate)}</span>
    </p>
    <p class="flex items-center gap-1.5 text-sm">
      <CalendarIcon size={14} aria-hidden="true" />
      <span class="font-medium">Anticipated finish</span>
      <span class="text-(--muted-foreground)">{fmtDate(card.plannedEndDate)}</span>
    </p>
    <p class="flex items-center gap-2 text-sm">
      <span class="font-medium">Status</span>
      <StatusChip status={done ? 'COMPLETE' : card.status} />
    </p>
  </div>

  <div class="flex flex-wrap items-center gap-4 px-4 py-4">
    <div class="grid min-w-64 flex-1 gap-4 md:grid-cols-2">
      <div class="space-y-1">
        <div class="flex justify-between text-xs text-(--muted-foreground) italic">
          <span>Actual</span><span class="font-medium text-(--foreground) not-italic">{fmtPct(card.actualPct)}</span>
        </div>
        <ProgressBar actual={card.actualPct} label="{card.title} actual progress" />
      </div>
      <div class="space-y-1">
        <div class="flex justify-between text-xs text-(--muted-foreground) italic">
          <span>Expected</span><span class="font-medium text-(--foreground) not-italic">{fmtPct(card.expectedPct)}</span
          >
        </div>
        <ProgressBar actual={card.expectedPct} label="{card.title} expected progress" />
      </div>
    </div>
    <a
      {href}
      class="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-(--muted)"
      aria-label="{mode === 'staff' ? 'View' : 'Open'} {card.title}"
    >
      View <ArrowRightIcon size={22} />
    </a>
  </div>

  <div class="border-t">
    <button
      type="button"
      class="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm hover:bg-(--muted)/50"
      aria-expanded={expanded}
      aria-controls="units-{card.enrolmentId}"
      onclick={() => (expanded = !expanded)}
    >
      <span class="flex items-center gap-2">
        <ListChecksIcon size={16} aria-hidden="true" />
        <strong>Units</strong>
        <span class="text-(--muted-foreground)">({card.unitsComplete} / {card.unitsTotal})</span>
      </span>
      <ChevronDownIcon size={16} class="transition-transform {expanded ? 'rotate-180' : ''}" />
    </button>
    {#if expanded}
      <ul id="units-{card.enrolmentId}" class="divide-y border-t bg-(--muted)/30">
        {#each card.units as u (u.id)}
          <li>
            <a
              href={unitHref(u.id)}
              class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-2 text-sm hover:bg-(--muted) md:grid-cols-[minmax(0,1fr)_8rem_6.5rem]"
            >
              <span class="min-w-0 break-words">{u.title}</span>
              <span class="justify-self-end"><StatusChip status={u.status} /></span>
              <span class="col-span-2 md:col-span-1">
                <ProgressBar actual={u.actualPct} label="{u.title} progress" />
                <span class="text-xs text-(--muted-foreground)">{fmtPct(u.actualPct)}</span>
              </span>
            </a>
          </li>
        {:else}
          <li class="px-4 py-3 text-sm text-(--muted-foreground)">This qualification has no units.</li>
        {/each}
      </ul>
    {/if}
  </div>
</section>
