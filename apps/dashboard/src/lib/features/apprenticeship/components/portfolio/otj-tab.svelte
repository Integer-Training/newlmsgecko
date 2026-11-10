<script lang="ts">
  import * as Table from '@cio/ui/base/table';
  import { Empty } from '@cio/ui/custom/empty';
  import GlhSection from './glh-section.svelte';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import EvidenceStatusChip from '../shared/evidence-status-chip.svelte';
  import StatusChip from '../shared/status-chip.svelte';
  import { fmtDate, fmtMinutes } from '../shared/format';

  // Off-the-job tab: the target (calculated or overridden, with its source), hours done, hours expected to date and
  // the status, then the evidence that carries OTJ time. Only ACCEPTED time counts; pending is shown separately.

  interface Props {
    store: PortfolioStore;
  }
  let { store }: Props = $props();

  const d = $derived(store.data);
  const otj = $derived(d?.summary.otj);
  const source = $derived(
    d?.enrolment.otjTargetMinutesOverride !== null && d?.enrolment.otjTargetMinutesOverride !== undefined
      ? 'Manual override'
      : d?.enrolment.contractedHoursWeek
        ? `Calculated from ${d.enrolment.contractedHoursWeek} contracted hours a week`
        : 'Not set — add contracted hours or an override'
  );
  const rows = $derived(store.evidence.filter((e) => e.includeOtj && e.minutes > 0));
</script>

{#if d && otj}
  <div class="space-y-4">
    <dl class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <div class="rounded-lg border p-3">
        <dt class="text-xs text-(--muted-foreground)">Target</dt>
        <dd class="text-lg font-semibold">{fmtMinutes(otj.targetMinutes)}</dd>
        <p class="text-xs text-(--muted-foreground)">{source}</p>
      </div>
      <div class="rounded-lg border p-3">
        <dt class="text-xs text-(--muted-foreground)">Done (accepted)</dt>
        <dd class="text-lg font-semibold">{fmtMinutes(otj.minutes)}</dd>
      </div>
      <div class="rounded-lg border p-3">
        <dt class="text-xs text-(--muted-foreground)">Expected to date</dt>
        <dd class="text-lg font-semibold">{fmtMinutes(otj.expectedMinutes)}</dd>
      </div>
      <div class="rounded-lg border p-3">
        <dt class="text-xs text-(--muted-foreground)">Status</dt>
        <dd class="mt-1"><StatusChip status={otj.status} /></dd>
      </div>
    </dl>

    <h3 class="font-semibold">Evidence with off-the-job time</h3>
    {#if rows.length === 0}
      <Empty
        title="No off-the-job evidence"
        description="Evidence added with “Include in off-the-job hours” appears here."
      />
    {:else}
      <div class="overflow-x-auto rounded-lg border">
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Title</Table.Head>
              <Table.Head>Status</Table.Head>
              <Table.Head class="text-right">Time</Table.Head>
              <Table.Head>Created</Table.Head>
              <Table.Head>By</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each rows as e (e.id)}
              <Table.Row class="cursor-pointer" onclick={() => store.openEvidence(e.id)}>
                <Table.Cell class="font-medium">
                  <button
                    type="button"
                    class="text-left hover:underline"
                    onclick={(ev) => {
                      ev.stopPropagation();
                      store.openEvidence(e.id);
                    }}>{e.title}</button
                  >
                </Table.Cell>
                <Table.Cell>
                  <EvidenceStatusChip status={e.status} />
                  {#if e.status !== 'ACCEPTED'}<span class="ml-1 text-xs text-(--muted-foreground)"
                      >not counted yet</span
                    >{/if}
                </Table.Cell>
                <Table.Cell class="text-right">{fmtMinutes(e.minutes)}</Table.Cell>
                <Table.Cell>{fmtDate(e.createdAt)}</Table.Cell>
                <Table.Cell>{e.createdByName ?? '—'}</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </div>
    {/if}
    <GlhSection {store} />
  </div>
{/if}
