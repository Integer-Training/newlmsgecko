<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import * as Page from '@cio/ui/base/page';
  import * as Select from '@cio/ui/base/select';
  import * as Table from '@cio/ui/base/table';
  import { Button } from '@cio/ui/base/button';
  import { Skeleton } from '@cio/ui/base/skeleton';
  import { Search } from '@cio/ui/custom/search';
  import { Empty } from '@cio/ui/custom/empty';
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import { APPR_PROGRESS_STATUSES, type ApprProgressStatus } from '@cio/utils/constants/apprenticeship';
  import { currentOrg } from '$lib/utils/store/org';
  import { enrolmentsApi, tutorNames } from '../api/enrolments.svelte';
  import AddLearnerDialog from '../components/learners/add-learner-dialog.svelte';
  import ProgressBar from '../components/shared/progress-bar.svelte';
  import StatusChip from '../components/shared/status-chip.svelte';
  import { fmtMinutes, fmtPct, STATUS_LABEL } from '../components/shared/format';

  // Gecko Apprenticeships — the learners table. One row per enrolment: qualification progress against where the
  // learner should be, off-the-job hours, RAG status, tutor and how much is waiting to be marked. Filters and the
  // per-status counts come from the API; paging is server-side.

  const PAGE_SIZE = 25;

  let programmeId = $state('');
  let tutorId = $state('');
  let status = $state<ApprProgressStatus | ''>('');
  let searchValue = $state('');
  let debouncedSearch = $state('');
  let page = $state(1);
  let addOpen = $state(false);
  let retry = $state(0);

  const base = $derived(`/org/${$currentOrg.siteName}/apprenticeships`);
  const list = $derived(enrolmentsApi.list);
  const totalPages = $derived(list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1);
  const hasFilters = $derived(!!programmeId || !!tutorId || !!status || !!debouncedSearch);

  onMount(() => {
    enrolmentsApi.loadOptions();
  });

  // Debounce typing so the table doesn't refetch per keystroke.
  $effect(() => {
    const v = searchValue;
    const t = setTimeout(() => (debouncedSearch = v), 300);
    return () => clearTimeout(t);
  });

  // Any filter change goes back to page 1 and refetches; so does paging.
  let lastKey = '';
  $effect(() => {
    const key = JSON.stringify([programmeId, tutorId, status, debouncedSearch]);
    let p = page;
    if (key !== lastKey) {
      if (lastKey !== '' && p !== 1) {
        p = 1;
        untrack(() => (page = 1));
      }
      lastKey = key;
    }
    retry;
    const filters = {
      programmeId: programmeId || undefined,
      tutorId: tutorId || undefined,
      status: status || undefined,
      search: debouncedSearch || undefined,
      page: p,
      pageSize: PAGE_SIZE
    };
    untrack(() => enrolmentsApi.load(filters));
  });

  function reset() {
    programmeId = '';
    tutorId = '';
    status = '';
    searchValue = '';
    debouncedSearch = '';
  }

  function open(id: string) {
    goto(`${base}/learners/${id}`);
  }

  const programmeLabel = $derived(
    programmeId ? (enrolmentsApi.programmes.find((p) => p.id === programmeId)?.title ?? 'Programme') : 'All programmes'
  );
  const tutorLabel = $derived.by(() => {
    if (!tutorId) return 'All tutors';
    const t = enrolmentsApi.tutors.find((x) => x.id === tutorId);
    return t?.name ?? t?.email ?? 'Tutor';
  });
</script>

<svelte:head>
  <title>Apprenticeship learners — {$currentOrg.name}</title>
