<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Spinner } from '@cio/ui/base/spinner';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
  import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import { APPR_GATEWAY_ITEMS_MAX } from '@cio/utils/constants/apprenticeship';
  import { snackbar } from '$features/ui/snackbar/store';
  import {
    programmesApi,
    type GatewayChecklist,
    type GatewayChecklistItem,
    type GatewayItemKind
  } from '$features/apprenticeship/api/programmes.svelte';

  // Gateway checklist editor (collapsible). Edits a local draft; Save replaces the programme's checklist, "Reset to
  // default" sends null. Automatic items can be relabelled or removed (at most one of each kind); manual items get a
  // key made from their label.
  interface Props {
    programmeId: string;
  }

  let { programmeId }: Props = $props();

  const KIND_TEXT: Record<GatewayItemKind, string> = {
    AUTO_UNITS: 'Automatic: all units complete',
    AUTO_OTJ: 'Automatic: OTJ target met',
    MANUAL: 'Manual tick'
  };

  let expanded = $state(false);
  let loaded = $state<GatewayChecklist | null>(null);
  let items = $state<GatewayChecklistItem[]>([]);
  let newLabel = $state('');
  let loadError = $state<string | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let saving = $state(false);
  let resetting = $state(false);

  function adopt(data: GatewayChecklist) {
    loaded = data;
    items = data.checklist.map((i) => ({ ...i }));
  }

  async function load() {
    loading = true;
    loadError = null;
    const res = await programmesApi.loadGatewayChecklist(programmeId);
    loading = false;
    if (res.ok) adopt(res.data);
    else loadError = res.error;
  }

  onMount(load);

  function toggle() {
    expanded = !expanded;
  }

  const dirty = $derived(!!loaded && JSON.stringify(items) !== JSON.stringify(loaded.checklist.map((i) => ({ ...i }))));
  const labelsValid = $derived(items.every((i) => i.label.trim().length > 0));
  const canSave = $derived(dirty && labelsValid && items.length >= 1 && !saving && !resetting);
  const atMax = $derived(items.length >= APPR_GATEWAY_ITEMS_MAX);

  function slug(label: string): string {
    const base =
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 36) || 'item';
    return /^[a-z0-9]/.test(base) ? base : `i-${base}`;
  }

  function uniqueKey(label: string): string {
    const taken = new Set(items.map((i) => i.key));
    const base = slug(label);
    if (!taken.has(base)) return base;
    for (let n = 2; n < 100; n++) {
      const key = `${base.slice(0, 36)}-${n}`;
      if (!taken.has(key)) return key;
    }
    return `${base.slice(0, 30)}-${Date.now() % 100000}`;
  }

  function addManual(e: Event) {
    e.preventDefault();
    const label = newLabel.trim();
    if (!label || atMax) return;
    items = [...items, { key: uniqueKey(label), label, kind: 'MANUAL' }];
    newLabel = '';
  }

  function remove(i: number) {
    items = items.filter((_, idx) => idx !== i);
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    items = next;
  }

  async function save() {
    if (!canSave) return;
    saving = true;
    error = null;
    const res = await programmesApi.saveGatewayChecklist(
      programmeId,
      items.map((i) => ({ ...i, label: i.label.trim() }))
    );
    saving = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    adopt(res.data);
    snackbar.success('Gateway checklist saved');
  }

  async function reset() {
    resetting = true;
    error = null;
    const res = await programmesApi.saveGatewayChecklist(programmeId, null);
    resetting = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    adopt(res.data);
    snackbar.success('Gateway checklist reset to the default');
  }
</script>

<section class="rounded-xl border bg-(--card)" aria-labelledby="gw-h">
  <h2 id="gw-h" class="text-lg font-semibold tracking-tight">
    <button
      type="button"
      class="flex w-full items-center gap-2 p-4 text-left"
      aria-expanded={expanded}
      aria-controls="gw-body"
      onclick={toggle}
    >
      {#if expanded}<ChevronDownIcon size={18} />{:else}<ChevronRightIcon size={18} />{/if}
      Gateway checklist
      {#if loaded}
        <span class="text-sm font-normal text-(--muted-foreground)">
          ({items.length} item{items.length === 1 ? '' : 's'}{loaded.isDefault ? ', default' : ''})
        </span>
      {/if}
    </button>
  </h2>

  {#if expanded}
    <div id="gw-body" class="flex flex-col gap-3 border-t p-4">
      <p class="text-sm text-(--muted-foreground)">
        What a learner must have before they can be confirmed for gateway. Automatic items tick themselves; manual items
        are ticked by staff.
      </p>

      {#if loading && !loaded}
        <div class="flex justify-center py-6"><Spinner /></div>
      {:else if loadError && !loaded}
        <div class="flex flex-col items-center gap-3 py-6" role="alert">
          <p class="text-sm text-red-600">{loadError}</p>
          <Button variant="outline" onclick={load}>Try again</Button>
        </div>
      {:else}
        <ul class="space-y-2">
          {#each items as item, i (item.key)}
            <li class="flex flex-wrap items-center gap-2 rounded-md border p-2">
              <div class="min-w-48 flex-1 space-y-0.5">
                <Input
                  aria-label="Label for item {i + 1}"
                  bind:value={item.label}
                  maxlength={120}
                  class="h-8"
                  aria-invalid={!item.label.trim()}
                />
                <p class="px-1 text-xs text-(--muted-foreground)">{KIND_TEXT[item.kind]}</p>
              </div>
              <div class="flex items-center gap-1">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Move {item.label || 'item'} up"
                  disabled={i === 0}
                  onclick={() => move(i, -1)}
                >
                  <ArrowUpIcon class="size-4" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Move {item.label || 'item'} down"
                  disabled={i === items.length - 1}
                  onclick={() => move(i, 1)}
                >
                  <ArrowDownIcon class="size-4" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Remove {item.label || 'item'}"
                  disabled={items.length <= 1}
                  onclick={() => remove(i)}
                >
                  <Trash2Icon class="size-4" />
                </Button>
              </div>
            </li>
          {/each}
        </ul>

        <form onsubmit={addManual} class="flex flex-wrap items-end gap-2">
          <div class="min-w-48 flex-1 space-y-1">
            <label for="gw-new" class="text-xs font-medium">Add a manual item</label>
            <Input
              id="gw-new"
              bind:value={newLabel}
              maxlength={120}
              placeholder="e.g. Employer reference received"
              class="h-8"
              disabled={atMax}
            />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={!newLabel.trim() || atMax}>
            <PlusIcon class="size-4" /> Add item
          </Button>
        </form>
        {#if atMax}
          <p class="text-xs text-(--muted-foreground)">A checklist can have up to {APPR_GATEWAY_ITEMS_MAX} items.</p>
        {/if}

        {#if error}
          <p
            role="alert"
            class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
          >
            {error}
          </p>
        {/if}

        <div class="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={!canSave} loading={saving} onclick={save}>Save checklist</Button>
          <Button
            type="button"
            variant="outline"
            loading={resetting}
            disabled={saving || resetting || !!loaded?.isDefault}
            onclick={reset}
          >
            Reset to default
          </Button>
        </div>
        <p class="text-xs text-(--muted-foreground)">
          Changing the checklist doesn't remove ticks already recorded; ticks for removed items are ignored.
        </p>
      {/if}
    </div>
  {/if}
</section>
