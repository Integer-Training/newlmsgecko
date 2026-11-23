<script lang="ts">
  import * as Table from '@cio/ui/base/table';
  import * as Select from '@cio/ui/base/select';
  import * as DropdownMenu from '@cio/ui/base/dropdown-menu';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Empty } from '@cio/ui/custom/empty';
  import { fmtHoursMinutes } from '@cio/utils/functions/apprenticeship-progress';
  import { isOrgAdmin, isOrgTeamMember } from '$lib/utils/store/org';
  import { snackbar } from '$features/ui/snackbar/store';
  import { otjApi, type OtjRow } from '../../api/otj.svelte';
  import { fmtDate, OTJ_STATUS_CLASS, OTJ_STATUS_LABEL } from '../shared/format';

  // The off-the-job log table: logs and OTJ-carrying evidence merged. Search + status filter + client paging.
  // Actions depend on role and status; the API enforces the same rules and answers 403 / 409 when they differ.

  const PAGE_SIZE = 25;

  interface Props {
    rows: OtjRow[];
    pendingMinutes: number;
    onAdd: () => void;
    /** Withdrawn (closed) apprenticeship: hide Add log and row edit actions. */
    readOnly?: boolean;
    onEdit: (row: OtjRow) => void;
    onReview: (row: OtjRow, decision: 'VALIDATE' | 'REJECT') => void;
    onViewEvidence: (id: string) => void;
    onChanged: () => void;
  }
  let {
    rows,
    programmeByEnrolment = {},
    pendingMinutes,
    onAdd,
    onEdit,
    onReview,
    onViewEvidence,
    onChanged,
    readOnly = false
  }: Props = $props();

  const isStaff = $derived($isOrgTeamMember === true);
  const isAdmin = $derived($isOrgAdmin === true);

  let status = $state('');
  let search = $state('');
  let page = $state(1);
  let busy = $state<string | null>(null);
  let expanded = $state<string | null>(null);

  const filtered = $derived(
    rows.filter(
      (r) =>
        (!status || r.status === status) &&
        (!search.trim() || r.title.toLowerCase().includes(search.trim().toLowerCase()))
    )
  );
  const totalPages = $derived(Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
  const shown = $derived(filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE));
  const waiting = $derived(rows.filter((r) => r.kind === 'LOG' && r.status === 'SUBMITTED').length);

  $effect(() => {
    status;
    search;
    page = 1;
  });
  $effect(() => {
    if (page > totalPages) page = totalPages;
  });

  const statusLabel = $derived(status ? (OTJ_STATUS_LABEL[status] ?? status) : 'All statuses');

  // Role rules (mirrored from the API): staff edit / delete anything not validated; a learner edits their own while
  // SUBMITTED or REJECTED and deletes while SUBMITTED. Reopening a validated log is admin only.
  const canEdit = (r: OtjRow) => r.kind === 'LOG' && r.status !== 'VALIDATED';
  const canDelete = (r: OtjRow) => r.kind === 'LOG' && (isStaff ? r.status !== 'VALIDATED' : r.status === 'SUBMITTED');
  const canDecide = (r: OtjRow) => r.kind === 'LOG' && isStaff && r.status === 'SUBMITTED';
  const canReopen = (r: OtjRow) => r.kind === 'LOG' && isAdmin && r.status === 'VALIDATED';

  async function remove(r: OtjRow) {
    if (!confirm(`Delete "${r.title}"?`)) return;
    busy = r.id;
    const res = await otjApi.remove(r.id);
    busy = null;
    if (!res.ok) {
      snackbar.error(res.error);
      return;
    }
    snackbar.success('Log deleted');
    onChanged();
  }

  async function reopen(r: OtjRow) {
    busy = r.id;
    const res = await otjApi.review(r.id, { decision: 'REOPEN', expectedStatus: r.status });
    busy = null;
    if (!res.ok) {
      snackbar.error(res.error);
      return;
    }
    snackbar.success('Log reopened');
    onChanged();
  }
</script>

