<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import * as Page from '@cio/ui/base/page';
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Skeleton } from '@cio/ui/base/skeleton';
  import { BackButton } from '@cio/ui/custom/back-button';
  import CalendarIcon from '@lucide/svelte/icons/calendar';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import { isOrgTeamMember } from '$lib/utils/store/org';
  import { overviewApi } from '../api/overview.svelte';
  import { PortfolioStore } from '../stores/portfolio.svelte';
  import CriterionPopover from '../components/portfolio/criterion-popover.svelte';
  import EvidenceSheet from '../components/evidence/evidence-sheet.svelte';
  import UnitResourcesCard from '../components/resources/learner/unit-resources-card.svelte';
  import ProgressBar from '../components/shared/progress-bar.svelte';
  import StatusChip from '../components/shared/status-chip.svelte';
  import { fmtDate, fmtPct } from '../components/shared/format';

  // One unit of one qualification: Previous / Next unit (in the API's schedule order), a header with dates and
  // progress, then "Criteria breakdown" — criteria grouped by their group label, each with "N completed | N required",
  // a bar, Add evidence and List evidence — plus CSV exports. Shared by the staff shells and the learner shell.
  interface Props {
    mode: 'staff' | 'learner';
    enrolmentId: string;
    qualEnrolmentId: string;
    unitId: string;
    /** The qualification page. */
    qualHref: string;
    /** Another unit's page (Previous / Next). */
    unitHref: (unitId: string) => string;
  }
  let { mode, enrolmentId, qualEnrolmentId, unitId, qualHref, unitHref }: Props = $props();

  // svelte-ignore state_referenced_locally
  const store = new PortfolioStore(qualEnrolmentId || enrolmentId, { scoped: true });

  onMount(() => {
    store.load();
  });

  // The units of the qualification this unit belongs to, in the order the API sorted them (by schedule).
  const located = $derived.by(() => {
    for (const q of store.data?.qualifications ?? []) {
      const i = q.units.findIndex((u) => u.id === unitId);
      if (i !== -1) return { qual: q, index: i, unit: q.units[i] };
    }
    return null;
  });
  const unit = $derived(located?.unit ?? null);
  const prev = $derived(located && located.index > 0 ? located.qual.units[located.index - 1] : null);
  const next = $derived(
    located && located.index < located.qual.units.length - 1 ? located.qual.units[located.index + 1] : null
  );

  const groups = $derived.by(() => {
    const map = new Map<string, NonNullable<typeof unit>['criteria']>();
    for (const c of unit?.criteria ?? []) {
      const key = c.groupLabel?.trim() || 'Criteria';
      const list = map.get(key);
      if (list) list.push(c);
      else map.set(key, [c]);
    }
    return [...map.entries()].map(([label, criteria]) => ({ label, criteria }));
  });

  // Groups are open by default; this holds the ones the user collapsed.
  const collapsed = new SvelteSet<string>();
  function toggle(label: string) {
    if (collapsed.has(label)) collapsed.delete(label);
    else collapsed.add(label);
  }

  let exporting = $state<'unit' | 'all' | null>(null);
  async function exportData(scope: 'unit' | 'all') {
    exporting = scope;
    await overviewApi.exportCsv(store.enrolmentId, scope === 'unit' ? unitId : undefined);
    exporting = null;
  }

  // Unit dates (staff).
  let datesOpen = $state(false);
  let editStart = $state('');
  let editTarget = $state('');
  let dateError = $state<string | null>(null);
  function openDates() {
    editStart = unit?.startDate ?? '';
    editTarget = unit?.targetDate ?? '';
    dateError = null;
    datesOpen = true;
  }
  async function saveDates() {
    if (editStart && editTarget && editTarget < editStart) {
      dateError = 'Target date must be on or after the start date.';
      return;
    }
    const ok = await store.setUnitDates(
      { units: [{ unitId, startDate: editStart || null, targetDate: editTarget || null }] },
      store.enrolmentId
    );
    if (ok) datesOpen = false;
    else dateError = 'Could not save the dates.';
  }

  const allCriterionIds = $derived((unit?.criteria ?? []).map((c) => c.id));
</script>

<svelte:head>
  <title>{unit?.title ?? 'Unit'} — Apprenticeships</title>
