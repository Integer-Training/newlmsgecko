<script lang="ts">
  import { onMount } from 'svelte';
  import * as Page from '@cio/ui/base/page';
  import * as Tabs from '@cio/ui/base/tabs';
  import { Button } from '@cio/ui/base/button';
  import { Skeleton } from '@cio/ui/base/skeleton';
  import { BackButton } from '@cio/ui/custom/back-button';
  import { currentOrg } from '$lib/utils/store/org';
  import { PortfolioStore } from '../stores/portfolio.svelte';
  import SummaryStrip from '../components/portfolio/summary-strip.svelte';
  import UnitsTab from '../components/portfolio/units-tab.svelte';
  import CriteriaGrid from '../components/portfolio/criteria-grid.svelte';
  import EvidenceTab from '../components/portfolio/evidence-tab.svelte';
  import OtjTab from '../components/portfolio/otj-tab.svelte';
  import AchievedTab from '../components/portfolio/achieved-tab.svelte';
  import DatesDialog from '../components/portfolio/dates-dialog.svelte';
  import SpreadDialog from '../components/portfolio/spread-dialog.svelte';
  import EvidenceSheet from '../components/evidence/evidence-sheet.svelte';

  // Gecko Apprenticeships — one learner's portfolio on a single page. Everything opens in place (units expand,
  // evidence opens in a side sheet); one store owns the data so every part of the page agrees after any change.

  interface Props {
    enrolmentId: string;
  }
  let { enrolmentId }: Props = $props();

  // svelte-ignore state_referenced_locally
  const store = new PortfolioStore(enrolmentId);
  let tab = $state('units');
  let datesOpen = $state(false);
  let spreadOpen = $state(false);

  onMount(() => {
    store.load();
  });

  const metIds = $derived(
    new Set(
      (store.data?.qualifications ?? []).flatMap((q) =>
        q.units.flatMap((u) => u.criteria.filter((c) => c.met).map((c) => c.id))
      )
    )
  );
  const backHref = $derived(`/org/${$currentOrg.siteName}/apprenticeships`);
</script>

<svelte:head>
  <title>{store.data?.learner.name ?? 'Portfolio'} — Apprenticeships</title>
</svelte:head>

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      <BackButton href={backHref} label="All learners" />
      <Page.Title>Portfolio</Page.Title>
    </Page.HeaderContent>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      {#if store.loading}
        <div class="space-y-3" role="status" aria-label="Loading portfolio">
          <Skeleton class="h-40 w-full" />
          <Skeleton class="h-10 w-80" />
          <Skeleton class="h-64 w-full" />
        </div>
      {:else if store.error && !store.data}
        <div class="rounded-lg border border-rose-200 p-6 text-center">
          <p role="alert" class="text-sm text-rose-600">{store.error}</p>
          <Button variant="outline" size="sm" class="mt-3" onclick={() => store.load()}>Try again</Button>
        </div>
      {:else if store.data}
        <div class="space-y-4">
          <SummaryStrip {store} onEditDates={() => (datesOpen = true)} onSpread={() => (spreadOpen = true)} />

          <Tabs.Root bind:value={tab}>
            <Tabs.List class="ui:h-auto ui:flex-wrap">
              <Tabs.Trigger value="units">Units</Tabs.Trigger>
              <Tabs.Trigger value="map">Criteria map</Tabs.Trigger>
              <Tabs.Trigger value="evidence">
                Evidence
                <span class="text-muted-foreground text-xs">({store.evidence.length})</span>
              </Tabs.Trigger>
              <Tabs.Trigger value="otj">Off-the-job</Tabs.Trigger>
              <Tabs.Trigger value="achieved">Achieved</Tabs.Trigger>
            </Tabs.List>
            <div class="mt-4 min-h-64">
              <Tabs.Content value="units"><UnitsTab {store} /></Tabs.Content>
              <Tabs.Content value="map"><CriteriaGrid {store} /></Tabs.Content>
              <Tabs.Content value="evidence"><EvidenceTab {store} /></Tabs.Content>
              <Tabs.Content value="otj"><OtjTab {store} /></Tabs.Content>
              <Tabs.Content value="achieved"><AchievedTab {store} /></Tabs.Content>
            </div>
          </Tabs.Root>
        </div>

        <DatesDialog bind:open={datesOpen} {store} />
        <SpreadDialog bind:open={spreadOpen} {store} />
        <EvidenceSheet
          bind:open={store.sheet.open}
          mode={store.sheet.mode}
          evidenceId={store.sheet.evidenceId}
          enrolmentId={store.enrolmentId}
          tree={store.pickerTree}
          {metIds}
          preCriteria={store.sheet.criterionIds}
          learnerName={store.data.learner.name}
          onChanged={() => store.refresh()}
        />
      {/if}
    {/snippet}
  </Page.Body>
</Page.Root>
