<script lang="ts">
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import { snackbar } from '$features/ui/snackbar/store';
  import { apprTutorsApi, type TutorProgrammes } from '$features/apprenticeship/api/tutors.svelte';
  import { programmesApi } from '$features/apprenticeship/api/programmes.svelte';
  import ProgrammeTypeChip from '$features/apprenticeship/components/shared/programme-type-chip.svelte';

  // Tutor Management › Apprenticeships: the apprenticeship programmes a tutor teaches (like their courses). Saves the
  // exact selection. Archived programmes are listed only while still assigned, so they can be removed.

  interface Props {
    open: boolean;
    tutorId: string | null;
    tutorName: string;
  }

  let { open = $bindable(), tutorId, tutorName }: Props = $props();

  let data = $state<TutorProgrammes | null>(null);
  let selected = $state<string[]>([]);
  let error = $state('');
  let busy = $state(false);
  let loadedFor = $state<string | null>(null);
  // Per diploma: also assign its paired standard when the diploma is ticked (default on).
  let alsoPair = $state<Record<string, boolean>>({});

  $effect(() => {
    if (open && tutorId && loadedFor !== tutorId) {
      loadedFor = tutorId;
      load(tutorId);
    }
  });

  async function load(id: string) {
    data = null;
    error = '';
    if (!programmesApi.programmes) await programmesApi.load('ALL', 'ALL');
    const res = await apprTutorsApi.tutorProgrammes(id);
    if (loadedFor !== id) return;
    if (res.ok) {
      data = res.data;
      selected = [...res.data.assignedProgrammeIds];
    } else error = res.error;
  }

  const options = $derived(
    (data?.programmes ?? []).filter((p) => p.status === 'ACTIVE' || data?.assignedProgrammeIds.includes(p.id))
  );

  type Option = { id: string; title: string; status: string };
  type Group = { main: Option; pair: Option | null; type: string };

  // Pairs first (a diploma with its standard beneath), then unpaired diplomas and standards. Without pairing info
  // (the programme catalogue failed to load) every programme is listed on its own.
  const groups = $derived.by<Group[]>(() => {
    const meta = new Map((programmesApi.programmes ?? []).map((p) => [p.id, p]));
    const byId = new Map(options.map((o) => [o.id, o]));
    const used = new Set<string>();
    const out: Group[] = [];
    for (const o of options) {
      const m = meta.get(o.id);
      if (m?.type === 'STANDARD') continue;
      const pairId = m?.pairedProgramme?.id;
      const pair = pairId ? (byId.get(pairId) ?? null) : null;
      used.add(o.id);
      if (pair) used.add(pair.id);
      out.push({ main: o, pair, type: m?.type ?? 'DIPLOMA' });
    }
    for (const o of options) if (!used.has(o.id)) out.push({ main: o, pair: null, type: 'STANDARD' });
    return out;
  });

  function toggle(id: string, checked: boolean, pairId?: string | null) {
    let next = selected;
    if (checked) {
      if (!next.includes(id)) next = [...next, id];
      if (pairId && alsoPair[id] !== false && !next.includes(pairId)) next = [...next, pairId];
    } else next = next.filter((x) => x !== id);
    selected = next;
  }

  function onOpenChange(next: boolean) {
    if (!next) loadedFor = null;
  }

  async function save() {
    if (!tutorId || !data || busy) return;
    busy = true;
    const res = await apprTutorsApi.setTutorProgrammes(tutorId, selected);
    busy = false;
    if (res.ok) {
      snackbar.success('Apprenticeships updated');
      open = false;
      loadedFor = null;
    } else snackbar.error(res.error);
  }
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Manage apprenticeships</Dialog.Title>
      <Dialog.Description>Choose the apprenticeship programmes {tutorName} teaches.</Dialog.Description>
    </Dialog.Header>

    {#if error}
      <p class="py-6 text-center text-sm text-red-600">{error}</p>
    {:else if !data}
      <p class="ui:text-muted-foreground py-6 text-center text-sm">Loading…</p>
    {:else}
      <p class="ui:text-muted-foreground text-xs">
        The tutor can see and mark every apprentice on a selected programme. Alerts (new evidence, reviews, overdue
        tasks) still go to each apprentice's named tutor, set on the apprentice's portfolio.
      </p>
      {#if options.length === 0}
        <p class="ui:text-muted-foreground text-sm">No apprenticeship programmes yet.</p>
      {:else}
        <div class="max-h-60 divide-y overflow-y-auto rounded-md border">
          {#each groups as g (g.main.id)}
            <div>
              <label class="hover:bg-muted/50 flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                <Checkbox
                  disabled={busy}
                  checked={selected.includes(g.main.id)}
                  onCheckedChange={(v) => toggle(g.main.id, v === true, g.pair?.id)}
                />
                <ProgrammeTypeChip type={g.type} />
                <span>{g.main.title}</span>
                {#if g.main.status !== 'ACTIVE'}
                  <span class="ui:text-muted-foreground ml-auto text-xs">Archived</span>
                {/if}
              </label>
              {#if g.pair}
                <label class="hover:bg-muted/50 flex cursor-pointer items-center gap-2 py-2 pr-3 pl-9 text-sm">
                  <Checkbox
                    disabled={busy}
                    checked={selected.includes(g.pair.id)}
                    onCheckedChange={(v) => toggle(g.pair!.id, v === true)}
                  />
                  <ProgrammeTypeChip type="STANDARD" />
                  <span>{g.pair.title}</span>
                </label>
                <label class="ui:text-muted-foreground flex cursor-pointer items-center gap-2 pr-3 pb-2 pl-9 text-xs">
                  <Checkbox
                    disabled={busy}
                    checked={alsoPair[g.main.id] !== false}
                    onCheckedChange={(v) => (alsoPair[g.main.id] = v === true)}
                  />
                  Also assign the paired standard when this programme is ticked
                </label>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {/if}

    <Dialog.Footer class="mt-4">
      <Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
      <Button onclick={save} loading={busy} disabled={!data}>Save apprenticeships</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
