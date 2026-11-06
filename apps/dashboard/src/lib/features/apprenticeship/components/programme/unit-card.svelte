<script lang="ts">
  import * as Table from '@cio/ui/base/table';
  import { Badge } from '@cio/ui/base/badge';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
  import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import CheckIcon from '@lucide/svelte/icons/check';
  import XIcon from '@lucide/svelte/icons/x';
  import { snackbar } from '$features/ui/snackbar/store';
  import { programmesApi, type Criterion, type Unit } from '$features/apprenticeship/api/programmes.svelte';
  import ConfirmDeleteDialog from './confirm-delete-dialog.svelte';

  // One unit: collapsible row (code, title, criteria count) with unit edit/delete/move, and inside it a compact
  // criteria table with inline add / edit / delete / move up-down.
  interface Props {
    programmeId: string;
    qualificationId: string;
    unit: Unit;
    index: number;
    total: number;
    onmove: (dir: -1 | 1) => void | Promise<void>;
  }

  let { programmeId, qualificationId, unit, index, total, onmove }: Props = $props();

  let expanded = $state(false);
  let editingUnit = $state(false);
  let unitCode = $state('');
  let unitTitle = $state('');
  let busy = $state(false);

  // Criterion editing: a draft keyed by criterion id, or the "new" draft row.
  interface Draft {
    code: string;
    text: string;
    groupLabel: string;
    requiredCount: number;
  }
  const blank = (): Draft => ({ code: '', text: '', groupLabel: '', requiredCount: 1 });
  let editingId = $state<string | null>(null);
  let adding = $state(false);
  let draft = $state<Draft>(blank());

  type Target = { kind: 'unit' } | { kind: 'criterion'; criterion: Criterion };
  let deleteTarget = $state<Target | null>(null);
  let deleteOpen = $state(false);

  const draftValid = $derived(
    !!draft.code.trim() &&
      !!draft.text.trim() &&
      Number.isInteger(draft.requiredCount) &&
      draft.requiredCount >= 1 &&
      draft.requiredCount <= 50
  );

  function startEditUnit() {
    unitCode = unit.code ?? '';
    unitTitle = unit.title;
    editingUnit = true;
  }

  async function saveUnit(e: Event) {
    e.preventDefault();
    if (!unitTitle.trim() || busy) return;
    busy = true;
    const ok = await programmesApi.updateUnit(programmeId, qualificationId, unit.id, {
      code: unitCode.trim() || null,
      title: unitTitle.trim()
    });
    busy = false;
    if (ok) editingUnit = false;
  }

  function startAdd() {
    expanded = true;
    editingId = null;
    draft = blank();
    adding = true;
  }

  function startEdit(c: Criterion) {
    adding = false;
    editingId = c.id;
    draft = { code: c.code, text: c.text, groupLabel: c.groupLabel ?? '', requiredCount: c.requiredCount };
  }

  function cancelDraft() {
    adding = false;
    editingId = null;
  }

  async function saveDraft(e: Event) {
    e.preventDefault();
    if (!draftValid || busy) return;
    busy = true;
    const payload = {
      code: draft.code.trim(),
      text: draft.text.trim(),
      groupLabel: draft.groupLabel.trim() || null,
      requiredCount: draft.requiredCount
    };
    const ok = editingId
      ? await programmesApi.updateCriterion(programmeId, qualificationId, unit.id, editingId, payload)
      : await programmesApi.createCriterion(programmeId, qualificationId, unit.id, payload);
    busy = false;
    if (!ok) return;
    if (editingId) {
      editingId = null;
    } else {
      // Stay in add mode so several criteria can be keyed in a row.
      draft = blank();
    }
  }

  async function moveCriterion(i: number, dir: -1 | 1) {
    const ids = unit.criteria.map((c) => c.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    busy = true;
    await programmesApi.reorder(programmeId, 'criterion', unit.id, ids);
    busy = false;
  }

  function askDelete(target: Target) {
    deleteTarget = target;
    deleteOpen = true;
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    busy = true;
    const removed =
      deleteTarget.kind === 'unit'
        ? await programmesApi.deleteUnit(programmeId, qualificationId, unit.id)
        : await programmesApi.deleteCriterion(programmeId, qualificationId, unit.id, deleteTarget.criterion.id);
    busy = false;
    if (removed === undefined) return;
    deleteOpen = false;
    if (removed > 0) {
      snackbar.info(
        `Deleted. ${removed} piece${removed === 1 ? '' : 's'} of evidence ${removed === 1 ? 'was' : 'were'} unlinked from it.`
      );
    } else {
      snackbar.success('Deleted');
    }
  }

  const deleteText = $derived(
    deleteTarget?.kind === 'criterion'
      ? `Delete criterion ${deleteTarget.criterion.code}? Any evidence mapped to it is unlinked and learner progress is recalculated.`
      : `Delete unit ${unit.code ? unit.code + ' ' : ''}${unit.title} and its ${unit.criteria.length} criteri${unit.criteria.length === 1 ? 'on' : 'a'}? Any evidence mapped to them is unlinked and learner progress is recalculated.`
  );
</script>

{#snippet draftRow()}
  <Table.Row class="bg-muted/30">
    <Table.Cell>
      <Input aria-label="Criterion code" bind:value={draft.code} maxlength={100} placeholder="1.1" class="h-8 w-20" />
    </Table.Cell>
    <Table.Cell>
      <Input
        aria-label="Criterion text"
        bind:value={draft.text}
        maxlength={5000}
        placeholder="What the learner must show"
        class="h-8 min-w-48"
      />
    </Table.Cell>
    <Table.Cell>
      <Input aria-label="Group" bind:value={draft.groupLabel} maxlength={200} placeholder="Group" class="h-8 w-32" />
    </Table.Cell>
    <Table.Cell>
      <Input
        aria-label="Evidence required"
        type="number"
        min={1}
        max={50}
        bind:value={draft.requiredCount}
        class="h-8 w-16"
      />
    </Table.Cell>
    <Table.Cell class="text-right">
      <div class="flex justify-end gap-1">
        <Button type="submit" size="icon-sm" aria-label="Save criterion" disabled={!draftValid || busy}>
          <CheckIcon class="size-4" />
        </Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Cancel" onclick={cancelDraft}>
          <XIcon class="size-4" />
        </Button>
      </div>
    </Table.Cell>
  </Table.Row>
{/snippet}

<div class="bg-background rounded-md border">
  <div class="flex flex-wrap items-center gap-2 p-2">
    <button
      type="button"
      class="hover:bg-muted flex size-7 items-center justify-center rounded"
      aria-expanded={expanded}
      aria-label="{expanded ? 'Collapse' : 'Expand'} unit {unit.code ?? unit.title}"
      onclick={() => (expanded = !expanded)}
    >
      {#if expanded}<ChevronDownIcon size={16} />{:else}<ChevronRightIcon size={16} />{/if}
    </button>

    {#if editingUnit}
      <form onsubmit={saveUnit} class="flex flex-1 flex-wrap items-center gap-2">
        <Input aria-label="Unit code" bind:value={unitCode} maxlength={100} placeholder="Code" class="h-8 w-24" />
        <Input
          aria-label="Unit title"
          bind:value={unitTitle}
          maxlength={300}
          placeholder="Unit title"
          class="h-8 min-w-48 flex-1"
          required
        />
        <Button type="submit" size="icon-sm" aria-label="Save unit" disabled={!unitTitle.trim() || busy}>
          <CheckIcon class="size-4" />
        </Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Cancel" onclick={() => (editingUnit = false)}>
          <XIcon class="size-4" />
        </Button>
      </form>
    {:else}
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-2 text-left"
        onclick={() => (expanded = !expanded)}
        tabindex="-1"
      >
        {#if unit.code}<Badge variant="outline" class="shrink-0">{unit.code}</Badge>{/if}
        <span class="truncate font-medium">{unit.title}</span>
        <span class="text-muted-foreground shrink-0 text-xs">
          {unit.criteria.length} criteri{unit.criteria.length === 1 ? 'on' : 'a'}
        </span>
      </button>
      <div class="flex items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Move unit up"
          disabled={index === 0}
          onclick={() => onmove(-1)}
        >
          <ArrowUpIcon class="size-4" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Move unit down"
          disabled={index === total - 1}
          onclick={() => onmove(1)}
        >
          <ArrowDownIcon class="size-4" />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Add criterion" onclick={startAdd}>
          <PlusIcon class="size-4" />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Edit unit" onclick={startEditUnit}>
          <PencilIcon class="size-4" />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Delete unit" onclick={() => askDelete({ kind: 'unit' })}>
          <Trash2Icon class="size-4" />
        </Button>
      </div>
    {/if}
  </div>

  {#if expanded}
    <form onsubmit={saveDraft} class="border-t">
      <div class="overflow-x-auto">
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head class="w-24">Code</Table.Head>
              <Table.Head>Criterion</Table.Head>
              <Table.Head class="w-36">Group</Table.Head>
              <Table.Head class="w-20">Required</Table.Head>
              <Table.Head class="w-40 text-right"><span class="sr-only">Actions</span></Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each unit.criteria as c, i (c.id)}
              {#if editingId === c.id}
                {@render draftRow()}
              {:else}
                <Table.Row>
                  <Table.Cell class="font-mono text-xs">{c.code}</Table.Cell>
                  <Table.Cell class="text-sm whitespace-normal">{c.text}</Table.Cell>
                  <Table.Cell class="text-muted-foreground text-sm">{c.groupLabel ?? '—'}</Table.Cell>
                  <Table.Cell class="tabular-nums">{c.requiredCount}</Table.Cell>
                  <Table.Cell class="text-right">
                    <div class="flex justify-end gap-1">
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Move {c.code} up"
                        disabled={i === 0 || busy}
                        onclick={() => moveCriterion(i, -1)}
                      >
                        <ArrowUpIcon class="size-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Move {c.code} down"
                        disabled={i === unit.criteria.length - 1 || busy}
                        onclick={() => moveCriterion(i, 1)}
                      >
                        <ArrowDownIcon class="size-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Edit {c.code}"
                        onclick={() => startEdit(c)}
                      >
                        <PencilIcon class="size-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Delete {c.code}"
                        onclick={() => askDelete({ kind: 'criterion', criterion: c })}
                      >
                        <Trash2Icon class="size-4" />
                      </Button>
                    </div>
                  </Table.Cell>
                </Table.Row>
              {/if}
            {:else}
              {#if !adding}
                <Table.Row>
                  <Table.Cell colspan={5} class="text-muted-foreground py-4 text-center text-sm">
                    No criteria yet. Add one below, or import them from a spreadsheet.
                  </Table.Cell>
                </Table.Row>
              {/if}
            {/each}
            {#if adding}
              {@render draftRow()}
            {/if}
          </Table.Body>
        </Table.Root>
      </div>
      {#if !adding}
        <div class="border-t p-2">
          <Button type="button" size="sm" variant="ghost" onclick={startAdd}>
            <PlusIcon class="size-4" /> Add criterion
          </Button>
        </div>
      {/if}
    </form>
  {/if}
</div>

<ConfirmDeleteDialog
  bind:open={deleteOpen}
  title={deleteTarget?.kind === 'criterion' ? 'Delete criterion' : 'Delete unit'}
  description={deleteText}
  {busy}
  onconfirm={confirmDelete}
/>
