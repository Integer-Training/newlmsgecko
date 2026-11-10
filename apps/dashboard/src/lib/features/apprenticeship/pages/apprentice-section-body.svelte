<script lang="ts" module>
  export type Section = 'units' | 'evidence' | 'tasks' | 'reviews' | 'otj' | 'gateway';
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import * as Page from '@cio/ui/base/page';
  import { Button } from '@cio/ui/base/button';
  import { Skeleton } from '@cio/ui/base/skeleton';
  import { PortfolioStore } from '../stores/portfolio.svelte';
  import UnitsTab from '../components/portfolio/units-tab.svelte';
  import CriteriaGrid from '../components/portfolio/criteria-grid.svelte';
  import EvidenceTab from '../components/portfolio/evidence-tab.svelte';
  import TasksTab from '../components/portfolio/tasks-tab.svelte';
  import ReviewsTab from '../components/portfolio/reviews-tab.svelte';
  import OtjTab from '../components/portfolio/otj-tab.svelte';
  import GatewayTab from '../components/portfolio/gateway-tab.svelte';
  import EvidenceSheet from '../components/evidence/evidence-sheet.svelte';

  interface Props {
    enrolmentId: string;
    section: Section;
    title: string;
  }
  let { enrolmentId, section, title }: Props = $props();

  // svelte-ignore state_referenced_locally
  const store = new PortfolioStore(enrolmentId);

  onMount(() => {
    store.load();
  });

  // Same set the portfolio page passes to the evidence sheet (criteria already met).
  const metIds = $derived(
    new Set(
      (store.data?.qualifications ?? []).flatMap((q) =>
        q.units.flatMap((u) => u.criteria.filter((c) => c.met).map((c) => c.id))
      )
    )
  );
</script>

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      <Page.Title>{title}</Page.Title>
    </Page.HeaderContent>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      {#if store.loading}
        <div class="space-y-3" role="status" aria-label="Loading">
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
          {#if store.evidenceBlocked && (section === 'evidence' || section === 'tasks')}
            <p
              role="status"
              class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
            >
              {store.blockedMessage}
            </p>
          {/if}

          {#if section === 'units'}
            <UnitsTab {store} />
            <h2 class="pt-2 text-base font-semibold">Criteria map</h2>
            <CriteriaGrid {store} />
          {:else if section === 'evidence'}
            <EvidenceTab {store} />
          {:else if section === 'tasks'}
            <TasksTab {store} />
          {:else if section === 'reviews'}
            <ReviewsTab {store} />
          {:else if section === 'otj'}
            <OtjTab {store} />
          {:else if section === 'gateway'}
            <GatewayTab {store} />
          {/if}
        </div>

        <EvidenceSheet
          bind:open={store.sheet.open}
          mode={store.sheet.mode}
          evidenceId={store.sheet.evidenceId}
          enrolmentId={store.enrolmentId}
          tree={store.pickerTree}
          {metIds}
          preCriteria={store.sheet.criterionIds}
          tasks={store.tasks}
          editBlocked={store.evidenceBlocked}
          preTaskId={store.sheet.taskId}
          learnerName={store.data.learner.name}
          onChanged={() => store.refresh()}
        />
      {/if}
    {/snippet}
  </Page.Body>
</Page.Root>
