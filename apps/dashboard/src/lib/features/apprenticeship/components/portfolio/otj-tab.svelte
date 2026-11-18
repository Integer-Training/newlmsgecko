<script lang="ts">
  import { Skeleton } from '@cio/ui/base/skeleton';
  import { Button } from '@cio/ui/base/button';
  import { isOrgAdmin, isOrgTeamMember } from '$lib/utils/store/org';
  import { otjApi, type OtjRow, type OtjView } from '../../api/otj.svelte';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import OverviewCard from '../otj/overview-card.svelte';
  import LogTable from '../otj/log-table.svelte';
  import LogDialog from '../otj/log-dialog.svelte';
  import ReviewDialog from '../otj/review-dialog.svelte';
  import DatesDialog from './dates-dialog.svelte';
  import GlhSection from './glh-section.svelte';

  // OTJ progress page (staff portfolio tab and the learner /otj route): the overview card, then the merged log table
  // (logs + OTJ evidence). Only VALIDATED / accepted time counts. GLH stays below. All figures come from the API.

  interface Props {
    store: PortfolioStore;
  }
  let { store }: Props = $props();

  const isStaff = $derived($isOrgTeamMember === true);
  const isAdmin = $derived($isOrgAdmin === true);

  let view = $state<OtjView | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let reqId = 0;

  let logOpen = $state(false);
  let editing = $state<OtjRow | null>(null);
  let reviewOpen = $state(false);
  let reviewRow = $state<OtjRow | null>(null);
  let reviewDecision = $state<'VALIDATE' | 'REJECT'>('VALIDATE');
  let datesOpen = $state(false);

  async function load() {
    const id = ++reqId;
    const res = await otjApi.get(store.enrolmentId);
    if (id !== reqId) return;
    loading = false;
    if (res.ok) {
      view = res.data;
      error = null;
    } else {
      error = res.error;
    }
  }

  // Reload when the portfolio changes (evidence reviewed, hours edited, ...) or the enrolment id resolves.
  $effect(() => {
    store.enrolmentId;
    store.version;
    load();
  });

  // A log changed: refresh the portfolio too so the header chips and summary agree (that bumps the version, which
  // reloads this page).
  async function changed() {
    await Promise.all([load(), store.refresh()]);
  }

  function add() {
    editing = null;
    logOpen = true;
  }
  function edit(row: OtjRow) {
    editing = row;
    logOpen = true;
  }
  function review(row: OtjRow, decision: 'VALIDATE' | 'REJECT') {
    reviewRow = row;
    reviewDecision = decision;
    reviewOpen = true;
  }
</script>

<div class="space-y-4">
  {#if loading}
    <div class="space-y-2" role="status" aria-label="Loading off-the-job progress">
      <Skeleton class="h-40 w-full" />
      <Skeleton class="h-48 w-full" />
    </div>
  {:else if error && !view}
    <div class="rounded-lg border border-rose-200 p-6 text-center">
      <p role="alert" class="text-sm text-rose-600">{error}</p>
      <Button variant="outline" size="sm" class="mt-3" onclick={load}>Try again</Button>
    </div>
  {:else if view}
    <OverviewCard summary={view.summary} {isAdmin} onEditHours={() => (datesOpen = true)} />
    <LogTable
      rows={view.rows}
      pendingMinutes={view.summary.pendingMinutes}
      onAdd={add}
      readOnly={store.readOnly}
      onEdit={edit}
      onReview={review}
      onViewEvidence={(id) => store.openEvidence(id)}
      onChanged={changed}
    />
  {/if}

  <GlhSection {store} />
</div>

<LogDialog bind:open={logOpen} enrolmentId={store.enrolmentId} row={editing} {isStaff} onDone={changed} />
<ReviewDialog bind:open={reviewOpen} row={reviewRow} decision={reviewDecision} onDone={changed} />
{#if isAdmin}<DatesDialog bind:open={datesOpen} {store} />{/if}