</svelte:head>

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      <BackButton href={qualHref} label={store.data?.programme.title ?? 'Qualification'} />
      <Page.Title>{unit?.title ?? 'Unit'}</Page.Title>
    </Page.HeaderContent>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      {#if store.loading}
        <div class="space-y-3" role="status" aria-label="Loading unit">
          <Skeleton class="h-10 w-64" />
          <Skeleton class="h-32 w-full" />
          <Skeleton class="h-64 w-full" />
        </div>
      {:else if store.error && !store.data}
        <div class="rounded-lg border border-rose-200 p-6 text-center">
          <p role="alert" class="text-sm text-rose-600">{store.error}</p>
          <Button variant="outline" size="sm" class="mt-3" onclick={() => store.load()}>Try again</Button>
        </div>
      {:else if !unit}
        <div class="rounded-lg border p-6 text-center text-sm text-(--muted-foreground)">
          This unit was not found in the qualification.
          <a href={qualHref} class="font-medium underline">Back to the qualification</a>
        </div>
      {:else}
        <div class="space-y-4">
          <nav class="flex flex-wrap items-center justify-between gap-2" aria-label="Unit navigation">
            {#if prev}
              <Button href={unitHref(prev.id)} variant="outline" size="sm">
                <ChevronLeftIcon size={14} class="mr-1" /> Previous unit
              </Button>
            {:else}
              <Button variant="outline" size="sm" disabled
                ><ChevronLeftIcon size={14} class="mr-1" /> Previous unit</Button
              >
            {/if}
            {#if next}
              <Button href={unitHref(next.id)} variant="outline" size="sm">
                Next unit <ChevronRightIcon size={14} class="ml-1" />
              </Button>
            {:else}
              <Button variant="outline" size="sm" disabled>Next unit <ChevronRightIcon size={14} class="ml-1" /></Button
              >
            {/if}
          </nav>

          <section class="overflow-hidden rounded-lg border bg-(--card)" aria-label="Unit summary">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
              <h2 class="min-w-0 text-lg font-semibold break-words">
                {unit.code ? `${unit.code} · ` : ''}{unit.title}
              </h2>
              <div class="flex flex-wrap items-center gap-2">
                <StatusChip status={unit.status} />
                {#if mode === 'staff' && $isOrgTeamMember}
                  <Button variant="outline" size="sm" onclick={openDates}>
                    <PencilIcon size={14} class="mr-1" /> Edit dates
                  </Button>
                {/if}
              </div>
            </div>
            <div class="grid gap-4 px-4 py-4 text-sm md:grid-cols-[auto_1fr_auto]">
              <div>
                <p class="flex items-center gap-1.5 font-medium">
                  <CalendarIcon size={14} aria-hidden="true" /> Start date
                </p>
                <p class="text-(--muted-foreground)">{fmtDate(unit.startDate)}</p>
              </div>
              <div class="grid gap-3 sm:grid-cols-2">
                <div class="space-y-1">
                  <div class="flex justify-between text-xs text-(--muted-foreground) italic">
                    <span>Actual</span>
                    <span class="font-medium text-(--foreground) not-italic">{fmtPct(unit.actualPct)}</span>
                  </div>
                  <ProgressBar actual={unit.actualPct} label="Actual progress" />
                </div>
                <div class="space-y-1">
                  <div class="flex justify-between text-xs text-(--muted-foreground) italic">
                    <span>Expected</span>
                    <span class="font-medium text-(--foreground) not-italic">{fmtPct(unit.expectedPct)}</span>
                  </div>
                  <ProgressBar actual={unit.expectedPct} label="Expected progress" />
                </div>
              </div>
              <div class="md:text-right">
                <p class="font-medium">Target date</p>
                <p class="text-(--muted-foreground)">{fmtDate(unit.targetDate)}</p>
                {#if unit.achievedAt}
                  <p class="text-xs text-emerald-700 dark:text-emerald-400">Achieved {fmtDate(unit.achievedAt)}</p>
                {/if}
              </div>
            </div>
          </section>

          <UnitResourcesCard {mode} enrolmentId={qualEnrolmentId || enrolmentId} {unitId} {store} />

          <section class="rounded-lg border bg-(--card)" aria-label="Criteria breakdown">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
              <h2 class="text-base font-semibold">Criteria breakdown</h2>
              <div class="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  loading={exporting === 'all'}
                  disabled={exporting !== null}
                  onclick={() => exportData('all')}
                >
                  <DownloadIcon size={14} class="mr-1" /> Export all unit data
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  loading={exporting === 'unit'}
                  disabled={exporting !== null}
                  onclick={() => exportData('unit')}
                >
                  <DownloadIcon size={14} class="mr-1" /> Export unit data
                </Button>
                <Button
                  size="sm"
                  disabled={store.evidenceBlocked || allCriterionIds.length === 0}
                  title={store.evidenceBlocked ? store.blockedMessage : undefined}
                  onclick={() => store.openNewEvidence(allCriterionIds, null, store.enrolmentId)}
                >
                  <PlusIcon size={14} class="mr-1" /> Add evidence (all)
                </Button>
              </div>
            </div>

            <div class="space-y-3 p-4">
              {#if groups.length === 0}
                <p class="rounded-md border border-dashed p-4 text-sm text-(--muted-foreground)">
                  No criteria in this unit.
                </p>
              {/if}
              {#each groups as g (g.label)}
                {@const isOpen = !collapsed.has(g.label)}
                <div class="overflow-hidden rounded-lg border">
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-2 bg-(--muted)/40 px-3 py-2.5 text-left hover:bg-(--muted)/70"
                    aria-expanded={isOpen}
                    aria-controls="group-{g.label}"
                    onclick={() => toggle(g.label)}
                  >
                    <span class="text-sm font-semibold">
                      {g.label}
                      <span class="font-normal text-(--muted-foreground)"
                        >— {g.criteria.length} criteri{g.criteria.length === 1 ? 'on' : 'a'}</span
                      >
                    </span>
                    <ChevronDownIcon size={16} class="transition-transform {isOpen ? 'rotate-180' : ''}" />
                  </button>
                  {#if isOpen}
                    <ul id="group-{g.label}" class="divide-y">
                      {#each g.criteria as c (c.id)}
                        <li
                          class="grid grid-cols-1 items-center gap-x-4 gap-y-2 px-3 py-3 lg:grid-cols-[minmax(0,1fr)_10rem_auto]"
                        >
                          <p class="min-w-0 text-sm">
                            <span class="font-semibold">{c.code}</span>
                            <span class="text-(--muted-foreground)"> {c.text}</span>
                          </p>
                          <div class="space-y-1 text-xs">
                            <p class={c.met ? 'font-medium text-emerald-600' : 'text-(--muted-foreground)'}>
                              {c.acceptedCount} completed | {c.requiredCount} required
                            </p>
                            <ProgressBar
                              actual={Math.min(100, Math.round((c.acceptedCount / Math.max(1, c.requiredCount)) * 100))}
                              label="{c.code} evidence accepted"
                            />
                          </div>
                          <div class="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              aria-label="Add evidence for {c.code}"
                              disabled={store.evidenceBlocked}
                              title={store.evidenceBlocked ? store.blockedMessage : undefined}
                              onclick={() => store.openNewEvidence([c.id], null, store.enrolmentId)}
                            >
                              <PlusIcon size={14} class="mr-1" /> Add evidence
                            </Button>
                            <CriterionPopover
                              {store}
                              criterionId={c.id}
                              label="List evidence for {c.code}"
                              code={c.code}
                              text={c.text}
                              enrolmentId={store.enrolmentId}
                              triggerClass="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-(--muted)"
                            >
                              List evidence{c.evidenceCount > 0 ? ` (${c.evidenceCount})` : ''}
                            </CriterionPopover>
                          </div>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              {/each}
            </div>
          </section>
        </div>

        <Dialog.Root bind:open={datesOpen}>
          <Dialog.Content class="sm:max-w-md">
            <Dialog.Header>
              <Dialog.Title>Edit unit dates</Dialog.Title>
              <Dialog.Description>{unit.title}</Dialog.Description>
            </Dialog.Header>
            <form
              class="space-y-3"
              onsubmit={(ev) => {
                ev.preventDefault();
                saveDates();
              }}
            >
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div class="space-y-1">
                  <label for="unit-start" class="text-sm font-medium">Start date</label>
                  <Input id="unit-start" type="date" bind:value={editStart} />
                </div>
                <div class="space-y-1">
                  <label for="unit-target" class="text-sm font-medium">Target date</label>
                  <Input id="unit-target" type="date" bind:value={editTarget} min={editStart || undefined} />
                </div>
              </div>
              {#if dateError}<p role="alert" class="text-sm text-rose-600">{dateError}</p>{/if}
              <Dialog.Footer class="mt-4">
                <Button type="button" variant="outline" disabled={store.saving} onclick={() => (datesOpen = false)}>
                  Cancel
                </Button>
                <Button type="submit" loading={store.saving} disabled={store.saving}>Save</Button>
              </Dialog.Footer>
            </form>
          </Dialog.Content>
        </Dialog.Root>

        <EvidenceSheet
          bind:open={store.sheet.open}
          mode={store.sheet.mode}
          evidenceId={store.sheet.evidenceId}
          enrolmentId={store.sheetEnrolmentId}
          tree={store.pickerTree}
          metIds={store.sheetMetIds}
          preCriteria={store.sheet.criterionIds}
          tasks={store.tasks}
          editBlocked={store.evidenceBlocked}
          preTaskId={store.sheet.taskId}
          preResource={store.sheet.resource}
          learnerName={store.data?.learner.name ?? null}
          onChanged={() => store.refresh()}
        />
      {/if}
    {/snippet}
  </Page.Body>
</Page.Root>