<section class="space-y-3" aria-label="Off-the-job training log">
  <div class="flex flex-wrap items-end justify-between gap-2">
    <h3 class="font-semibold">Off-the-job training log</h3>
    {#if !readOnly}<Button size="sm" onclick={onAdd}>Add log</Button>{/if}
  </div>

  <div class="flex flex-wrap items-end gap-3">
    <div class="min-w-48 flex-1 space-y-1">
      <label for="otj-search" class="text-xs text-(--muted-foreground)">Search</label>
      <Input id="otj-search" placeholder="Search by title" bind:value={search} />
    </div>
    <div class="space-y-1">
      <span class="text-xs text-(--muted-foreground)" id="otj-status-label">Filter by status</span>
      <Select.Root type="single" value={status} onValueChange={(v) => (status = v)}>
        <Select.Trigger class="ui:w-fit min-w-[160px]" aria-labelledby="otj-status-label"
          ><p class="truncate">{statusLabel}</p></Select.Trigger
        >
        <Select.Content>
          <Select.Item value="">All statuses</Select.Item>
          <Select.Item value="SUBMITTED">Submitted</Select.Item>
          <Select.Item value="VALIDATED">Validated</Select.Item>
          <Select.Item value="REJECTED">Rejected</Select.Item>
        </Select.Content>
      </Select.Root>
    </div>
  </div>

  {#if filtered.length === 0}
    <Empty
      title={rows.length === 0 ? 'No off-the-job time logged' : 'Nothing matches'}
      description={rows.length === 0
        ? 'Add a log, or add evidence with "Include in off-the-job hours".'
        : 'Try a different search or status.'}
    />
  {:else}
    <div class="overflow-x-auto rounded-lg border">
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Title</Table.Head>
            <Table.Head>Log time</Table.Head>
            <Table.Head>Off-the-job</Table.Head>
            <Table.Head>Log date</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head>By</Table.Head>
            <Table.Head><span class="sr-only">Actions</span></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each shown as r (r.kind + r.id)}
            <Table.Row>
              <Table.Cell class="max-w-72 font-medium break-words whitespace-normal!">
                {r.title}
                {#if r.kind === 'EVIDENCE'}
                  <span
                    class="ml-1 inline-flex rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800 dark:bg-sky-500/20 dark:text-sky-300"
                    >Evidence</span
                  >
                {/if}
                {#if r.kind === 'EVIDENCE' && r.homeEnrolmentId && programmeByEnrolment[r.homeEnrolmentId]}
                  <span class="ml-1 text-xs font-normal text-(--muted-foreground)"
                    >From {programmeByEnrolment[r.homeEnrolmentId]}</span
                  >
                {/if}
                {#if r.outsideWindow}
                  <span
                    class="ml-1 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
                    title="Dated outside the apprenticeship dates">Outside dates</span
                  >
                {/if}
                {#if expanded === r.id}
                  <div class="mt-1 space-y-1 text-sm font-normal text-(--muted-foreground)">
                    {#if r.details}<p>{r.details}</p>{/if}
                    {#if r.reviewNote}<p>Review note: {r.reviewNote}</p>{/if}
                    {#if !r.details && !r.reviewNote}<p>No further details.</p>{/if}
                  </div>
                {/if}
              </Table.Cell>
              <Table.Cell class="whitespace-nowrap">{fmtHoursMinutes(r.minutes)}</Table.Cell>
              <Table.Cell>{r.isOtj ? 'Yes' : 'No'}</Table.Cell>
              <Table.Cell class="whitespace-nowrap">{fmtDate(r.date)}</Table.Cell>
              <Table.Cell>
                <span
                  class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap {OTJ_STATUS_CLASS[
                    r.status
                  ] ?? ''}">{OTJ_STATUS_LABEL[r.status] ?? r.status}</span
                >
              </Table.Cell>
              <Table.Cell>{r.byName ?? '—'}</Table.Cell>
              <Table.Cell>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger>
                    {#snippet child({ props })}
                      <Button
                        {...props}
                        variant="outline"
                        size="sm"
                        disabled={busy === r.id}
                        aria-label="Actions for {r.title}">Actions</Button
                      >
                    {/snippet}
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content align="end">
                    {#if r.kind === 'EVIDENCE'}
                      <DropdownMenu.Item onclick={() => onViewEvidence(r.id)}>View</DropdownMenu.Item>
                    {:else}
                      <DropdownMenu.Item onclick={() => (expanded = expanded === r.id ? null : r.id)}>
                        {expanded === r.id ? 'Hide' : 'View'}
                      </DropdownMenu.Item>
                      {#if canEdit(r)}<DropdownMenu.Item onclick={() => onEdit(r)}>Edit</DropdownMenu.Item>{/if}
                      {#if canDecide(r)}
                        <DropdownMenu.Item onclick={() => onReview(r, 'VALIDATE')}>Validate</DropdownMenu.Item>
                        <DropdownMenu.Item onclick={() => onReview(r, 'REJECT')}>Reject</DropdownMenu.Item>
                      {/if}
                      {#if canReopen(r)}<DropdownMenu.Item onclick={() => reopen(r)}>Reopen</DropdownMenu.Item>{/if}
                      {#if canDelete(r)}<DropdownMenu.Item onclick={() => remove(r)}>Delete</DropdownMenu.Item>{/if}
                    {/if}
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>

    {#if totalPages > 1}
      <div class="flex items-center justify-end gap-2 text-sm">
        <Button variant="outline" size="sm" disabled={page <= 1} onclick={() => (page -= 1)}>Previous</Button>
        <span aria-live="polite">Page {page} of {totalPages}</span>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onclick={() => (page += 1)}>Next</Button>
      </div>
    {/if}
  {/if}

  <p class="text-xs text-(--muted-foreground)">
    Only validated time counts. {waiting} waiting for validation{pendingMinutes > 0
      ? ` (${fmtHoursMinutes(pendingMinutes)})`
      : ''}.
  </p>
</section>
