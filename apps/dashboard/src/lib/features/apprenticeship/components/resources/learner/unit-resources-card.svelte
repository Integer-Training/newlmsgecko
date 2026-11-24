<script lang="ts">
  import { untrack } from 'svelte';
  import { resourcesLearnerApi, type LearnerResourceItem } from '../../../api/resources-learner.svelte';
  import type { PortfolioStore } from '../../../stores/portfolio.svelte';
  import ResourceRow from './resource-row.svelte';
  import ResourceViewer from './resource-viewer.svelte';
  import { ResourceActions } from './resource-actions.svelte';

  // "Resources" card on the unit page: this unit's resources (same row as the Resources page). Hidden while loading,
  // on any error and when the unit has none, so it never gets in the way of the criteria below it. One request on mount.

  interface Props {
    mode: 'staff' | 'learner';
    /** The enrolment (qualification) this unit belongs to. */
    enrolmentId: string;
    unitId: string;
    store: PortfolioStore;
  }
  let { mode, enrolmentId, unitId, store }: Props = $props();

  let items = $state<LearnerResourceItem[]>([]);

  function patch(id: string, p: Partial<LearnerResourceItem>) {
    items = items.map((r) => (r.id === id ? { ...r, ...p } : r));
  }
  // svelte-ignore state_referenced_locally
  const actions = new ResourceActions(mode === 'learner' ? store : null, patch);

  // Reload when the unit or enrolment changes (the page component can be reused across units); a newer request wins.
  let requestSeq = 0;
  $effect(() => {
    const enr = enrolmentId;
    const unit = unitId;
    untrack(() => void load(enr, unit));
  });

  async function load(enr: string, unit: string) {
    const seq = ++requestSeq;
    items = [];
    const res = await resourcesLearnerApi.forEnrolment(enr);
    if (seq !== requestSeq) return;
    if (res.ok) {
      items = res.data.resources
        .filter((r) => r.unitId === unit)
        .sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title));
    }
  }
</script>

{#if items.length > 0}
  <section class="rounded-lg border bg-(--card)" aria-label="Resources">
    <div class="flex items-center justify-between gap-2 border-b px-4 py-3">
      <h2 class="text-base font-semibold">Resources</h2>
      <span class="text-xs text-(--muted-foreground)">{items.length} for this unit</span>
    </div>
    <ul class="divide-y">
      {#each items as r (r.id)}
        <ResourceRow
          resource={r}
          {actions}
          {mode}
          uploadBlocked={store.evidenceBlocked}
          uploadBlockedReason={store.blockedMessage}
        />
      {/each}
    </ul>
  </section>

  <ResourceViewer
    bind:open={actions.viewerOpen}
    resource={actions.viewing}
    downloading={!!actions.downloadingId}
    canUpload={mode === 'learner' && !store.evidenceBlocked}
    onDownload={(r) => actions.download(r)}
    onUpload={(r) => actions.upload(r)}
  />
{/if}
