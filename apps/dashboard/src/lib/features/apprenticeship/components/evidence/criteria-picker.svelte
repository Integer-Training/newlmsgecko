<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import { Input } from '@cio/ui/base/input';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import type { PickerQualification } from '../../api/evidence.svelte';

  // Criteria picker: qualification → units (collapsible) → criteria, with a search box, an optional "show unmet only"
  // filter (only when the caller knows which criteria are met), per-unit select-all and a selected count. Pre-ticked
  // criteria come in through `selected`.

  interface Props {
    tree: PickerQualification[];
    selected: string[];
    /** Criteria already met for this learner; enables the "show unmet only" filter. */
    metIds?: Set<string> | null;
    disabled?: boolean;
    idPrefix?: string;
  }
  let { tree, selected = $bindable(), metIds = null, disabled = false, idPrefix = 'crit' }: Props = $props();

  let search = $state('');
  let unmetOnly = $state(false);
  const open = new SvelteSet<string>();
  const chosen = $derived(new Set(selected));

  // Open the units that already hold a ticked criterion, once the tree is there.
  let seeded = false;
  $effect(() => {
    if (seeded || tree.length === 0) return;
    seeded = true;
    for (const q of tree) {
      for (const u of q.units) if (u.criteria.some((c) => chosen.has(c.id))) open.add(u.id);
    }
  });

  const q = $derived(search.trim().toLowerCase());
  const visible = $derived(
    tree
      .map((qual) => ({
        ...qual,
        units: qual.units
          .map((u) => {
            const unitHit = !!q && `${u.code ?? ''} ${u.title}`.toLowerCase().includes(q);
            const criteria = u.criteria.filter((c) => {
              if (unmetOnly && metIds?.has(c.id) && !chosen.has(c.id)) return false;
              if (!q || unitHit) return true;
              return `${c.code} ${c.text}`.toLowerCase().includes(q);
            });
            return { ...u, criteria };
          })
          .filter((u) => u.criteria.length > 0)
      }))
      .filter((qual) => qual.units.length > 0)
  );

  function toggle(id: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    selected = [...next];
  }

  function toggleUnit(ids: string[], on: boolean) {
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    selected = [...next];
  }

  function toggleOpen(unitId: string) {
    if (open.has(unitId)) open.delete(unitId);
    else open.add(unitId);
  }
</script>

<div class="space-y-2">
  <div class="flex flex-wrap items-center gap-3">
    <Input
      type="search"
      placeholder="Search criteria or units"
      aria-label="Search criteria"
      class="ui:max-w-xs"
      bind:value={search}
    />
    {#if metIds}
      <label class="flex items-center gap-2 text-sm">
        <Checkbox bind:checked={unmetOnly} aria-label="Show unmet criteria only" />
        Show unmet only
      </label>
    {/if}
    <span class="text-muted-foreground ml-auto text-sm" aria-live="polite">{selected.length} selected</span>
  </div>

  <div class="max-h-[22rem] overflow-y-auto rounded-md border">
    {#if visible.length === 0}
      <p class="text-muted-foreground p-3 text-sm">No criteria match.</p>
    {/if}
    {#each visible as qual (qual.id)}
      {#if tree.length > 1}
        <p class="bg-muted/50 text-muted-foreground px-3 py-1.5 text-xs font-medium tracking-wide uppercase">
          {qual.title}
        </p>
      {/if}
      {#each qual.units as unit (unit.id)}
        {@const ids = unit.criteria.map((c) => c.id)}
        {@const ticked = ids.filter((id) => chosen.has(id)).length}
        {@const isOpen = open.has(unit.id) || !!q}
        <div class="border-b last:border-b-0">
          <div class="flex items-center gap-2 px-3 py-2">
            <Checkbox
              checked={ticked === ids.length && ids.length > 0}
              indeterminate={ticked > 0 && ticked < ids.length}
              onCheckedChange={(v) => toggleUnit(ids, v === true)}
              {disabled}
              aria-label="Select all criteria in {unit.title}"
            />
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-1 text-left text-sm font-medium"
              aria-expanded={isOpen}
              aria-controls="{idPrefix}-{unit.id}"
              onclick={() => toggleOpen(unit.id)}
            >
              {#if isOpen}<ChevronDownIcon size={16} class="shrink-0" />{:else}<ChevronRightIcon
                  size={16}
                  class="shrink-0"
                />{/if}
              <span class="truncate">{unit.code ? `${unit.code} · ` : ''}{unit.title}</span>
            </button>
            <span class="text-muted-foreground text-xs">{ticked}/{ids.length}</span>
          </div>
          {#if isOpen}
            <ul id="{idPrefix}-{unit.id}" class="pb-1">
              {#each unit.criteria as c (c.id)}
                <li>
                  <label class="hover:bg-muted/40 flex cursor-pointer items-start gap-2 px-3 py-1.5 pl-9 text-sm">
                    <Checkbox
                      class="mt-0.5"
                      checked={chosen.has(c.id)}
                      onCheckedChange={(v) => toggle(c.id, v === true)}
                      {disabled}
                    />
                    <span class="min-w-0">
                      <span class="font-medium">{c.code}</span>
                      <span class="text-muted-foreground"> {c.text}</span>
                      {#if metIds?.has(c.id)}<span class="ml-1 text-xs text-emerald-600">met</span>{/if}
                    </span>
                  </label>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
    {/each}
  </div>
</div>
