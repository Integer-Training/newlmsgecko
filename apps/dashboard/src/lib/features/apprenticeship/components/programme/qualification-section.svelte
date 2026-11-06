<script lang="ts">
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import CheckIcon from '@lucide/svelte/icons/check';
  import XIcon from '@lucide/svelte/icons/x';
  import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
  import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
  import { snackbar } from '$features/ui/snackbar/store';
  import { programmesApi, type Qualification } from '$features/apprenticeship/api/programmes.svelte';
  import UnitCard from './unit-card.svelte';
  import ConfirmDeleteDialog from './confirm-delete-dialog.svelte';

  // One qualification: its title/reference, its units (collapsible rows) and an inline "add unit" form.
  // The UI normally shows a single qualification but supports several (move / delete appear when there is more than one).
  interface Props {
    programmeId: string;
    qualification: Qualification;
    index: number;
    total: number;
    onimport: () => void;
  }

  let { programmeId, qualification, index, total, onimport }: Props = $props();

  let editing = $state(false);
  let title = $state('');
  let reference = $state('');
  let addingUnit = $state(false);
  let newCode = $state('');
  let newTitle = $state('');
  let busy = $state(false);
  let deleteOpen = $state(false);

  function startEdit() {
    title = qualification.title;
    reference = qualification.reference ?? '';
    editing = true;
  }

  async function save(e: Event) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    busy = true;
    const ok = await programmesApi.updateQualification(programmeId, qualification.id, {
      title: title.trim(),
      reference: reference.trim() || null
    });
    busy = false;
    if (ok) editing = false;
  }

  async function addUnit(e: Event) {
    e.preventDefault();
    if (!newTitle.trim() || busy) return;
    busy = true;
    const ok = await programmesApi.createUnit(programmeId, qualification.id, {
      code: newCode.trim() || null,
      title: newTitle.trim()
    });
    busy = false;
    if (ok) {
      newCode = '';
      newTitle = '';
    }
  }

  async function moveUnit(i: number, dir: -1 | 1) {
    const ids = qualification.units.map((u) => u.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await programmesApi.reorder(programmeId, 'unit', qualification.id, ids);
  }

  async function moveSelf(dir: -1 | 1) {
    const ids = (programmesApi.tree?.qualifications ?? []).map((q) => q.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    await programmesApi.reorder(programmeId, 'qualification', programmeId, ids);
  }

  async function remove() {
    busy = true;
    const removed = await programmesApi.deleteQualification(programmeId, qualification.id);
    busy = false;
    if (removed === undefined) return;
    deleteOpen = false;
    snackbar.info(
      removed > 0
        ? `Qualification deleted. ${removed} piece${removed === 1 ? '' : 's'} of evidence unlinked.`
        : 'Qualification deleted'
    );
  }

  const criteriaTotal = $derived(qualification.units.reduce((n, u) => n + u.criteria.length, 0));
</script>

<section class="bg-card rounded-xl border p-4" aria-label="Qualification {qualification.title}">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
    {#if editing}
      <form onsubmit={save} class="flex flex-1 flex-wrap items-center gap-2">
        <Input
          aria-label="Qualification title"
          bind:value={title}
          maxlength={200}
          class="h-8 min-w-48 flex-1"
          required
        />
        <Input
          aria-label="Qualification reference"
          bind:value={reference}
          maxlength={100}
          placeholder="Reference"
          class="h-8 w-36"
        />
        <Button type="submit" size="icon-sm" aria-label="Save qualification" disabled={!title.trim() || busy}>
          <CheckIcon class="size-4" />
        </Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Cancel" onclick={() => (editing = false)}>
          <XIcon class="size-4" />
        </Button>
      </form>
    {:else}
      <div class="min-w-0">
        <h2 class="truncate text-lg font-semibold tracking-tight">{qualification.title}</h2>
        <p class="text-muted-foreground text-xs">
          {#if qualification.reference}{qualification.reference} ·
          {/if}{qualification.units.length} unit{qualification.units.length === 1 ? '' : 's'} · {criteriaTotal} criteri{criteriaTotal ===
          1
            ? 'on'
            : 'a'}
        </p>
      </div>
      <div class="flex items-center gap-1">
        {#if total > 1}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Move qualification up"
            disabled={index === 0}
            onclick={() => moveSelf(-1)}
          >
            <ArrowUpIcon class="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Move qualification down"
            disabled={index === total - 1}
            onclick={() => moveSelf(1)}
          >
            <ArrowDownIcon class="size-4" />
          </Button>
        {/if}
        <Button size="icon-sm" variant="ghost" aria-label="Edit qualification" onclick={startEdit}>
          <PencilIcon class="size-4" />
        </Button>
        {#if total > 1}
          <Button size="icon-sm" variant="ghost" aria-label="Delete qualification" onclick={() => (deleteOpen = true)}>
            <Trash2Icon class="size-4" />
          </Button>
        {/if}
      </div>
    {/if}
  </div>

  {#if qualification.units.length === 0}
    <div
      class="text-muted-foreground flex flex-col items-center gap-3 rounded-md border border-dashed py-8 text-center text-sm"
    >
      <p>Add a unit below, or import units and criteria from a spreadsheet.</p>
      <Button variant="outline" size="sm" onclick={onimport}>Import from a spreadsheet</Button>
    </div>
  {:else}
    <div class="flex flex-col gap-2">
      {#each qualification.units as unit, i (unit.id)}
        <UnitCard
          {programmeId}
          qualificationId={qualification.id}
          {unit}
          index={i}
          total={qualification.units.length}
          onmove={(dir) => moveUnit(i, dir)}
        />
      {/each}
    </div>
  {/if}

  <form onsubmit={addUnit} class="mt-3 flex flex-wrap items-end gap-2">
    <div class="space-y-1">
      <label for="au-code-{qualification.id}" class="text-xs font-medium">Unit code</label>
      <Input id="au-code-{qualification.id}" bind:value={newCode} maxlength={100} placeholder="K1" class="h-8 w-24" />
    </div>
    <div class="min-w-48 flex-1 space-y-1">
      <label for="au-title-{qualification.id}" class="text-xs font-medium">Unit title</label>
      <Input
        id="au-title-{qualification.id}"
        bind:value={newTitle}
        maxlength={300}
        placeholder="Unit title"
        class="h-8"
      />
    </div>
    <Button type="submit" size="sm" disabled={!newTitle.trim() || busy}>
      <PlusIcon class="size-4" /> Add unit
    </Button>
  </form>
</section>

<ConfirmDeleteDialog
  bind:open={deleteOpen}
  title="Delete qualification"
  description="Delete {qualification.title} with all its units and criteria? Any evidence mapped to them is unlinked and learner progress is recalculated."
  {busy}
  onconfirm={remove}
/>
