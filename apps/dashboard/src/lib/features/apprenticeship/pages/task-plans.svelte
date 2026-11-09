<script lang="ts">
  import { onMount } from 'svelte';
  import * as Page from '@cio/ui/base/page';
  import { Badge } from '@cio/ui/base/badge';
  import { Button } from '@cio/ui/base/button';
  import { Spinner } from '@cio/ui/base/spinner';
  import * as Table from '@cio/ui/base/table';
  import * as Select from '@cio/ui/base/select';
  import { Search } from '@cio/ui/custom/search';
  import { Empty } from '@cio/ui/custom/empty';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import ClipboardListIcon from '@lucide/svelte/icons/clipboard-list';
  import { currentOrg } from '$lib/utils/store/org';
  import { classroomio } from '$lib/utils/services/api';
  import { call } from '../api/call';
  import { taskPlansApi, type TaskPlanListItem, type TaskPlanStatus } from '../api/task-plans.svelte';
  import { fmtDate } from '../components/shared/format';
  import NewPlanDialog from '../components/task-plans/new-plan-dialog.svelte';

  // Admin task plans list: filter by programme and status, search by title. Loads every plan once (status and
  // programme filters are applied client-side; the list is small).
  const ANY = '__any__';
  const STATUS_LABELS: Record<TaskPlanStatus, string> = { ACTIVE: 'Active', ARCHIVED: 'Archived' };

  let plans = $state<TaskPlanListItem[] | null>(null);
  let programmes = $state<{ id: string; title: string }[]>([]);
  let loadError = $state<string | null>(null);
  let search = $state('');
  let statusFilter = $state<TaskPlanStatus>('ACTIVE');
  let programmeFilter = $state(ANY);
  let showCreate = $state(false);

  async function load() {
    loadError = null;
    const res = await taskPlansApi.list();
    if (res.ok) plans = res.data;
    else loadError = res.error;
  }

  onMount(async () => {
    load();
    const res = await call<{ id: string; title: string }[]>(() =>
      classroomio.apprenticeship.programmes.$get({ query: { status: 'ACTIVE' } })
    );
    if (res.ok) programmes = res.data.map((p) => ({ id: p.id, title: p.title }));
  });

  const programmeLabel = $derived(
    programmeFilter === ANY
      ? 'All programmes'
      : (programmes.find((p) => p.id === programmeFilter)?.title ?? 'Programme')
  );

  const filtered = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return (plans ?? []).filter((p) => {
      if (p.status !== statusFilter) return false;
      if (programmeFilter !== ANY && p.programmeId !== programmeFilter) return false;
      return !q || p.title.toLowerCase().includes(q) || p.programmeTitle.toLowerCase().includes(q);
    });
  });

  const base = $derived(`/org/${$currentOrg.siteName}/apprenticeships/task-plans`);

  function windowText(p: TaskPlanListItem) {
    if (!p.validFrom && !p.validTo) return 'Any time';
    if (p.validFrom && p.validTo) return `${fmtDate(p.validFrom)} – ${fmtDate(p.validTo)}`;
    return p.validFrom ? `From ${fmtDate(p.validFrom)}` : `Until ${fmtDate(p.validTo)}`;
  }
</script>

<svelte:head><title>Task plans — Gecko Apprenticeships</title></svelte:head>

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      <Page.Title>Task plans</Page.Title>
      <Page.Subtitle>Reusable sets of tasks you assign to learners · {$currentOrg.name}</Page.Subtitle>
    </Page.HeaderContent>
    <Page.Action>
      <Button onclick={() => (showCreate = true)}>
        <PlusIcon class="size-4" /> New task plan
      </Button>
    </Page.Action>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      <div class="mb-4 flex flex-wrap items-end gap-3">
        <div class="flex flex-col gap-1">
          <span class="text-xs text-(--muted-foreground)">Programme</span>
          <Select.Root type="single" bind:value={programmeFilter}>
            <Select.Trigger class="min-w-[200px]" aria-label="Filter by programme">
              <p class="truncate">{programmeLabel}</p>
            </Select.Trigger>
            <Select.Content>
              <Select.Item value={ANY}>All programmes</Select.Item>
              {#each programmes as p (p.id)}
                <Select.Item value={p.id}>{p.title}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-xs text-(--muted-foreground)">Status</span>
          <Select.Root type="single" bind:value={statusFilter}>
            <Select.Trigger class="min-w-[130px]" aria-label="Filter by status">
              <p>{STATUS_LABELS[statusFilter]}</p>
            </Select.Trigger>
            <Select.Content>
              {#each Object.keys(STATUS_LABELS) as key (key)}
                <Select.Item value={key}>{STATUS_LABELS[key as TaskPlanStatus]}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-xs text-(--muted-foreground)">Search</span>
          <Search placeholder="Search task plans" bind:value={search} />
        </div>
      </div>

      {#if loadError && !plans}
        <div class="flex flex-col items-center gap-3 py-16" role="alert">
          <p class="text-sm text-red-600">{loadError}</p>
          <Button variant="outline" onclick={load}>Try again</Button>
        </div>
      {:else if !plans}
        <div class="flex justify-center py-16"><Spinner /></div>
      {:else if filtered.length === 0}
        <Empty
          title={plans.length === 0 ? 'No task plans yet' : 'No task plans to show'}
          description={plans.length === 0
            ? 'Create a task plan, add its tasks, then assign it to learners on the programme.'
            : 'No task plans match the current filters.'}
          icon={ClipboardListIcon}
          variant="page"
        >
          {#if plans.length === 0}
            <Button onclick={() => (showCreate = true)}><PlusIcon class="size-4" /> New task plan</Button>
          {/if}
        </Empty>
      {:else}
        <div class="overflow-x-auto rounded-md border">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Title</Table.Head>
                <Table.Head>Programme</Table.Head>
                <Table.Head>Valid</Table.Head>
                <Table.Head class="text-right">Tasks</Table.Head>
                <Table.Head class="text-right">Assigned learners</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head class="text-right"><span class="sr-only">Actions</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each filtered as p (p.id)}
                <Table.Row>
                  <Table.Cell class="min-w-56 font-medium break-words whitespace-normal!">
                    <a href="{base}/{p.id}" class="hover:underline">{p.title}</a>
                  </Table.Cell>
                  <Table.Cell class="break-words whitespace-normal!">{p.programmeTitle}</Table.Cell>
                  <Table.Cell>{windowText(p)}</Table.Cell>
                  <Table.Cell class="text-right tabular-nums">{p.itemCount}</Table.Cell>
                  <Table.Cell class="text-right tabular-nums">{p.assignedCount}</Table.Cell>
                  <Table.Cell>
                    <Badge variant={p.status === 'ACTIVE' ? 'success' : 'secondary'}>{STATUS_LABELS[p.status]}</Badge>
                  </Table.Cell>
                  <Table.Cell class="text-right">
                    <Button size="sm" variant="outline" href="{base}/{p.id}">Open</Button>
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </div>
      {/if}
    {/snippet}
  </Page.Body>
</Page.Root>

<NewPlanDialog
  bind:open={showCreate}
  {programmes}
  defaultProgrammeId={programmeFilter === ANY ? '' : programmeFilter}
/>
