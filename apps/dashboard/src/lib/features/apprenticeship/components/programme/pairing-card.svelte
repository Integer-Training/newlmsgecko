<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '@cio/ui/base/button';
  import * as Select from '@cio/ui/base/select';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { currentOrg } from '$lib/utils/store/org';
  import { snackbar } from '$features/ui/snackbar/store';
  import {
    programmesApi,
    type PairCandidate,
    type ProgrammeTree
  } from '$features/apprenticeship/api/programmes.svelte';

  // Diploma: pick the Standard it is delivered alongside. Standard: read-only list of diplomas paired to it.
  interface Props {
    programme: ProgrammeTree;
  }
  let { programme }: Props = $props();

  const NONE = '__none__';
  let candidates = $state<PairCandidate[] | null>(null);
  let candidatesError = $state<string | null>(null);
  let selected = $state(NONE);
  let saving = $state(false);

  const base = $derived(`/org/${$currentOrg.siteName}/apprenticeships/programmes`);
  const paired = $derived(programme.pairedProgramme ?? null);
  const isDiploma = $derived(programme.type === 'DIPLOMA');
  const dirty = $derived(selected !== (paired?.id ?? NONE));

  // Candidates always include the current pairing so its title can show even when it no longer qualifies.
  const options = $derived.by(() => {
    const list = [...(candidates ?? [])];
    if (paired && !list.some((c) => c.id === paired.id)) list.unshift(paired);
    return list;
  });
  const selectedLabel = $derived(options.find((o) => o.id === selected)?.title ?? 'No paired standard');

  async function loadCandidates() {
    candidatesError = null;
    const res = await programmesApi.loadPairCandidates(programme.id);
    if (res.ok) candidates = res.data;
    else candidatesError = res.error;
  }

  onMount(() => {
    if (isDiploma) loadCandidates();
  });

  // Re-seed the picker when the saved pairing (or programme) changes.
  let seeded = '';
  $effect(() => {
    // Also re-seeds when the candidate list arrives, so a hard load shows the saved pairing.
    const key = `${programme.id}:${paired?.id ?? ''}:${candidates === null ? 'wait' : 'ready'}`;
    if (key === seeded) return;
    seeded = key;
    selected = paired?.id ?? NONE;
  });

  async function save(value: string | null) {
    saving = true;
    // The API surfaces 400/409 messages as a toast via the shared failure handler.
    const ok = await programmesApi.updateProgramme(programme.id, { pairedProgrammeId: value });
    saving = false;
    if (ok) snackbar.success(value ? 'Standard paired' : 'Pairing cleared');
  }
</script>

<section class="flex flex-col gap-3 rounded-xl border bg-(--card) p-4" aria-labelledby="pairing-title">
  {#if isDiploma}
    <h2 id="pairing-title" class="text-lg font-semibold tracking-tight">Paired standard</h2>
    <p class="text-sm text-(--muted-foreground)">
      The apprenticeship standard this diploma is delivered with. Several diplomas can share one standard; each diploma
      pairs with at most one.
    </p>

    {#if !paired}
      <div
        class="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        role="status"
      >
        <TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>
          Not paired with a standard yet. Learners on this diploma will not get standard progress until it is paired.
        </span>
      </div>
    {/if}

    {#if candidatesError}
      <div class="flex items-center gap-3" role="alert">
        <p class="text-sm text-red-600">{candidatesError}</p>
        <Button variant="outline" size="sm" onclick={loadCandidates}>Try again</Button>
      </div>
    {:else}
      <div class="flex flex-wrap items-end gap-3">
        <div class="flex flex-col gap-1">
          <span id="pair-label" class="text-sm font-medium">Standard</span>
          <Select.Root type="single" bind:value={selected} disabled={candidates === null}>
            <Select.Trigger class="min-w-72" aria-labelledby="pair-label">
              <p>{candidates === null ? 'Loading…' : selectedLabel}</p>
            </Select.Trigger>
            <Select.Content>
              <Select.Item value={NONE}>No paired standard</Select.Item>
              {#each options as o (o.id)}
                <Select.Item value={o.id}>{o.title}{o.level ? ` (Level ${o.level})` : ''}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <Button disabled={!dirty || selected === NONE || saving} loading={saving} onclick={() => save(selected)}
          >Save pairing</Button
        >
        {#if paired}
          <Button variant="outline" disabled={saving} onclick={() => save(null)}>Clear pairing</Button>
        {/if}
      </div>
      {#if candidates && candidates.length === 0 && !paired}
        <p class="text-xs text-(--muted-foreground)">
          No active standards at this level yet. Create one from All programmes, then pair it here.
        </p>
      {/if}
    {/if}

    {#if paired}
      <p class="text-sm">
        Currently paired with
        <a href="{base}/{paired.id}" class="font-medium underline">{paired.title}</a>
      </p>
    {/if}
  {:else}
    <h2 id="pairing-title" class="text-lg font-semibold tracking-tight">Used by</h2>
    {#if (programme.pairedDiplomas ?? []).length === 0}
      <p class="text-sm text-(--muted-foreground)">
        No apprenticeship diplomas are paired with this standard yet. Pair one from the diploma's page.
      </p>
    {:else}
      <ul class="flex flex-col gap-1 text-sm">
        {#each programme.pairedDiplomas ?? [] as d (d.id)}
          <li><a href="{base}/{d.id}" class="font-medium hover:underline">{d.title}</a></li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>
