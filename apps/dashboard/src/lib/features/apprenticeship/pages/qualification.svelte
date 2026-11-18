<script lang="ts">
  import { onMount } from 'svelte';
  import * as Page from '@cio/ui/base/page';
  import { Button } from '@cio/ui/base/button';
  import { Skeleton } from '@cio/ui/base/skeleton';
  import { BackButton } from '@cio/ui/custom/back-button';
  import AwardIcon from '@lucide/svelte/icons/award';
  import CalendarIcon from '@lucide/svelte/icons/calendar';
  import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
  import CircleIcon from '@lucide/svelte/icons/circle';
  import ArrowRightIcon from '@lucide/svelte/icons/circle-arrow-right';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import { isOrgAdmin } from '$lib/utils/store/org';
  import { PortfolioStore } from '../stores/portfolio.svelte';
  import DatesDialog from '../components/portfolio/dates-dialog.svelte';
  import ProgrammeTypeChip from '../components/shared/programme-type-chip.svelte';
  import ProgressBar from '../components/shared/progress-bar.svelte';
  import StatusChip from '../components/shared/status-chip.svelte';
  import { fmtDate, fmtPct } from '../components/shared/format';

  // One qualification of an apprenticeship (a Diploma or a Standard): header with status, dates and the Current /
  // Expected bars, then the "Unit breakdown" card grid. Shared by the staff shells and the learner shell. Every number
  // is the API's.
  interface Props {
    mode: 'staff' | 'learner';
    /** The apprenticeship's carrier enrolment (the URL's learner id). */
    enrolmentId: string;
    /** The enrolment of THIS qualification (equals `enrolmentId` for a standalone or the carrier). */
    qualEnrolmentId: string;
    /** Where "back" goes (the learner's portfolio / overview). */
    backHref: string;
    /** Unit page for one unit of this qualification. */
    unitHref: (unitId: string) => string;
  }
  let { mode, enrolmentId, qualEnrolmentId, backHref, unitHref }: Props = $props();

  // svelte-ignore state_referenced_locally
  const store = new PortfolioStore(qualEnrolmentId || enrolmentId, { scoped: true });
  let datesOpen = $state(false);

  onMount(() => {
    store.load();
  });

  const d = $derived(store.data);
  const quals = $derived(d?.qualifications ?? []);
</script>

<svelte:head>
  <title>{d?.programme.title ?? 'Qualification'} — Apprenticeships</title>