</svelte:head>

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      <Page.Title>Apprenticeship learners</Page.Title>
      <Page.Subtitle>Progress, off-the-job hours and marking · {$currentOrg.name}</Page.Subtitle>
    </Page.HeaderContent>
    <Page.Action>
      <Button variant="outline" href="{base}/to-mark">To mark</Button>
      <Button onclick={() => (addOpen = true)}>
        <UserPlusIcon size={16} class="mr-1" /> Add learner
      </Button>
    </Page.Action>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      <!-- Status quick chips with the API's counts -->
      <div class="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        <button
          type="button"
          aria-pressed={status === ''}
          class="rounded-full border px-3 py-1 text-sm {status === ''
            ? 'bg-primary text-primary-foreground border-primary'
            : 'hover:bg-muted'}"
          onclick={() => (status = '')}
        >
          All
        </button>
        {#each APPR_PROGRESS_STATUSES as s (s)}
          <button
            type="button"
            aria-pressed={status === s}
            class="rounded-full border px-3 py-1 text-sm {status === s
              ? 'bg-primary text-primary-foreground border-primary'
              : 'hover:bg-muted'}"
            onclick={() => (status = status === s ? '' : s)}
          >
            {STATUS_LABEL(s)}
            <span class="ml-1 opacity-70">{list?.statusCounts?.[s] ?? 0}</span>
          </button>
        {/each}
      </div>

      <div class="mb-4 flex flex-wrap items-end gap-3">
        <div class="flex flex-col gap-1">
          <span class="text-muted-foreground text-xs" id="lf-prog">Programme</span>
          <Select.Root type="single" bind:value={programmeId}>
            <Select.Trigger class="min-w-[200px]" aria-labelledby="lf-prog"
              ><p class="truncate">{programmeLabel}</p></Select.Trigger
            >
            <Select.Content>
              <Select.Item value="">All programmes</Select.Item>
              {#each enrolmentsApi.programmes as p (p.id)}
                <Select.Item value={p.id}>{p.title}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-muted-foreground text-xs" id="lf-tutor">Tutor</span>
          <Select.Root type="single" bind:value={tutorId}>
            <Select.Trigger class="min-w-[180px]" aria-labelledby="lf-tutor"
              ><p class="truncate">{tutorLabel}</p></Select.Trigger
            >
            <Select.Content>
              <Select.Item value="">All tutors</Select.Item>
              {#each enrolmentsApi.tutors as t (t.id)}
                <Select.Item value={t.id}>{t.name ?? t.email ?? 'Tutor'}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-muted-foreground text-xs">Search</span>
          <Search placeholder="Learner name or email" class="ui:max-w-[260px]" bind:value={searchValue} />
        </div>
        {#if hasFilters}
          <Button variant="ghost" onclick={reset}>Reset filters</Button>
        {/if}
      </div>

      {#if enrolmentsApi.listError && !list}
        <div class="rounded-lg border border-rose-200 p-6 text-center">
          <p role="alert" class="text-sm text-rose-600">{enrolmentsApi.listError}</p>
          <Button variant="outline" size="sm" class="mt-3" onclick={() => (retry += 1)}>Try again</Button>
        </div>
      {:else if !list}
        <div class="space-y-2" role="status" aria-label="Loading learners">
          {#each Array(6) as _, i (i)}<Skeleton class="h-14 w-full" />{/each}
        </div>
      {:else if list.items.length === 0}
        <Empty
          title={hasFilters ? 'No learners match' : 'No apprentices yet'}
          description={hasFilters ? 'Try different filters.' : 'Add a learner to start tracking their portfolio.'}
        />
      {:else}
        <div
          class="overflow-x-auto rounded-lg border {enrolmentsApi.isLoading ? 'opacity-70' : ''}"
          aria-busy={enrolmentsApi.isLoading}
        >
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Learner</Table.Head>
                <Table.Head class="min-w-52">Qualification</Table.Head>
                <Table.Head class="min-w-52">Off-the-job</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Tutor</Table.Head>
                <Table.Head class="text-right">To mark</Table.Head>
                <Table.Head><span class="sr-only">Actions</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each list.items as r (r.id)}
                <Table.Row class="cursor-pointer" onclick={() => open(r.id)}>
                  <Table.Cell>
                    <p class="font-medium">{r.learner.name}</p>
                    <p class="text-muted-foreground text-xs">{r.programmeTitle}</p>
                  </Table.Cell>
                  <Table.Cell>
                    <ProgressBar
                      actual={r.actualPct}
                      expected={r.expectedPct}
                      label="{r.learner.name} qualification progress"
                    />
                    <p class="text-muted-foreground mt-1 text-xs">
                      {fmtPct(r.actualPct)}{r.expectedPct !== null ? ` · expected ${r.expectedPct}%` : ' · expected —'}
                    </p>
                  </Table.Cell>
                  <Table.Cell>
                    <ProgressBar
                      actual={r.otj.targetMinutes ? Math.floor((r.otj.minutes / r.otj.targetMinutes) * 100) : null}
                      expected={r.otj.targetMinutes && r.otj.expectedMinutes !== null
                        ? Math.round((r.otj.expectedMinutes / r.otj.targetMinutes) * 100)
                        : null}
                      label="{r.learner.name} off-the-job hours"
                    />
                    <p class="text-muted-foreground mt-1 text-xs">
                      {fmtMinutes(r.otj.minutes)} done · {fmtMinutes(r.otj.expectedMinutes)} expected · {fmtMinutes(
                        r.otj.targetMinutes
                      )} target
                    </p>
                  </Table.Cell>
                  <Table.Cell><StatusChip status={r.status} /></Table.Cell>
                  <Table.Cell class="text-sm">{tutorNames(r.tutors)}</Table.Cell>
                  <Table.Cell class="text-right">
                    {#if r.toMark > 0}
                      <span
                        class="inline-flex min-w-6 items-center justify-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
                        aria-label="{r.toMark} to mark">{r.toMark}</span
                      >
                    {:else}
                      <span class="text-muted-foreground">0</span>
                    {/if}
                  </Table.Cell>
                  <Table.Cell>
                    <Button
                      variant="outline"
                      size="sm"
                      href="{base}/learners/{r.id}"
                      aria-label="View {r.learner.name}"
                      onclick={(e: MouseEvent) => e.stopPropagation()}
                    >
                      View
                    </Button>
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </div>

        <div class="mt-3 flex items-center justify-between text-sm">
          <span class="text-muted-foreground">{list.total} learner{list.total === 1 ? '' : 's'}</span>
          {#if totalPages > 1}
            <div class="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onclick={() => (page -= 1)}>Previous</Button>
              <span aria-live="polite">Page {page} of {totalPages}</span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onclick={() => (page += 1)}>Next</Button
              >
            </div>
          {/if}
        </div>
      {/if}
    {/snippet}
  </Page.Body>
</Page.Root>

<AddLearnerDialog bind:open={addOpen} onCreated={(id) => goto(`${base}/learners/${id}`)} />
