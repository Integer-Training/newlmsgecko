<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import { APPR_PROGRAMME_TYPE_LABELS, type ApprProgrammeType } from '@cio/utils/constants/apprenticeship';
  import type { PickerQualification } from '../../api/evidence.svelte';
  import ProgrammeTypeChip from '../shared/programme-type-chip.svelte';

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
    /** Show the "This learner is also on <other>. Map to its criteria too?" prompt (the evidence form, not the review). */
    pairPrompt?: boolean;
  }
  let {
    tree: fullTree,
    selected = $bindable(),
    metIds = null,
    disabled = false,
    idPrefix = 'crit',
    pairPrompt = true
  }: Props = $props();

  // A withdrawn qualification offers no criteria for NEW mappings: only the ones already ticked stay visible (so an
  // existing mapping can still be unticked); a qualification left with nothing drops out.
  const tree = $derived(
    fullTree
      .map((qual) =>
        qual.withdrawn
          ? {
              ...qual,
              units: qual.units
                .map((u) => ({ ...u, criteria: u.criteria.filter((c) => chosen.has(c.id)) }))
                .filter((u) => u.criteria.length > 0)
            }
          : qual
      )
      .filter((qual) => qual.units.length > 0)
  );

  // A linked pair arrives as two qualifications of different types: they get their own tabs.
  const types = $derived(
    (['DIPLOMA', 'STANDARD'] as ApprProgrammeType[]).filter((t) => tree.some((qual) => qual.type === t))
  );
  const tabbed = $derived(types.length > 1);
  let pickedTab = $state<ApprProgrammeType | null>(null);
  const activeType = $derived<ApprProgrammeType | null>(
    pickedTab && types.includes(pickedTab)
      ? pickedTab
      : (types.find((t) =>
          tree.some((qual) => qual.type === t && qual.units.some((u) => u.criteria.some((c) => chosen.has(c.id))))
        ) ??
          types[0] ??
          null)
  );
  const tickedBy = (t: ApprProgrammeType) =>
    tree
      .filter((qual) => qual.type === t)
      .reduce(
        (n, qual) => n + qual.units.reduce((m, u) => m + u.criteria.filter((c) => chosen.has(c.id)).length, 0),
        0
      );
  // Mapped to one side only → offer the other (non-blocking).
  let promptDismissed = $state(false);
  const otherSide = $derived.by(() => {
    if (!pairPrompt || !tabbed || promptDismissed || selected.length === 0) return null;
    const used = types.filter((t) => tickedBy(t) > 0);
    if (used.length !== 1) return null;
    const other = types.find((t) => t !== used[0])!;
    return { type: other, title: tree.find((qual) => qual.type === other)?.title ?? APPR_PROGRAMME_TYPE_LABELS[other] };
  });

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
      .filter((qual) => !tabbed || qual.type === activeType)
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
    <span class="ml-auto text-sm text-(--muted-foreground)" aria-live="polite">{selected.length} selected</span>
  </div>

  {#if tabbed}
    <div class="flex gap-1" role="tablist" aria-label="Qualification">
      {#each types as t (t)}
        <button
          type="button"
          role="tab"
          aria-selected={activeType === t}
          class="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm {activeType === t
            ? 'border-(--primary) bg-(--muted)'
            : 'hover:bg-(--muted)/60'}"
          onclick={() => (pickedTab = t)}
        >
          {APPR_PROGRAMME_TYPE_LABELS[t]}
          <ProgrammeTypeChip type={t} />
          {#if tickedBy(t) > 0}<span class="text-xs text-(--muted-foreground)">{tickedBy(t)}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}

  {#if otherSide}
    <div
      role="status"
      class="flex flex-wrap items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100"
    >
      <span class="min-w-0 flex-1">This learner is also on {otherSide.title}. Map to its criteria too?</span>
      <Button type="button" size="sm" variant="outline" onclick={() => (pickedTab = otherSide.type)}>
        Show {APPR_PROGRAMME_TYPE_LABELS[otherSide.type]} criteria
      </Button>
      <Button type="button" size="sm" variant="ghost" onclick={() => (promptDismissed = true)}>Not now</Button>
    </div>
  {/if}

  <div class="max-h-[22rem] overflow-y-auto rounded-md border">
    {#if visible.length === 0}
      <p class="p-3 text-sm text-(--muted-foreground)">No criteria match.</p>
    {/if}
    {#each visible as qual (qual.id)}
      {#if tree.length > 1 && !tabbed}
        <p class="bg-(--muted)/50 px-3 py-1.5 text-xs font-medium tracking-wide text-(--muted-foreground) uppercase">
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
            <span class="text-xs text-(--muted-foreground)">{ticked}/{ids.length}</span>
          </div>
          {#if isOpen}
            <ul id="{idPrefix}-{unit.id}" class="pb-1">
              {#each unit.criteria as c (c.id)}
                <li>
                  <label class="flex cursor-pointer items-start gap-2 px-3 py-1.5 pl-9 text-sm hover:bg-(--muted)/40">
                    <Checkbox
                      class="mt-0.5"
                      checked={chosen.has(c.id)}
                      onCheckedChange={(v) => toggle(c.id, v === true)}
                      {disabled}
                    />
                    <span class="min-w-0">
                      <span class="font-medium">{c.code}</span>
                      <span class="text-(--muted-foreground)"> {c.text}</span>
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
