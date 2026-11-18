<script lang="ts">
  import { Button } from '@cio/ui/base/button';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import SplitIcon from '@lucide/svelte/icons/git-fork';
  import UsersIcon from '@lucide/svelte/icons/users';
  import { isOrgAdmin, isOrgTeamMember } from '$lib/utils/store/org';
  import { enrolmentsApi, tutorNames } from '../../api/enrolments.svelte';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import ProgressBar from '../shared/progress-bar.svelte';
  import StatusChip from '../shared/status-chip.svelte';
  import StageChip from '../shared/stage-chip.svelte';
  import ProgrammeTypeChip from '../shared/programme-type-chip.svelte';
  import { fmtDate, fmtMinutes, fmtPct } from '../shared/format';

  interface Props {
    store: PortfolioStore;
    onSpread: () => void;
    onTutors: () => void;
  }
  let { store, onSpread, onTutors }: Props = $props();

  const d = $derived(store.data);
  let exporting = $state(false);

  async function exportCsv() {
    exporting = true;
    await enrolmentsApi.exportCsv(store.enrolmentId);
    exporting = false;
  }
</script>

{#if d}
  <section class="space-y-4 rounded-lg border bg-(--card) p-4" aria-label="Learner summary">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <StatusChip status={d.summary.status} />
          <StageChip stage={d.summary.stage} label={d.summary.stageLabel} />
        </div>
        <p class="text-sm text-(--muted-foreground)">Tutor: {tutorNames(d.tutors)}</p>
        {#if !store.pair}
          <p class="text-sm text-(--muted-foreground)">
            {fmtDate(d.enrolment.startDate)} → {fmtDate(d.enrolment.plannedEndDate)}
            {#if d.enrolment.contractedHoursWeek}· {d.enrolment.contractedHoursWeek} h/week{/if}
          </p>
        {/if}
      </div>
      <div class="flex flex-wrap gap-2">
        {#if $isOrgAdmin}
          <Button variant="outline" size="sm" onclick={onTutors}>
            <UsersIcon size={14} class="mr-1" /> Tutors
          </Button>
        {/if}
        {#if $isOrgTeamMember}
          <Button variant="outline" size="sm" onclick={onSpread}>
            <SplitIcon size={14} class="mr-1" /> Spread unit dates
          </Button>
        {/if}
        <Button variant="outline" size="sm" onclick={exportCsv} loading={exporting} disabled={exporting}>
          <DownloadIcon size={14} class="mr-1" /> Export CSV
        </Button>
        {#if !store.evidenceBlocked}
          <Button size="sm" onclick={() => store.openNewEvidence()}>
            <PlusIcon size={14} class="mr-1" /> Add evidence
          </Button>
        {/if}
      </div>
    </div>

    <div class="grid gap-4 md:grid-cols-2">
      {#if store.pair}
        <div class="space-y-2">
          <div class="flex justify-between text-sm">
            <span class="font-medium">Overall</span>
            <span>{fmtPct(store.overview?.overall.actualPct)}</span>
          </div>
          {#each store.portfolios as p (p.enrolment.id)}
            <div class="space-y-0.5">
              <div class="flex justify-between gap-2 text-xs text-(--muted-foreground)">
                <span class="flex min-w-0 items-center gap-1.5">
                  {#if p.programme.type}<ProgrammeTypeChip type={p.programme.type} />{/if}
                  <span class="truncate">{p.programme.title}</span>
                </span>
                <span class="shrink-0">{fmtPct(p.summary.actualPct)} · expected {fmtPct(p.summary.expectedPct)}</span>
              </div>
              <ProgressBar
                actual={p.summary.actualPct}
                expected={p.summary.expectedPct}
                label="{p.programme.title} progress"
              />
            </div>
          {/each}
        </div>
      {:else}
        <div class="space-y-1">
          <div class="flex justify-between text-sm">
            <span class="font-medium">Qualification progress</span>
            <span>{fmtPct(d.summary.actualPct)} · expected {fmtPct(d.summary.expectedPct)}</span>
          </div>
          <ProgressBar actual={d.summary.actualPct} expected={d.summary.expectedPct} label="Qualification progress" />
        </div>
      {/if}
      <div class="space-y-1">
        <div class="flex justify-between text-sm">
          <span class="font-medium">Off-the-job hours</span>
          <span>
            {fmtMinutes(d.summary.otj.minutes)} of {fmtMinutes(d.summary.otj.targetMinutes)} · expected {fmtMinutes(
              d.summary.otj.expectedMinutes
            )}
          </span>
        </div>
        <ProgressBar
          actual={d.summary.otj.targetMinutes
            ? Math.floor((d.summary.otj.minutes / d.summary.otj.targetMinutes) * 100)
            : null}
          expected={d.summary.otj.targetMinutes && d.summary.otj.expectedMinutes !== null
            ? Math.round((d.summary.otj.expectedMinutes / d.summary.otj.targetMinutes) * 100)
            : null}
          label="Off-the-job hours"
        />
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2 text-sm">
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 hover:bg-(--muted) {store.overdueTaskCount >
        0
          ? 'border-rose-300 text-rose-700 dark:text-rose-300'
          : ''}"
        onclick={() => (store.tab = 'tasks')}
      >
        Overdue tasks <strong>{store.overdueTaskCount}</strong>
      </button>
      {#if store.nextReview}
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 hover:bg-(--muted) {store.nextReview
            .overdue
            ? 'border-rose-300 text-rose-700 dark:text-rose-300'
            : ''}"
          onclick={() => (store.tab = 'reviews')}
        >
          Next review <strong>{fmtDate(store.nextReview.scheduledDate)}</strong>
          {#if store.nextReview.overdue}<span class="font-medium">· Overdue</span>{/if}
        </button>
      {/if}
    </div>

    <p class="text-sm text-(--muted-foreground)">
      Evidence: <strong class="text-(--foreground)">{d.summary.counts.submitted}</strong> to mark ·
      <strong class="text-(--foreground)">{d.summary.counts.accepted}</strong> accepted ·
      <strong class="text-(--foreground)">{d.summary.counts.referred}</strong> referred
    </p>
  </section>
{/if}
