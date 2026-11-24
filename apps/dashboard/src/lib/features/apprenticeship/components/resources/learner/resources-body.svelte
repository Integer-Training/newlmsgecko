<script lang="ts">
  import { onMount } from 'svelte';
  import * as Page from '@cio/ui/base/page';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Skeleton } from '@cio/ui/base/skeleton';
  import { Empty } from '@cio/ui/custom/empty';
  import BookOpenIcon from '@lucide/svelte/icons/book-open';
  import SearchIcon from '@lucide/svelte/icons/search';
  import {
    resourcesLearnerApi,
    type LearnerResourceItem,
    type LearnerResourceList
  } from '../../../api/resources-learner.svelte';
  import { PortfolioStore } from '../../../stores/portfolio.svelte';
  import EvidenceSheet from '../../evidence/evidence-sheet.svelte';
  import LearnerResourceListView from './learner-resource-list.svelte';
  import ResourceViewer from './resource-viewer.svelte';
  import { ResourceActions } from './resource-actions.svelte';
  import { buildSections, matchesQuery, type KindFilter } from './resource-utils';

  // Resources, grouped Programme -> General -> units, with search and Learning / Workbooks filters. ONE resources
  // request per page load (the viewer fetches a file only when opened). The portfolio store loads alongside for the
  // unit order and the evidence form (criteria tree) used by "Upload completed workbook".

  interface Props {
    enrolmentId: string;
  }
  let { enrolmentId }: Props = $props();

  // svelte-ignore state_referenced_locally
  const store = new PortfolioStore(enrolmentId);

  let data = $state<LearnerResourceList | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let query = $state('');
  let filter = $state<KindFilter>('ALL');

  async function load() {
    loading = data === null;
    error = null;
    const res = await resourcesLearnerApi.forEnrolment(enrolmentId);
    loading = false;
    if (res.ok) data = res.data;
    else error = res.error;
  }

  function patch(id: string, p: Partial<LearnerResourceItem>) {
    if (!data) return;
    data = { ...data, resources: data.resources.map((r) => (r.id === id ? { ...r, ...p } : r)) };
  }
  const actions = new ResourceActions(store, patch);

  onMount(() => {
    void load();
    void store.load();
  });

  // The evidence sheet lists criteria already met (same set the other apprentice pages pass).
  const metIds = $derived(
    new Set(
      (store.data?.qualifications ?? []).flatMap((q) =>
        q.units.flatMap((u) => u.criteria.filter((c) => c.met).map((c) => c.id))
      )
    )
  );

  const all = $derived(data?.resources ?? []);
  const counts = $derived({
    ALL: all.length,
    LEARNING: all.filter((r) => r.kind === 'LEARNING').length,
    WORKBOOK: all.filter((r) => r.kind === 'WORKBOOK').length
  });
  const visible = $derived(all.filter((r) => (filter === 'ALL' || r.kind === filter) && matchesQuery(r, query)));

  function unitOrderOf(programmeId: string): string[] {
    const p = store.portfolios.find((x) => x.programme.id === programmeId);
    return (p?.qualifications ?? []).flatMap((q) => q.units.map((u) => u.id));
  }
  // Re-derives once the portfolio has loaded (units then fall into portfolio order).
  const sections = $derived.by(() => {
    void store.portfolios.length;
    return buildSections(data?.programmes ?? [], visible, unitOrderOf);
  });

  const FILTERS: { key: KindFilter; label: string }[] = [
    { key: 'ALL', label: 'All' },
    { key: 'LEARNING', label: 'Learning' },
    { key: 'WORKBOOK', label: 'Workbooks' }
  ];
</script>

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      <Page.Title>Resources</Page.Title>
    </Page.HeaderContent>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      {#if loading}
        <div class="space-y-3" role="status" aria-label="Loading resources">
          <Skeleton class="h-10 w-full max-w-md" />
          <Skeleton class="h-24 w-full" />
          <Skeleton class="h-24 w-full" />
          <Skeleton class="h-24 w-full" />
        </div>
      {:else if error && !data}
        <div class="rounded-lg border border-rose-200 p-6 text-center">
          <p role="alert" class="text-sm text-rose-600">{error}</p>
          <Button variant="outline" size="sm" class="mt-3" onclick={load}>Try again</Button>
        </div>
      {:else if all.length === 0}
        <Empty
          title="Your tutor hasn't added resources yet"
          description="Learning resources and workbooks for your apprenticeship will appear here."
          icon={BookOpenIcon}
          variant="page"
        />
      {:else}
        <div class="space-y-4">
          <p class="text-sm text-(--muted-foreground)">
            Learning resources are view only. Workbooks can be downloaded, completed and uploaded back as evidence.
          </p>

          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div class="relative w-full sm:max-w-sm">
              <SearchIcon
                size={16}
                class="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-(--muted-foreground)"
                aria-hidden="true"
              />
              <Input
                type="search"
                class="ps-9"
                placeholder="Search resources"
                aria-label="Search resources"
                bind:value={query}
              />
            </div>
            <div class="flex flex-wrap gap-1.5" role="group" aria-label="Filter by type">
              {#each FILTERS as f (f.key)}
                <button
                  type="button"
                  aria-pressed={filter === f.key}
                  class="rounded-full border px-3 py-1 text-sm transition-colors {filter === f.key
                    ? 'border-(--primary) bg-(--primary) text-(--primary-foreground)'
                    : 'hover:bg-(--muted)'}"
                  onclick={() => (filter = f.key)}
                >
                  {f.label} <span class="opacity-70">({counts[f.key]})</span>
                </button>
              {/each}
            </div>
          </div>

          {#if error}
            <p
              role="alert"
              class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
            >
              {error}
              <button type="button" class="underline" onclick={load}>Try again</button>
            </p>
          {/if}

          {#if store.evidenceBlocked}
            <p
              role="status"
              class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
            >
              {store.blockedMessage}
            </p>
          {/if}

          {#if visible.length === 0}
            <div class="rounded-lg border border-dashed p-6 text-center text-sm text-(--muted-foreground)">
              No resources match your search.
              <button
                type="button"
                class="font-medium underline"
                onclick={() => {
                  query = '';
                  filter = 'ALL';
                }}
              >
                Clear filters
              </button>
            </div>
          {:else}
            <LearnerResourceListView
              {sections}
              {actions}
              uploadBlocked={store.evidenceBlocked}
              uploadBlockedReason={store.blockedMessage}
            />
          {/if}
        </div>

        <ResourceViewer
          bind:open={actions.viewerOpen}
          resource={actions.viewing}
          downloading={!!actions.downloadingId}
          canUpload={!store.evidenceBlocked}
          onDownload={(r) => actions.download(r)}
          onUpload={(r) => actions.upload(r)}
        />

        <EvidenceSheet
          bind:open={store.sheet.open}
          mode={store.sheet.mode}
          evidenceId={store.sheet.evidenceId}
          enrolmentId={store.sheetEnrolmentId}
          tree={store.pickerTree}
          {metIds}
          preCriteria={store.sheet.criterionIds}
          tasks={store.tasks}
          editBlocked={store.evidenceBlocked}
          preTaskId={store.sheet.taskId}
          preResource={store.sheet.resource}
          learnerName={store.data?.learner.name ?? null}
          onChanged={() => {
            void store.refresh();
            void load();
          }}
        />
      {/if}
    {/snippet}
  </Page.Body>
</Page.Root>
