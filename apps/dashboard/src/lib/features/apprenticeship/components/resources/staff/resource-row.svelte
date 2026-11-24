<script lang="ts">
  import * as DropdownMenu from '@cio/ui/base/dropdown-menu';
  import { Button } from '@cio/ui/base/button';
  import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
  import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
  import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
  import { resourcesAdminApi, type ResourceItem } from '../../../api/resources-admin.svelte';
  import { fmtBytes } from '../../shared/format';
  import KindChip from './kind-chip.svelte';

  // One resource row: drag handle + up/down, kind chip, title, file / version / counts, and the actions menu.
  interface Props {
    resource: ResourceItem;
    index: number;
    total: number;
    dragging?: boolean;
    onmove: (dir: -1 | 1) => void;
    ondragstart: () => void;
    ondragend: () => void;
    ondropped: () => void;
  }
  let { resource: r, index, total, dragging = false, onmove, ondragstart, ondragend, ondropped }: Props = $props();

  const archived = $derived(r.status === 'ARCHIVED');
  const busy = $derived(resourcesAdminApi.busy.includes(r.id));
  const canDelete = $derived(r.evidenceCount === 0);
  const open = (dialog: 'edit' | 'replace' | 'move' | 'delete') =>
    (resourcesAdminApi.dialog = { mode: dialog, resource: r });
</script>

<li
  class="flex items-start gap-2 rounded-md border bg-(--background) p-2 {archived ? 'opacity-70' : ''} {dragging
    ? 'ring-2 ring-(--primary)'
    : ''}"
  draggable={!archived && !busy}
  ondragstart={(e) => {
    e.dataTransfer?.setData('text/plain', r.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    ondragstart();
  }}
  ondragover={(e) => e.preventDefault()}
  ondrop={(e) => {
    e.preventDefault();
    ondropped();
  }}
  {ondragend}
>
  <div class="flex shrink-0 flex-col items-center">
    <GripVerticalIcon class="hidden size-4 cursor-grab text-(--muted-foreground) sm:block" aria-hidden="true" />
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label="Move {r.title} up"
      disabled={index === 0 || archived || busy}
      onclick={() => onmove(-1)}
    >
      <ArrowUpIcon class="size-4" />
    </Button>
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label="Move {r.title} down"
      disabled={index === total - 1 || archived || busy}
      onclick={() => onmove(1)}
    >
      <ArrowDownIcon class="size-4" />
    </Button>
  </div>

  <div class="min-w-0 flex-1 space-y-1">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span class="font-medium break-words">{r.title}</span>
      <KindChip kind={r.kind} />
      {#if archived}
        <span class="rounded-full bg-(--muted) px-2 py-0.5 text-xs font-medium text-(--muted-foreground)">Archived</span
        >
      {/if}
    </div>
    {#if r.description}<p class="line-clamp-2 text-xs text-(--muted-foreground)">{r.description}</p>{/if}
    <p class="text-xs text-(--muted-foreground)">
      <span class="break-all">{r.file.name}</span> · {fmtBytes(r.file.size)} · v{r.version}
      {#if r.kind === 'WORKBOOK'}
        · {r.criterionIds.length} suggested criteri{r.criterionIds.length === 1 ? 'on' : 'a'}
      {/if}
      · {r.evidenceCount} evidence
    </p>
  </div>

  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="ghost" size="icon-sm" disabled={busy} aria-label="Actions for {r.title}">
          <EllipsisIcon class="size-4" />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end">
      <DropdownMenu.Item onclick={() => (resourcesAdminApi.dialog = { mode: 'preview', resource: r })}
        >Preview as learner</DropdownMenu.Item
      >
      <DropdownMenu.Item onclick={() => open('edit')}>Edit</DropdownMenu.Item>
      <DropdownMenu.Item onclick={() => open('replace')}>Replace file</DropdownMenu.Item>
      <DropdownMenu.Item onclick={() => open('move')}>Move to unit…</DropdownMenu.Item>
      <DropdownMenu.Separator />
      {#if archived}
        <DropdownMenu.Item onclick={() => resourcesAdminApi.archive(r, false)}>Restore</DropdownMenu.Item>
      {:else}
        <DropdownMenu.Item onclick={() => resourcesAdminApi.archive(r, true)}>Archive</DropdownMenu.Item>
      {/if}
      <DropdownMenu.Item
        disabled={!canDelete}
        title={canDelete ? undefined : 'Used as evidence — archive instead'}
        onclick={() => open('delete')}
        class="text-rose-600"
      >
        <span>
          Delete
          {#if !canDelete}<span class="block text-xs font-normal">Used as evidence — archive instead</span>{/if}
        </span>
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
</li>
