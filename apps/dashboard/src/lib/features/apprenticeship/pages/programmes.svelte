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
  import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap';
  import ArchiveIcon from '@lucide/svelte/icons/archive';
  import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
  import { currentOrg } from '$lib/utils/store/org';
  import {
    programmesApi,
    type ProgrammeRow,
    type ProgrammeStatus
  } from '$features/apprenticeship/api/programmes.svelte';
  import NewProgrammeDialog from '$features/apprenticeship/components/programme/new-programme-dialog.svelte';

  // Admin programme catalogue. Loads every programme once; the status filter and search are client-side.
  let search = $state('');
  let statusFilter = $state<ProgrammeStatus>('ACTIVE');
  let showCreate = $state(false);
  let busyId = $state<string | null>(null);

  const STATUS_LABELS: Record<ProgrammeStatus, string> = { ACTIVE: 'Active', ARCHIVED: 'Archived' };

  onMount(() => {
    programmesApi.load('ALL');
  });

  const rows = $derived(programmesApi.programmes);
  const filtered = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return (rows ?? []).filter((p) => {
      if (p.status !== statusFilter) return false;
      if (!q) return true;
      return [p.title, p.reference ?? '', p.level ?? ''].some((v) => v.toLowerCase().includes(q));
    });
  });

  const base = $derived(`/org/${$currentOrg.siteName}/apprenticeships/programmes`);

  async function toggleArchive(p: ProgrammeRow) {
    busyId = p.id;
    await programmesApi.updateProgramme(p.id, { status: p.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE' });
    busyId = null;
  }
</script>

<svelte:head><title>Programmes — Gecko Apprenticeships</title></svelte:head>

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      <Page.Title>Programmes</Page.Title>
      <Page.Subtitle>Apprenticeship qualifications · {$currentOrg.name}</Page.Subtitle>
    </Page.HeaderContent>
    <Page.Action>
      <Button onclick={() => (showCreate = true)}>
        <PlusIcon class="size-4" /> New programme
      </Button>
    </Page.Action>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      <div class="mb-4 flex flex-wrap items-end gap-3">
        <div class="flex flex-col gap-1">
          <span class="text-muted-foreground text-xs">Status</span>
          <Select.Root type="single" bind:value={statusFilter}>
            <Select.Trigger class="min-w-[130px]" aria-label="Filter by status">
              <p>{STATUS_LABELS[statusFilter]}</p>
            </Select.Trigger>
            <Select.Content>
              {#each Object.keys(STATUS_LABELS) as key (key)}
                <Select.Item value={key}>{STATUS_LABELS[key as ProgrammeStatus]}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-muted-foreground text-xs">Search</span>
          <Search placeholder="Search programmes" bind:value={search} />
        </div>
      </div>

      {#if programmesApi.loadError && !rows}
        <div class="flex flex-col items-center gap-3 py-16" role="alert">
          <p class="text-sm text-red-600">{programmesApi.loadError}</p>
          <Button variant="outline" onclick={() => programmesApi.load('ALL')}>Try again</Button>
        </div>
      {:else if !rows}
        <div class="flex justify-center py-16"><Spinner /></div>
      {:else if filtered.length === 0}
        <Empty
          title={rows.length === 0 ? 'No programmes yet' : 'No programmes to show'}
          description={rows.length === 0
            ? 'Create a programme, then add its units and criteria or import them from a spreadsheet.'
            : 'No programmes match the current filters.'}
          icon={GraduationCapIcon}
          variant="page"
        >
          {#if rows.length === 0}
            <Button onclick={() => (showCreate = true)}><PlusIcon class="size-4" /> New programme</Button>
          {/if}
        </Empty>
      {:else}
        <div class="overflow-x-auto rounded-md border">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Programme</Table.Head>
                <Table.Head>Reference</Table.Head>
                <Table.Head>Level</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head class="text-right">Units</Table.Head>
                <Table.Head class="text-right">Criteria</Table.Head>
                <Table.Head class="text-right">Learners</Table.Head>
                <Table.Head class="text-right"><span class="sr-only">Actions</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each filtered as p (p.id)}
                <Table.Row>
                  <Table.Cell class="font-medium">
                    <a href="{base}/{p.id}" class="hover:underline">{p.title}</a>
                  </Table.Cell>
                  <Table.Cell>{p.reference ?? '—'}</Table.Cell>
                  <Table.Cell>{p.level ?? '—'}</Table.Cell>
                  <Table.Cell>
                    <Badge variant={p.status === 'ACTIVE' ? 'success' : 'secondary'}>{STATUS_LABELS[p.status]}</Badge>
                  </Table.Cell>
                  <Table.Cell class="text-right tabular-nums">{p.unitCount}</Table.Cell>
                  <Table.Cell class="text-right tabular-nums">{p.criterionCount}</Table.Cell>
                  <Table.Cell class="text-right tabular-nums">{p.learnerCount}</Table.Cell>
                  <Table.Cell class="text-right">
                    <div class="flex justify-end gap-2">
                      <Button size="sm" variant="outline" href="{base}/{p.id}">Open</Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busyId === p.id}
                        onclick={() => toggleArchive(p)}
                        aria-label="{p.status === 'ACTIVE' ? 'Archive' : 'Restore'} {p.title}"
                      >
                        {#if p.status === 'ACTIVE'}
                          <ArchiveIcon class="size-4" /> Archive
                        {:else}
                          <ArchiveRestoreIcon class="size-4" /> Restore
                        {/if}
                      </Button>
                    </div>
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

<NewProgrammeDialog bind:open={showCreate} />
