<script lang="ts">
  import { onMount } from 'svelte';
  import * as Page from '@cio/ui/base/page';
  import * as Tabs from '@cio/ui/base/tabs';
  import * as DropdownMenu from '@cio/ui/base/dropdown-menu';
  import { Button } from '@cio/ui/base/button';
  import { Skeleton } from '@cio/ui/base/skeleton';
  import { BackButton } from '@cio/ui/custom/back-button';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import { page as appPage } from '$app/state';
  import { replaceState } from '$app/navigation';
  import { currentOrg, isOrgAdmin, isOrgTeamMember } from '$lib/utils/store/org';
  import { apprenticeshipsBase } from '../utils/paths';
  import { tutorNames } from '../api/enrolments.svelte';
  import ProgrammeTypeChip from '../components/shared/programme-type-chip.svelte';
  import { PortfolioStore } from '../stores/portfolio.svelte';
  import SummaryStrip from '../components/portfolio/summary-strip.svelte';
  import UnitsTab from '../components/portfolio/units-tab.svelte';
  import CriteriaGrid from '../components/portfolio/criteria-grid.svelte';
  import EvidenceTab from '../components/portfolio/evidence-tab.svelte';
  import OtjTab from '../components/portfolio/otj-tab.svelte';
  import GatewayTab from '../components/portfolio/gateway-tab.svelte';
  import AchievedTab from '../components/portfolio/achieved-tab.svelte';
  import TasksTab from '../components/portfolio/tasks-tab.svelte';
  import ResourcesTab from '../components/portfolio/resources-tab.svelte';
  import ReviewsTab from '../components/portfolio/reviews-tab.svelte';
  import OnboardingTab from '../components/onboarding/onboarding-tab.svelte';
  import OverviewTab from '../components/overview/overview-tab.svelte';
  import DatesDialog from '../components/portfolio/dates-dialog.svelte';
  import TutorsDialog from '../components/portfolio/tutors-dialog.svelte';
  import SpreadDialog from '../components/portfolio/spread-dialog.svelte';
  import { fmtDate } from '../components/shared/format';
  import PdfDownloadButton from '../components/shared/pdf-download-button.svelte';
  import EvidenceSheet from '../components/evidence/evidence-sheet.svelte';

  // Gecko Apprenticeships — one learner's portfolio on a single page. Everything opens in place (units expand,
  // evidence opens in a side sheet); one store owns the data so every part of the page agrees after any change.
  // Tabs: Overview (default) · Units · Evidence · Tasks · OTJ progress · More (Reviews, Gateway, Onboarding, Achieved,
  // Criteria map). A paired apprenticeship (Diploma + Standard) opens on its carrier; a component id selects that
  // qualification on the Units tab.

  // Shared by admins, the allocated tutor and (Phase C) the apprentice themselves; staff-only controls hide for the
  // apprentice and the API refuses them anyway. showBack=false when the learner's only portfolio IS their landing page.
  interface Props {
    enrolmentId: string;
    showBack?: boolean;
    /** Defaults to 'staff' for org team members, otherwise 'learner'. */
    mode?: 'staff' | 'learner';
    /** Qualification page for one enrolment of the pair (default: `<this page>/qualification/<id>`). */
    qualHref?: (qualEnrolmentId: string) => string;
    /** Unit page (default: `<qualification page>/units/<unitId>`). */
    unitHref?: (qualEnrolmentId: string, unitId: string) => string;
  }
  let { enrolmentId, showBack = true, mode, qualHref, unitHref }: Props = $props();
  const isStaffViewer = $derived($isOrgTeamMember === true);
  const viewMode = $derived<'staff' | 'learner'>(mode ?? (isStaffViewer ? 'staff' : 'learner'));

  const here = $derived(appPage.url.pathname.replace(/\/+$/, ''));
  const toQual = $derived(qualHref ?? ((q: string) => `${here}/qualification/${q}`));
  const toUnit = $derived(unitHref ?? ((q: string, u: string) => `${toQual(q)}/units/${u}`));

  // svelte-ignore state_referenced_locally
  const store = new PortfolioStore(enrolmentId);
  let datesOpen = $state(false);
  // Which qualification the dates dialog edits (the carrier by default).
  let datesTarget = $state<string | undefined>(undefined);
  function editDates(qualEnrolmentId?: string) {
    datesTarget = qualEnrolmentId;
    datesOpen = true;
  }
  let tutorsOpen = $state(false);
  let spreadOpen = $state(false);

  // Reinstate the whole withdrawn apprenticeship: the carrier first, then its paired qualification.
  async function reinstateAll() {
    if (!(await store.reinstate(store.enrolmentId))) return;
    const other = store.pair?.enrolment.id;
    if (other && store.pair?.enrolment.withdrawnAt) await store.reinstate(other);
  }

  onMount(() => {
    store.load();
  });

  // A notification links here with ?tab=tasks|reviews: open on that tab (once the portfolio has loaded), then drop it.
  const MORE_TABS = [
    { value: 'reviews', label: 'Reviews' },
    { value: 'gateway', label: 'Gateway' },
    { value: 'onboarding', label: 'Onboarding' },
    { value: 'achieved', label: 'Achieved' },
    { value: 'map', label: 'Criteria map' }
  ];
  const TABS = ['overview', 'units', 'evidence', 'tasks', 'resources', 'otj', ...MORE_TABS.map((t) => t.value)];
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

  // A page opened with the Standard's enrolment id lands on the Units tab with that qualification selected.
  let landed = false;
  $effect(() => {
    if (landed || !store.data) return;
    landed = true;
    if (store.requestedId !== store.enrolmentId && !openedTab) store.tab = 'units';
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

  const backHref = $derived(apprenticeshipsBase(appPage.url.pathname, $currentOrg.siteName));
  const moreActive = $derived(MORE_TABS.find((t) => t.value === store.tab));
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
      <Page.Title>{isStaffViewer ? (store.data?.learner.name ?? 'Portfolio') : 'My apprenticeship'}</Page.Title>
      {#if isStaffViewer && store.data}
        <Page.Subtitle>
          <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>Apprentice</span>
            {#each store.portfolios as p, i (p.enrolment.id)}
              <span aria-hidden="true">{i === 0 ? '·' : '+'}</span>
              <span class="inline-flex items-center gap-1.5">
                {p.programme.title}
                {#if p.programme.type}<ProgrammeTypeChip type={p.programme.type} />{/if}
              </span>
            {/each}
            <span aria-hidden="true">·</span>
            <span>Tutor: {tutorNames(store.data.tutors)}</span>
          </span>
        </Page.Subtitle>
      {/if}
    </Page.HeaderContent>
    {#if store.data}
      <Page.Action><PdfDownloadButton enrolmentId={store.activePortfolio?.enrolment.id ?? enrolmentId} /></Page.Action>
    {/if}
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
          <SummaryStrip {store} onSpread={() => (spreadOpen = true)} onTutors={() => (tutorsOpen = true)} />
          {#if store.withdrawal}
            <div
              role="status"
              class="flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
            >
              <p>
                <strong>Withdrawn.</strong> This apprenticeship was withdrawn on {fmtDate(store.withdrawal.at)} — read only.
                {#if store.withdrawal.reason}<span class="block">Reason: {store.withdrawal.reason}</span>{/if}
              </p>
              {#if isStaffViewer && $isOrgAdmin}
                <Button
                  variant="outline"
                  size="sm"
                  onclick={reinstateAll}
                  loading={store.saving}
                  disabled={store.saving}
                >
                  Reinstate
                </Button>
              {/if}
            </div>
          {/if}
          {#if store.evidenceBlocked}
            <p
              role="status"
              class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
            >
              {store.blockedMessage}
            </p>
          {/if}

          <Tabs.Root bind:value={store.tab}>
            <div class="-mx-1 overflow-x-auto px-1 pb-1" role="presentation">
              <Tabs.List class="ui:h-auto ui:w-max ui:min-w-full ui:flex-nowrap ui:justify-start">
                <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
                <Tabs.Trigger value="units">Units</Tabs.Trigger>
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
                {#if isStaffViewer}<Tabs.Trigger value="resources">Resources</Tabs.Trigger>{/if}
                <Tabs.Trigger value="otj">OTJ progress</Tabs.Trigger>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger
                    class="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-sm font-medium whitespace-nowrap hover:bg-(--background)/60 {moreActive
                      ? 'bg-(--background) shadow-sm'
                      : 'text-(--muted-foreground)'}"
                  >
                    {moreActive?.label ?? 'More'}
                    {#if store.nextReview?.overdue && !moreActive}
                      <span class="size-2 rounded-full bg-rose-600" aria-label="Review overdue"></span>
                    {/if}
                    <ChevronDownIcon size={14} />
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content align="start">
                    {#each MORE_TABS as t (t.value)}
                      <DropdownMenu.Item onclick={() => (store.tab = t.value)}>
                        {t.label}
                        {#if t.value === 'reviews' && store.nextReview?.overdue}
                          <span class="ml-2 rounded-full bg-rose-600 px-1.5 text-xs font-medium text-white"
                            >Overdue</span
                          >
                        {/if}
                      </DropdownMenu.Item>
                    {/each}
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              </Tabs.List>
            </div>
            <div class="mt-4 min-h-64">
              <Tabs.Content value="overview">
                <OverviewTab
                  {store}
                  mode={viewMode}
                  qualHref={toQual}
                  unitHref={toUnit}
                  onEditDates={isStaffViewer && $isOrgAdmin ? editDates : undefined}
                />
              </Tabs.Content>
              <Tabs.Content value="units"><UnitsTab {store} unitHref={toUnit} /></Tabs.Content>
              <Tabs.Content value="evidence"><EvidenceTab {store} /></Tabs.Content>
              <Tabs.Content value="tasks"><TasksTab {store} /></Tabs.Content>
              <Tabs.Content value="resources">
                {#if isStaffViewer}<ResourcesTab {store} />{/if}
              </Tabs.Content>
              <Tabs.Content value="otj"><OtjTab {store} /></Tabs.Content>
              <Tabs.Content value="reviews"><ReviewsTab {store} /></Tabs.Content>
              <Tabs.Content value="gateway"><GatewayTab {store} /></Tabs.Content>
              <Tabs.Content value="onboarding"><OnboardingTab enrolmentId={store.enrolmentId} /></Tabs.Content>
              <Tabs.Content value="achieved"><AchievedTab {store} /></Tabs.Content>
              <Tabs.Content value="map"><CriteriaGrid {store} /></Tabs.Content>
            </div>
          </Tabs.Root>
        </div>

        {#if isStaffViewer}
          <DatesDialog bind:open={datesOpen} {store} enrolmentId={datesTarget} />
          {#if $isOrgAdmin}<TutorsDialog bind:open={tutorsOpen} {store} />{/if}
          <SpreadDialog bind:open={spreadOpen} {store} />
        {/if}
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
          learnerName={store.data.learner.name}
          onChanged={() => store.refresh()}
        />
      {/if}
    {/snippet}
  </Page.Body>
</Page.Root>
