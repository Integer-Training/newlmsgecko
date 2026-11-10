<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import * as Page from '@cio/ui/base/page';
  import * as Select from '@cio/ui/base/select';
  import * as Table from '@cio/ui/base/table';
  import { Button } from '@cio/ui/base/button';
  import { Skeleton } from '@cio/ui/base/skeleton';
  import { Empty } from '@cio/ui/custom/empty';
  import { BackButton } from '@cio/ui/custom/back-button';
  import { page as appPage } from '$app/state';
  import { currentOrg, isOrgAdmin } from '$lib/utils/store/org';
  import { apprenticeshipsBase } from '../utils/paths';
  import { enrolmentsApi } from '../api/enrolments.svelte';
  import { evidenceApi, type ToMarkPage } from '../api/evidence.svelte';
  import EvidenceSheet from '../components/evidence/evidence-sheet.svelte';
  import TutorCell from '../components/shared/tutor-cell.svelte';
  import { fmtDate } from '../components/shared/format';

  // Gecko Apprenticeships — the marking queue: evidence waiting for a decision, oldest first. A row opens the
  // evidence sheet in review mode; after Accept / Refer the row leaves the queue and the count updates.

  const PAGE_SIZE = 25;

  let programmeId = $state('');
  let page = $state(1);
  let data = $state<ToMarkPage | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let reload = $state(0);
  let sheetOpen = $state(false);
  let selected = $state<{ id: string; learnerName: string | null } | null>(null);
  let reqId = 0;

  const base = $derived(apprenticeshipsBase(appPage.url.pathname, $currentOrg.siteName));
  const totalPages = $derived(data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1);

  onMount(() => {
    enrolmentsApi.loadOptions($isOrgAdmin === true);
  });

  $effect(() => {
    const pid = programmeId;
    const p = page;
    reload;
    const id = ++reqId;
    untrack(() => (loading = data === null));
    evidenceApi.toMark(p, PAGE_SIZE, pid || undefined).then((res) => {
      if (id !== reqId) return;
      loading = false;
      if (res.ok) {
        // A decision may have emptied the last page: step back instead of showing nothing.
        if (res.data.items.length === 0 && p > 1) {
          page = p - 1;
          return;
        }
        data = res.data;
        error = null;
      } else {
        error = res.error;
      }
    });
  });

  function setProgramme(v: string) {
    programmeId = v;
    page = 1;
  }

  function openRow(row: { id: string; learnerName: string | null }) {
    selected = { id: row.id, learnerName: row.learnerName };
    sheetOpen = true;
  }

  // Whole days since the evidence was submitted; amber once it has waited more than a week.
  function waitingDays(row: { submittedAt?: string; createdAt: string }) {
    const t = new Date(row.submittedAt ?? row.createdAt).getTime();
    return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
  }

  const programmeLabel = $derived(
    programmeId ? (enrolmentsApi.programmes.find((p) => p.id === programmeId)?.title ?? 'Programme') : 'All programmes'
  );
</script>

<svelte:head>
  <title>To mark — Apprenticeships</title>
</svelte:head>

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      <BackButton href={base} label="All learners" />
      <Page.Title>To mark</Page.Title>
      <Page.Subtitle>
        {data
          ? `${data.total} piece${data.total === 1 ? '' : 's'} of evidence waiting`
          : 'Evidence waiting for a decision'}
      </Page.Subtitle>
    </Page.HeaderContent>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      <div class="mb-4 flex flex-col gap-1">
        <span class="text-xs text-(--muted-foreground)" id="tm-prog">Programme</span>
        <Select.Root type="single" value={programmeId} onValueChange={setProgramme}>
          <Select.Trigger class="ui:w-fit min-w-[220px]" aria-labelledby="tm-prog"
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

      {#if loading}
        <div class="space-y-2" role="status" aria-label="Loading the marking queue">
          {#each Array(6) as _, i (i)}<Skeleton class="h-12 w-full" />{/each}
        </div>
      {:else if error && !data}
        <div class="rounded-lg border border-rose-200 p-6 text-center">
          <p role="alert" class="text-sm text-rose-600">{error}</p>
          <Button variant="outline" size="sm" class="mt-3" onclick={() => (reload += 1)}>Try again</Button>
        </div>
      {:else if !data || data.items.length === 0}
        <Empty title="All caught up" description="There is no evidence waiting to be marked." />
      {:else}
        <div class="overflow-x-auto rounded-lg border">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Learner</Table.Head>
                <Table.Head>Tutor</Table.Head>
                <Table.Head>Programme</Table.Head>
                <Table.Head>Evidence</Table.Head>
                <Table.Head>Task</Table.Head>
                <Table.Head>Type</Table.Head>
                <Table.Head class="text-right">Criteria</Table.Head>
                <Table.Head>Submitted</Table.Head>
                <Table.Head>Waiting</Table.Head>
                <Table.Head><span class="sr-only">Actions</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each data.items as row (row.id)}
                <Table.Row class="cursor-pointer" onclick={() => openRow(row)}>
                  <Table.Cell class="font-medium">{row.learnerName ?? '—'}</Table.Cell>
                  <Table.Cell><TutorCell tutors={row.tutors} /></Table.Cell>
                  <Table.Cell>{row.programmeTitle}</Table.Cell>
                  <Table.Cell class="max-w-72 break-words whitespace-normal!">{row.title}</Table.Cell>
                  <Table.Cell class="max-w-56 text-sm break-words whitespace-normal!">
                    {#if row.taskTitle}
                      <p>{row.taskTitle}</p>
                      {#if row.taskDueDate}
                        <p class="text-xs text-(--muted-foreground)">Due {fmtDate(row.taskDueDate)}</p>
                      {/if}
                    {:else}
                      <span class="text-(--muted-foreground)">—</span>
                    {/if}
                  </Table.Cell>
                  <Table.Cell class="text-sm text-(--muted-foreground)">{row.typeLabel ?? '—'}</Table.Cell>
                  <Table.Cell class="text-right">{row.criteriaCount}</Table.Cell>
                  <Table.Cell class="whitespace-nowrap">{fmtDate(row.submittedAt ?? row.createdAt)}</Table.Cell>
                  <Table.Cell class="whitespace-nowrap">
                    {@const days = waitingDays(row)}
                    <span class={days > 7 ? 'font-medium text-amber-700 dark:text-amber-300' : ''}
                      >{days} day{days === 1 ? '' : 's'}</span
                    >
                  </Table.Cell>
                  <Table.Cell>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label="Review {row.title}"
                      onclick={(e: MouseEvent) => {
                        e.stopPropagation();
                        openRow(row);
                      }}
                    >
                      Review
                    </Button>
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </div>

        {#if totalPages > 1}
          <div class="mt-3 flex items-center justify-end gap-2 text-sm">
            <Button variant="outline" size="sm" disabled={page <= 1} onclick={() => (page -= 1)}>Previous</Button>
            <span aria-live="polite">Page {page} of {totalPages}</span>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onclick={() => (page += 1)}>Next</Button>
          </div>
        {/if}
      {/if}
    {/snippet}
  </Page.Body>
</Page.Root>

<EvidenceSheet
  bind:open={sheetOpen}
  mode="view"
  evidenceId={selected?.id ?? null}
  enrolmentId={null}
  learnerName={selected?.learnerName ?? null}
  closeOnReview
  onChanged={() => (reload += 1)}
/>
