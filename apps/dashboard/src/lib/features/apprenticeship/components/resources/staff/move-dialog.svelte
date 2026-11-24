<script lang="ts">
  import { untrack } from 'svelte';
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { snackbar } from '$features/ui/snackbar/store';
  import { programmesApi } from '../../../api/programmes.svelte';
  import { resourcesAdminApi, type ResourceItem } from '../../../api/resources-admin.svelte';
  import { unitOptions } from './unit-options';

  // Move a resource to another unit, or to General (the whole programme).
  interface Props {
    open: boolean;
    programmeId: string;
    resource: ResourceItem;
  }
  let { open = $bindable(), programmeId, resource }: Props = $props();

  let unit = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);

  const tree = $derived(programmesApi.tree?.id === programmeId ? programmesApi.tree : null);
  const units = $derived(unitOptions(tree));
  const changed = $derived((unit || null) !== resource.unitId);

  $effect(() => {
    if (!open) return;
    void resource.id;
    untrack(() => {
      unit = resource.unitId ?? '';
      saving = false;
      error = null;
    });
  });

  async function save(e: Event) {
    e.preventDefault();
    if (!changed || saving) return;
    saving = true;
    const res = await resourcesAdminApi.update(resource.id, { unitId: unit || null });
    saving = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    snackbar.success('Resource moved');
    open = false;
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Move resource</Dialog.Title>
      <Dialog.Description>{resource.title}</Dialog.Description>
    </Dialog.Header>
    <form onsubmit={save} class="space-y-4">
      <div class="space-y-1">
        <label for="mv-unit" class="text-sm font-medium">Move to</label>
        <select
          id="mv-unit"
          bind:value={unit}
          disabled={saving}
          class="border-input bg-background w-full rounded-md border px-2 py-2 text-sm"
        >
          <option value="">General (whole programme)</option>
          {#each units as u (u.id)}<option value={u.id}>{u.label}</option>{/each}
        </select>
      </div>
      {#if error}
        <p
          role="alert"
          class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
        >
          {error}
        </p>
      {/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (open = false)} disabled={saving}>Cancel</Button>
        <Button type="submit" disabled={!changed || saving} loading={saving}>Move</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
