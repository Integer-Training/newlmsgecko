<script lang="ts">
  import { onMount } from 'svelte';
  import * as Page from '@cio/ui/base/page';
  import * as Tabs from '@cio/ui/base/tabs';
  import { Button } from '@cio/ui/base/button';
  import { Skeleton } from '@cio/ui/base/skeleton';
  import { BackButton } from '@cio/ui/custom/back-button';
  import { page as appPage } from '$app/state';
  import { replaceState } from '$app/navigation';
  import { currentOrg, isOrgTeamMember } from '$lib/utils/store/org';
  import { apprenticeshipsBase } from '../utils/paths';
  import { PortfolioStore } from '../stores/portfolio.svelte';
  import SummaryStrip from '../components/portfolio/summary-strip.svelte';
  import UnitsTab from '../components/portfolio/units-tab.svelte';
  import CriteriaGrid from '../components/portfolio/criteria-grid.svelte';
  import EvidenceTab from '../components/portfolio/evidence-tab.svelte';
  import OtjTab from '../components/portfolio/otj-tab.svelte';
  import GatewayTab from '../components/portfolio/gateway-tab.svelte';
  import AchievedTab from '../components/portfolio/achieved-tab.svelte';
  import TasksTab from '../components/portfolio/tasks-tab.svelte';
  import ReviewsTab from '../components/portfolio/reviews-tab.svelte';
  import DatesDialog from '../components/portfolio/dates-dialog.svelte';
  import SpreadDialog from '../components/portfolio/spread-dialog.svelte';
  import EvidenceSheet from '../components/evidence/evidence-sheet.svelte';

  // Gecko Apprenticeships — one learner's portfolio on a single page. Everything opens in place (units expand,
  // evidence opens in a side sheet); one store owns the data so every part of the page agrees after any change.

  // Shared by admins, the allocated tutor and (Phase C) the apprentice themselves; staff-only controls hide for the
  // apprentice and the API refuses them anyway. showBack=false when the learner's only portfolio IS their landing page.
  interface Props {
    enrolmentId: string;
    showBack?: boolean;
  }
  let { enrolmentId, showBack = true }: Props = $props();
  const isStaffViewer = $derived($isOrgTeamMember === true);

  // svelte-ignore state_referenced_locally
  const store = new PortfolioStore(enrolmentId);
  let datesOpen = $state(false);
  let spreadOpen = $state(false);

  onMount(() => {
    store.load();
  });

  // A notification links here with ?tab=tasks|reviews: open on that tab (once the portfolio has loaded), then drop it.
  const TABS = ['units', 'map', 'evidence', 'tasks', 'reviews', 'otj', 'gateway', 'achieved'];
  let openedTab = false;
  $effect(() => {
    if (openedTab || !store.data) return;
    const t = appPage.url.searchParams.get('tab');
    if (!t) return;
    openedTab = true;
    if (TABS.includes(t)) store.tab = t;
    const url = new URL(appPage.url);
    url.searchParams.delete('tab');
    replaceState(url, appPage.state);
  });

  // A notification links here with ?evidence={id}: open that piece once the portfolio has loaded, then drop the
  // parameter so a refresh or Back doesn't keep re-opening it.
  let openedFromLink = false;
  $effect(() => {
    if (openedFromLink || !store.data) return;
    const id = appPage.url.searchParams.get('evidence');
    if (!id) return;
    openedFromLink = true;
    store.openEvidence(id);
    const url = new URL(appPage.url);
    url.searchParams.delete('evidence');
    replaceState(url, appPage.state);
  });

  const metIds = $derived(
    new Set(
      (store.data?.qualifications ?? []).flatMap((q) =>
        q.units.flatMap((u) => u.criteria.filter((c) => c.met).map((c) => c.id))
      )
    )
  );
  const backHref = $derived(apprenticeshipsBase(appPage.url.pathname, $currentOrg.siteName));
</script>

<svelte:head>
  <title>{store.data?.learner.name ?? 'Portfolio'} — Apprenticeships</title>
</svelte:head>

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      {#if showBack}
        <BackButton href={backHref} label={isStaffViewer ? 'All learners' : 'My apprenticeships'} />
      {/if}
      <Page.Title>{isStaffViewer ? 'Portfolio' : 'My apprenticeship'}</Page.Title>
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
          {#if store.evidenceBlocked}
            <p
              role="status"
              class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
            >
              {store.blockedMessage}
            </p>
          {/if}

          <Tabs.Root bind:value={store.tab}>
            <Tabs.List class="ui:h-auto ui:flex-wrap">
              <Tabs.Trigger value="units">Units</Tabs.Trigger>
              <Tabs.Trigger value="map">Criteria map</Tabs.Trigger>
              <Tabs.Trigger value="evidence">
                Evidence
                <span class="text-xs text-(--muted-foreground)">({store.evidence.length})</span>
              </Tabs.Trigger>
              <Tabs.Trigger value="tasks">
                Tasks
                <span class="text-xs text-(--muted-foreground)">({store.tasks.length})</span>
                {#if store.overdueTaskCount > 0}
                  <span
                    class="ml-1 rounded-full bg-rose-600 px-1.5 text-xs font-medium text-white"
                    aria-label="{store.overdueTaskCount} overdue">{store.overdueTaskCount}</span
                  >
                {/if}
              </Tabs.Trigger>
              <Tabs.Trigger value="reviews">
                Reviews
                {#if store.nextReview?.overdue}
                  <span class="ml-1 rounded-full bg-rose-600 px-1.5 text-xs font-medium text-white">Overdue</span>
                {/if}
              </Tabs.Trigger>
              <Tabs.Trigger value="otj">Hours</Tabs.Trigger>
              <Tabs.Trigger value="gateway">Gateway</Tabs.Trigger>
              <Tabs.Trigger value="achieved">Achieved</Tabs.Trigger>
            </Tabs.List>
            <div class="mt-4 min-h-64">
              <Tabs.Content value="units"><UnitsTab {store} /></Tabs.Content>
              <Tabs.Content value="map"><CriteriaGrid {store} /></Tabs.Content>
              <Tabs.Content value="evidence"><EvidenceTab {store} /></Tabs.Content>
              <Tabs.Content value="tasks"><TasksTab {store} /></Tabs.Content>
              <Tabs.Content value="reviews"><ReviewsTab {store} /></Tabs.Content>
              <Tabs.Content value="otj"><OtjTab {store} /></Tabs.Content>
              <Tabs.Content value="gateway"><GatewayTab {store} /></Tabs.Content>
              <Tabs.Content value="achieved"><AchievedTab {store} /></Tabs.Content>
            </div>
          </Tabs.Root>
        </div>

        {#if isStaffViewer}
          <DatesDialog bind:open={datesOpen} {store} />
          <SpreadDialog bind:open={spreadOpen} {store} />
        {/if}
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
