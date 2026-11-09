<script lang="ts">
  import type { Snippet } from 'svelte';
  import * as Popover from '@cio/ui/base/popover';
  import { Spinner } from '@cio/ui/base/spinner';
  import { evidenceApi, type CriterionEvidenceItem } from '../../api/evidence.svelte';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import EvidenceStatusChip from '../shared/evidence-status-chip.svelte';
  import { fmtDate } from '../shared/format';

  // "List evidence" popover for one criterion: every piece mapped to it, each opening the evidence sheet. Used by the
  // criteria rows (evidence-count chip) and by the criteria-map cells. Re-fetches when it opens and after any change.

  interface Props {
    store: PortfolioStore;
    criterionId: string;
    label: string;
    triggerClass?: string;
    children: Snippet;
  }
  let { store, criterionId, label, triggerClass = '', children }: Props = $props();

  let open = $state(false);
  let items = $state<CriterionEvidenceItem[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    // Track open + the store version so the list stays in sync with the rest of the page.
    store.version;
    if (!open) return;
    let cancelled = false;
    loading = items.length === 0;
    evidenceApi.forCriterion(criterionId, store.enrolmentId).then((res) => {
      if (cancelled) return;
      loading = false;
      if (res.ok) {
        items = res.data;
        error = null;
      } else {
        error = res.error;
      }
    });
    return () => {
      cancelled = true;
    };
  });

  function pick(id: string) {
    open = false;
    store.openEvidence(id);
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger class={triggerClass} aria-label={label}>
    {@render children()}
  </Popover.Trigger>
  <Popover.Content class="ui:p-2 w-80!" align="start">
    <p class="px-2 pb-1 text-xs font-medium text-(--muted-foreground)">{label}</p>
    {#if loading}
      <div class="flex justify-center py-4" role="status" aria-label="Loading evidence"><Spinner /></div>
    {:else if error}
      <p role="alert" class="px-2 py-2 text-sm text-rose-600">{error}</p>
    {:else if items.length === 0}
      <p class="px-2 py-2 text-sm text-(--muted-foreground)">No evidence mapped to this criterion yet.</p>
    {:else}
      <ul class="max-h-64 overflow-y-auto">
        {#each items as item (item.id)}
          <li>
            <button
              type="button"
              class="w-full rounded-md px-2 py-1.5 text-left hover:bg-(--muted)"
              onclick={() => pick(item.id)}
            >
              <span class="flex items-center justify-between gap-2">
                <span class="truncate text-sm font-medium">{item.title}</span>
                <EvidenceStatusChip status={item.status} />
              </span>
              <span class="line-clamp-2 text-xs text-(--muted-foreground)">{item.snippet || 'No details'}</span>
              <span class="text-xs text-(--muted-foreground)">
                {fmtDate(item.createdAt)} · {item.fileCount} file{item.fileCount === 1 ? '' : 's'}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </Popover.Content>
</Popover.Root>