</svelte:head>

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      <BackButton href={backHref} label={mode === 'staff' ? 'Back to learner' : 'Back to my apprenticeship'} />
      <Page.Title>{d?.programme.title ?? 'Qualification'}</Page.Title>
    </Page.HeaderContent>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      {#if store.loading}
        <div class="space-y-3" role="status" aria-label="Loading qualification">
          <Skeleton class="h-32 w-full" />
          <Skeleton class="h-64 w-full" />
        </div>
      {:else if store.error && !d}
        <div class="rounded-lg border border-rose-200 p-6 text-center">
          <p role="alert" class="text-sm text-rose-600">{store.error}</p>
          <Button variant="outline" size="sm" class="mt-3" onclick={() => store.load()}>Try again</Button>
        </div>
      {:else if d}
        <div class="space-y-4">
          <section class="overflow-hidden rounded-lg border bg-(--card)" aria-label="Qualification summary">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
              <h2 class="flex min-w-0 items-center gap-2 text-lg font-semibold">
                <AwardIcon size={18} class="shrink-0" aria-hidden="true" />
                <span class="min-w-0 break-words">{d.programme.title}</span>
                {#if d.programme.type}<ProgrammeTypeChip type={d.programme.type} />{/if}
              </h2>
              <div class="flex flex-wrap items-center gap-2">
                <StatusChip status={d.enrolment.achievedAt ? 'COMPLETE' : d.summary.status} />
                {#if mode === 'staff' && $isOrgAdmin}
                  <Button variant="outline" size="sm" onclick={() => (datesOpen = true)}>
                    <PencilIcon size={14} class="mr-1" /> Edit dates
                  </Button>
                {/if}
              </div>
            </div>
            <p class="flex flex-wrap gap-x-6 gap-y-1 px-4 pt-3 text-sm text-(--muted-foreground)">
              <span class="flex items-center gap-1.5">
                <CalendarIcon size={14} aria-hidden="true" /> Start {fmtDate(d.enrolment.startDate)}
              </span>
              <span class="flex items-center gap-1.5">
                <CalendarIcon size={14} aria-hidden="true" /> Anticipated finish {fmtDate(d.enrolment.plannedEndDate)}
              </span>
            </p>
            <div class="grid gap-4 px-4 py-4 md:grid-cols-2">
              <div class="space-y-1">
                <div class="flex justify-between text-xs text-(--muted-foreground) italic">
                  <span>Current</span>
                  <span class="font-medium text-(--foreground) not-italic">{fmtPct(d.summary.actualPct)}</span>
                </div>
                <ProgressBar actual={d.summary.actualPct} label="Current progress" />
              </div>
              <div class="space-y-1">
                <div class="flex justify-between text-xs text-(--muted-foreground) italic">
                  <span>Expected</span>
                  <span class="font-medium text-(--foreground) not-italic">{fmtPct(d.summary.expectedPct)}</span>
                </div>
                <ProgressBar actual={d.summary.expectedPct} label="Expected progress" />
              </div>
            </div>
          </section>

          <section class="rounded-lg border bg-(--card)" aria-label="Unit breakdown">
            <h2 class="border-b px-4 py-3 text-base font-semibold">Unit breakdown</h2>
            <div class="space-y-5 p-4">
              {#each quals as qual (qual.id)}
                <div class="space-y-2">
                  {#if quals.length > 1}<h3 class="text-sm font-semibold">{qual.title}</h3>{/if}
                  {#if qual.units.length === 0}
                    <p class="rounded-md border border-dashed p-4 text-sm text-(--muted-foreground)">
                      This qualification has no units.
                    </p>
                  {/if}
                  <ul class="grid gap-3 lg:grid-cols-2">
                    {#each qual.units as unit (unit.id)}
                      <li class="flex flex-col overflow-hidden rounded-lg border">
                        <h4 class="flex items-start gap-2 border-b px-3 py-2 text-sm font-medium">
                          {#if unit.status === 'COMPLETE'}
                            <CircleCheckIcon size={18} class="mt-px shrink-0 text-emerald-600" aria-label="Complete" />
                          {:else}
                            <CircleIcon size={18} class="mt-px shrink-0 text-(--muted-foreground)" aria-hidden="true" />
                          {/if}
                          <span class="min-w-0 break-words">{unit.code ? `${unit.code} · ` : ''}{unit.title}</span>
                        </h4>
                        <div class="grid flex-1 grid-cols-[auto_1fr_auto] gap-x-4 px-3 py-3 text-xs">
                          <div class="space-y-0.5 text-(--muted-foreground)">
                            <p class="flex items-center gap-1 font-medium text-(--foreground)">
                              <CalendarIcon size={12} aria-hidden="true" /> Start date
                            </p>
                            <p>{fmtDate(unit.startDate)}</p>
                          </div>
                          <div class="space-y-2">
                            <div class="space-y-1">
                              <div class="flex justify-between text-(--muted-foreground) italic">
                                <span>Actual</span>
                                <span class="font-medium text-(--foreground) not-italic">{fmtPct(unit.actualPct)}</span>
                              </div>
                              <ProgressBar actual={unit.actualPct} label="{unit.title} actual progress" />
                            </div>
                            <div class="space-y-1">
                              <div class="flex justify-between text-(--muted-foreground) italic">
                                <span>Expected</span>
                                <span class="font-medium text-(--foreground) not-italic"
                                  >{fmtPct(unit.expectedPct)}</span
                                >
                              </div>
                              <ProgressBar actual={unit.expectedPct} label="{unit.title} expected progress" />
                            </div>
                          </div>
                          <div class="space-y-0.5 text-right text-(--muted-foreground)">
                            <p class="font-medium text-(--foreground)">Target date</p>
                            <p>{fmtDate(unit.targetDate)}</p>
                            {#if unit.achievedAt}
                              <p class="text-emerald-700 dark:text-emerald-400">Achieved {fmtDate(unit.achievedAt)}</p>
                            {/if}
                          </div>
                        </div>
                        <div class="flex items-center justify-between border-t bg-(--muted)/30 px-3 py-2">
                          <StatusChip status={unit.status} />
                          <a
                            href={unitHref(unit.id)}
                            class="inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
                            aria-label="View more: {unit.title}"
                          >
                            View more <ArrowRightIcon size={16} />
                          </a>
                        </div>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/each}
            </div>
          </section>
        </div>

        {#if mode === 'staff' && $isOrgAdmin}<DatesDialog bind:open={datesOpen} {store} />{/if}
      {/if}
    {/snippet}
  </Page.Body>
</Page.Root>
