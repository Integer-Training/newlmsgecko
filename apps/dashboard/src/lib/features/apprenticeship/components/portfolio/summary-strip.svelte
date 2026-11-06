<script lang="ts">
  import { Button } from '@cio/ui/base/button';
  import CalendarIcon from '@lucide/svelte/icons/calendar';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import SplitIcon from '@lucide/svelte/icons/git-fork';
  import { enrolmentsApi, tutorNames } from '../../api/enrolments.svelte';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import ProgressBar from '../shared/progress-bar.svelte';
  import StatusChip from '../shared/status-chip.svelte';
  import { fmtDate, fmtMinutes, fmtPct } from '../shared/format';

  interface Props {
    store: PortfolioStore;
    onEditDates: () => void;
    onSpread: () => void;
  }
  let { store, onEditDates, onSpread }: Props = $props();

  const d = $derived(store.data);
  let exporting = $state(false);

  async function exportCsv() {
    exporting = true;
    await enrolmentsApi.exportCsv(store.enrolmentId);
    exporting = false;
  }
</script>

{#if d}
  <section class="bg-card space-y-4 rounded-lg border p-4" aria-label="Learner summary">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-xl font-semibold">{d.learner.name}</h2>
          <StatusChip status={d.summary.status} />
        </div>
        <p class="text-muted-foreground text-sm">
          {d.programme.title} · Tutor: {tutorNames(d.tutors)}
        </p>
        <p class="text-muted-foreground text-sm">
          {fmtDate(d.enrolment.startDate)} → {fmtDate(d.enrolment.plannedEndDate)}
          {#if d.enrolment.contractedHoursWeek}· {d.enrolment.contractedHoursWeek} h/week{/if}
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onclick={onEditDates}>
          <CalendarIcon size={14} class="mr-1" /> Edit dates &amp; hours
        </Button>
        <Button variant="outline" size="sm" onclick={onSpread}>
          <SplitIcon size={14} class="mr-1" /> Spread unit dates
        </Button>
        <Button variant="outline" size="sm" onclick={exportCsv} loading={exporting} disabled={exporting}>
          <DownloadIcon size={14} class="mr-1" /> Export CSV
        </Button>
        <Button size="sm" onclick={() => store.openNewEvidence()}>
          <PlusIcon size={14} class="mr-1" /> Add evidence
        </Button>
      </div>
    </div>

    <div class="grid gap-4 md:grid-cols-2">
      <div class="space-y-1">
        <div class="flex justify-between text-sm">
          <span class="font-medium">Qualification progress</span>
          <span>{fmtPct(d.summary.actualPct)} · expected {fmtPct(d.summary.expectedPct)}</span>
        </div>
        <ProgressBar actual={d.summary.actualPct} expected={d.summary.expectedPct} label="Qualification progress" />
      </div>
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

    <p class="text-muted-foreground text-sm">
      Evidence: <strong class="text-foreground">{d.summary.counts.submitted}</strong> to mark ·
      <strong class="text-foreground">{d.summary.counts.accepted}</strong> accepted ·
      <strong class="text-foreground">{d.summary.counts.referred}</strong> referred
    </p>
  </section>
{/if}
