<script lang="ts">
  import { onMount } from 'svelte';
  import * as Select from '@cio/ui/base/select';
  import * as Table from '@cio/ui/base/table';
  import { Empty } from '@cio/ui/custom/empty';
  import { APPR_EVIDENCE_STATUSES, APPR_EVIDENCE_STATUS_LABELS } from '@cio/utils/constants/apprenticeship';
  import { evidenceApi } from '../../api/evidence.svelte';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import EvidenceStatusChip from '../shared/evidence-status-chip.svelte';
  import { fmtDate, fmtMinutes } from '../shared/format';

  // Evidence tab: every piece for this learner with status / type filters; a row opens the evidence sheet. The list
  // itself lives in the portfolio store so it stays in step with the counts above.

  interface Props {
    store: PortfolioStore;
  }
  let { store }: Props = $props();

  let status = $state('all');
  let type = $state('all');

  onMount(() => {
    evidenceApi.loadTypes();
  });

  const rows = $derived(
    store.evidence.filter((e) => (status === 'all' || e.status === status) && (type === 'all' || e.typeKey === type))
  );
  const typeOptions = $derived(
    [...new Map(store.evidence.map((e) => [e.typeKey, e.typeLabel ?? e.typeKey])).entries()].map(([key, label]) => ({
      key,
      label
    }))
  );
</script>

<div class="space-y-3">
  <div class="flex flex-wrap items-end gap-3">
    <div class="flex flex-col gap-1">
      <span class="text-muted-foreground text-xs" id="ev-f-status">Status</span>
      <Select.Root type="single" bind:value={status}>
        <Select.Trigger class="min-w-[140px]" aria-labelledby="ev-f-status">
          {status === 'all'
            ? 'All statuses'
            : APPR_EVIDENCE_STATUS_LABELS[status as keyof typeof APPR_EVIDENCE_STATUS_LABELS]}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="all">All statuses</Select.Item>
          {#each APPR_EVIDENCE_STATUSES as s (s)}
            <Select.Item value={s}>{APPR_EVIDENCE_STATUS_LABELS[s]}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
    <div class="flex flex-col gap-1">
      <span class="text-muted-foreground text-xs" id="ev-f-type">Type</span>
      <Select.Root type="single" bind:value={type}>
        <Select.Trigger class="min-w-[180px]" aria-labelledby="ev-f-type">
          {type === 'all' ? 'All types' : (typeOptions.find((t) => t.key === type)?.label ?? type)}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="all">All types</Select.Item>
          {#each typeOptions as t (t.key)}
            <Select.Item value={t.key}>{t.label}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
  </div>

  {#if rows.length === 0}
    <Empty
      title="No evidence"
      description={store.evidence.length === 0 ? 'Nothing has been added yet.' : 'No evidence matches these filters.'}
    />
  {:else}
    <div class="overflow-x-auto rounded-lg border">
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Title</Table.Head>
            <Table.Head>Type</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head class="text-right">Criteria</Table.Head>
            <Table.Head class="text-right">Files</Table.Head>
            <Table.Head>OTJ time</Table.Head>
            <Table.Head>Created</Table.Head>
            <Table.Head>By</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each rows as e (e.id)}
            <Table.Row class="cursor-pointer" onclick={() => store.openEvidence(e.id)}>
              <Table.Cell class="max-w-64 truncate font-medium">
                <button
                  type="button"
                  class="text-left hover:underline"
                  onclick={(ev) => {
                    ev.stopPropagation();
                    store.openEvidence(e.id);
                  }}
                >
                  {e.title}
                </button>
              </Table.Cell>
              <Table.Cell>{e.typeLabel ?? e.typeKey}</Table.Cell>
              <Table.Cell><EvidenceStatusChip status={e.status} /></Table.Cell>
              <Table.Cell class="text-right">{e.criteriaCount}</Table.Cell>
              <Table.Cell class="text-right">{e.fileCount}</Table.Cell>
              <Table.Cell>{e.includeOtj ? fmtMinutes(e.minutes) : '—'}</Table.Cell>
              <Table.Cell class="whitespace-nowrap">{fmtDate(e.createdAt)}</Table.Cell>
              <Table.Cell>{e.createdByName ?? '—'}</Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  {/if}
</div>
