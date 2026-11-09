<script lang="ts">
  import { isOrgTeamMember } from '$lib/utils/store/org';
  import { SvelteSet } from 'svelte/reactivity';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import CheckIcon from '@lucide/svelte/icons/check';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import CriterionPopover from './criterion-popover.svelte';
  import ProgressBar from '../shared/progress-bar.svelte';
  import StatusChip from '../shared/status-chip.svelte';
  import { fmtDate, fmtPct } from '../shared/format';

  // Units tab: per qualification one row per unit; clicking a unit opens its criteria IN PLACE (no page change).
  // Dates can be set inline. Every number is the API's.

  interface Props {
    store: PortfolioStore;
  }
  let { store }: Props = $props();

  const open = new SvelteSet<string>();
  let editingUnit = $state<string | null>(null);
  let editStart = $state('');
  let editTarget = $state('');
  let dateError = $state<string | null>(null);

  function toggle(id: string) {
    if (open.has(id)) open.delete(id);
    else open.add(id);
  }

  function beginEdit(unit: { id: string; startDate: string | null; targetDate: string | null }) {
    editingUnit = unit.id;
    editStart = unit.startDate ?? '';
    editTarget = unit.targetDate ?? '';
    dateError = null;
  }

  async function saveDates(unitId: string) {
    if (editStart && editTarget && editTarget < editStart) {
      dateError = 'Target date must be on or after the start date.';
      return;
    }
    const ok = await store.setUnitDates({
      units: [{ unitId, startDate: editStart || null, targetDate: editTarget || null }]
    });
    if (ok) editingUnit = null;
    else dateError = 'Could not save the dates.';
  }
</script>

<div class="space-y-6">
  {#each store.data?.qualifications ?? [] as qual (qual.id)}
    <section aria-label={qual.title}>
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-semibold">
          {qual.title}
          {#if qual.reference}<span class="text-sm font-normal text-(--muted-foreground)">
              · {qual.reference}</span
            >{/if}
        </h3>
        <span class="text-sm text-(--muted-foreground)">{fmtPct(qual.actualPct)} complete</span>
      </div>

      {#if qual.units.length === 0}
        <p class="rounded-md border border-dashed p-4 text-sm text-(--muted-foreground)">
          This qualification has no units.
        </p>
      {/if}

      <ul class="divide-y rounded-lg border">
        {#each qual.units as unit (unit.id)}
          {@const isOpen = open.has(unit.id)}
          <li>
            <div
              class="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-3 py-2.5 md:grid-cols-[minmax(0,1fr)_6.5rem_15rem_10rem]"
            >
              <button
                type="button"
                class="flex min-w-0 items-center gap-1.5 text-left"
                aria-expanded={isOpen}
                aria-controls="unit-{unit.id}"
                onclick={() => toggle(unit.id)}
              >
                {#if isOpen}<ChevronDownIcon size={16} class="shrink-0" />{:else}<ChevronRightIcon
                    size={16}
                    class="shrink-0"
                  />{/if}
                <span class="line-clamp-2 text-sm font-medium break-words"
                  >{unit.code ? `${unit.code} · ` : ''}{unit.title}</span
                >
              </button>

              <div class="justify-self-end md:justify-self-auto">
                <StatusChip status={unit.status} />
              </div>

              <!-- While editing, the date inputs + buttons take a full row so nothing overlaps. -->
              <div
                class="col-span-2 flex items-center gap-1 text-sm {editingUnit === unit.id
                  ? 'md:col-span-4'
                  : 'md:col-span-1'}"
              >
                {#if editingUnit === unit.id}
                  <div class="flex flex-wrap items-center gap-1.5">
                    <Input type="date" class="ui:h-8 w-36!" aria-label="Unit start date" bind:value={editStart} />
                    <span aria-hidden="true">→</span>
                    <Input type="date" class="ui:h-8 w-36!" aria-label="Unit target date" bind:value={editTarget} />
                    <Button size="sm" loading={store.saving} disabled={store.saving} onclick={() => saveDates(unit.id)}>
                      <CheckIcon size={14} class="mr-1" /> Save
                    </Button>
                    <Button size="sm" variant="ghost" disabled={store.saving} onclick={() => (editingUnit = null)}>
                      Cancel
                    </Button>
                    {#if dateError}<span role="alert" class="w-full text-xs text-rose-600">{dateError}</span>{/if}
                  </div>
                {:else if unit.startDate || unit.targetDate}
                  <span class="whitespace-nowrap text-(--muted-foreground)">
                    {fmtDate(unit.startDate)} → {fmtDate(unit.targetDate)}
                  </span>
                  {#if $isOrgTeamMember}
                    <button
                      type="button"
                      class="p-1 text-(--muted-foreground) hover:text-(--foreground)"
                      aria-label="Edit dates for {unit.title}"
                      onclick={() => beginEdit(unit)}
                    >
                      <PencilIcon size={13} />
                    </button>
                  {/if}
                {:else if $isOrgTeamMember}
                  <Button variant="outline" size="sm" onclick={() => beginEdit(unit)}>Set dates</Button>
                {:else}
                  <span class="text-(--muted-foreground)">Dates not set</span>
                {/if}
              </div>

              <div class="col-span-2 md:col-span-1">
                <ProgressBar actual={unit.actualPct} expected={unit.expectedPct} label="{unit.title} progress" />
                <p class="mt-0.5 text-xs whitespace-nowrap text-(--muted-foreground)">
                  {fmtPct(unit.actualPct)}{unit.expectedPct !== null ? ` · expected ${unit.expectedPct}%` : ''}
                </p>
              </div>
            </div>

            {#if isOpen}
              <div id="unit-{unit.id}" class="border-t bg-(--muted)/30 px-3 py-2">
                {#if unit.criteria.length === 0}
                  <p class="py-2 text-sm text-(--muted-foreground)">No criteria in this unit.</p>
                {/if}
                <ul class="divide-y">
                  {#each unit.criteria as c (c.id)}
                    <li
                      class="grid grid-cols-1 items-center gap-x-4 gap-y-1 py-2 md:grid-cols-[minmax(0,1fr)_9rem_9rem_6rem]"
                    >
                      <p class="min-w-0 text-sm">
                        <span class="font-medium">{c.code}</span>
                        <span class="text-(--muted-foreground)"> {c.text}</span>
                      </p>
                      <div class="text-xs">
                        <span class={c.met ? 'font-medium text-emerald-600' : 'text-(--muted-foreground)'}>
                          {c.met ? 'Met' : 'Not met'} · {c.acceptedCount}/{c.requiredCount}
                        </span>
                        <ProgressBar
                          class="mt-0.5"
                          actual={Math.min(100, Math.round((c.acceptedCount / Math.max(1, c.requiredCount)) * 100))}
                          label="{c.code} evidence accepted"
                        />
                      </div>
                      <div>
                        <CriterionPopover
                          {store}
                          criterionId={c.id}
                          label="Evidence for {c.code}"
                          triggerClass="rounded-full border px-2.5 py-0.5 text-xs hover:bg-(--muted)"
                        >
                          {c.evidenceCount} evidence{c.pendingCount > 0 ? ` (${c.pendingCount} pending)` : ''}
                        </CriterionPopover>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Add evidence for {c.code}"
                        onclick={() => store.openNewEvidence([c.id])}
                      >
                        <PlusIcon size={14} class="mr-1" /> Evidence
                      </Button>
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</div>
