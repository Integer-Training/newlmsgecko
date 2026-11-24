<script lang="ts">
  import { Button } from '@cio/ui/base/button';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import { Skeleton } from '@cio/ui/base/skeleton';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import FilesIcon from '@lucide/svelte/icons/files';
  import { resourcesAdminApi } from '../../../api/resources-admin.svelte';
  import ResourceRow from './resource-row.svelte';

  // The resources of one scope: a unit (unitId = its id, collapsible "Resources (n)" block inside the unit card) or
  // the whole programme (unitId = null, shown as the General card). Reorder with the arrows or by dragging a row.
  interface Props {
    unitId: string | null;
    variant: 'unit' | 'general';
  }
  let { unitId, variant }: Props = $props();

  const api = resourcesAdminApi;
  const isGeneral = $derived(variant === 'general');
  let expanded = $state(false);
  let dragId = $state<string | null>(null);

  const visible = $derived(api.scope(unitId));
  const activeCount = $derived(api.activeCount(unitId));
  const archivedHere = $derived(api.archivedCount(unitId));
  const show = $derived(isGeneral || expanded);

  function ids(list: { id: string }[]) {
    return list.map((r) => r.id);
  }

  // Full order of the scope for the API: active first (as shown), then archived.
  function fullOrder(shownActive: string[]) {
    const archived = api.scope(unitId, true).filter((r) => r.status === 'ARCHIVED');
    return [...shownActive, ...ids(archived)];
  }

  function move(i: number, dir: -1 | 1) {
    const active = ids(api.scope(unitId, false));
    const j = i + dir;
    if (j < 0 || j >= active.length) return;
    [active[i], active[j]] = [active[j], active[i]];
    api.reorder(unitId, fullOrder(active));
  }

  function dropOn(targetId: string) {
    const from = dragId;
    dragId = null;
    if (!from || from === targetId) return;
    const active = ids(api.scope(unitId, false));
    const a = active.indexOf(from);
    const b = active.indexOf(targetId);
    if (a < 0 || b < 0) return;
    active.splice(b, 0, active.splice(a, 1)[0]);
    api.reorder(unitId, fullOrder(active));
  }
</script>

<section
  aria-label={isGeneral ? 'General resources' : 'Unit resources'}
  class={isGeneral ? 'rounded-md border bg-(--background)' : 'border-t'}
>
  <div class="flex flex-wrap items-center gap-2 p-2">
    {#if isGeneral}
      <FilesIcon class="ml-1 size-4 text-(--muted-foreground)" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <h2 class="text-sm font-semibold">Resources — General ({activeCount})</h2>
        <p class="text-xs text-(--muted-foreground)">
          Learning resources and workbooks for the whole programme, not tied to a unit.
        </p>
      </div>
    {:else}
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left text-sm font-medium hover:bg-(--muted)/50"
        aria-expanded={expanded}
        onclick={() => (expanded = !expanded)}
      >
        {#if expanded}<ChevronDownIcon size={16} />{:else}<ChevronRightIcon size={16} />{/if}
        Resources ({activeCount})
      </button>
    {/if}
    {#if show}
      <Button size="sm" variant="outline" onclick={() => (api.dialog = { mode: 'bulk', unitId })}>Add several</Button>
      <Button size="sm" onclick={() => (api.dialog = { mode: 'add', unitId })}>
        <PlusIcon class="size-4" /> Add resource
      </Button>
    {/if}
  </div>

  {#if show}
    <div class="space-y-2 px-2 pb-2">
      {#if api.loading && api.items.length === 0}
        <div role="status" aria-label="Loading resources" class="space-y-2">
          <Skeleton class="h-14 w-full" />
          <Skeleton class="h-14 w-full" />
        </div>
      {:else if api.error && api.items.length === 0}
        <div class="flex flex-wrap items-center gap-2 text-sm text-rose-600" role="alert">
          {api.error}
          <Button size="sm" variant="outline" onclick={() => api.programmeId && api.load(api.programmeId)}
            >Try again</Button
          >
        </div>
      {:else}
        {#if archivedHere > 0}
          <label class="flex w-fit items-center gap-2 text-xs text-(--muted-foreground)">
            <Checkbox checked={api.showArchived} onCheckedChange={(v) => (api.showArchived = v === true)} />
            Show archived ({archivedHere})
          </label>
        {/if}
        {#if visible.length === 0}
          <p class="rounded-md border border-dashed px-3 py-5 text-center text-sm text-(--muted-foreground)">
            {isGeneral
              ? 'No general resources yet. Add a PDF or Word file for learners to read, or a workbook to complete.'
              : 'No resources for this unit yet.'}
          </p>
        {:else}
          <ul class="space-y-2">
            {#each visible as r, i (r.id)}
              <ResourceRow
                resource={r}
                index={i}
                total={visible.filter((v) => v.status === 'ACTIVE').length}
                dragging={dragId === r.id}
                onmove={(dir) => move(i, dir)}
                ondragstart={() => (dragId = r.id)}
                ondragend={() => (dragId = null)}
                ondropped={() => dropOn(r.id)}
              />
            {/each}
          </ul>
        {/if}
      {/if}
    </div>
  {/if}
</section>
