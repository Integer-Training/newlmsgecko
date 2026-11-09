<script lang="ts">
  import { Button } from '@cio/ui/base/button';
  import { Badge } from '@cio/ui/base/badge';
  import { Search } from '@cio/ui/custom/search';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
  import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
  import PaperclipIcon from '@lucide/svelte/icons/paperclip';
  import { snackbar } from '$features/ui/snackbar/store';
  import { evidenceApi, type PickerQualification } from '../../api/evidence.svelte';
  import { taskPlansApi, type TaskPlanItem } from '../../api/task-plans.svelte';
  import { fmtMinutes } from '../shared/format';
  import ConfirmDeleteDialog from '../programme/confirm-delete-dialog.svelte';
  import TaskItemDialog from './task-item-dialog.svelte';

  // The plan's tasks, sorted by sequence (move up / down saves the new order), with add / edit / delete.
  interface Props {
    planId: string;
    items: TaskPlanItem[];
    tree: PickerQualification[];
    /** Reload the plan after any change. */
    onchanged: () => void | Promise<void>;
  }

  let { planId, items, tree, onchanged }: Props = $props();

  let search = $state('');
  let dialogOpen = $state(false);
  let editing = $state<TaskPlanItem | null>(null);
  let deleting = $state<TaskPlanItem | null>(null);
  let deleteOpen = $state(false);
  let deleteBusy = $state(false);
  let moving = $state(false);

  const sorted = $derived([...items].sort((a, b) => a.sequence - b.sequence));
  const typeLabel = (key: string) => evidenceApi.types.find((t) => t.key === key)?.label ?? key;
  const visible = $derived.by(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((i) => `${i.title} ${i.details} ${typeLabel(i.typeKey)}`.toLowerCase().includes(q));
  });

  function openAdd() {
    editing = null;
    dialogOpen = true;
  }
  function openEdit(item: TaskPlanItem) {
    editing = item;
    dialogOpen = true;
  }

  async function move(item: TaskPlanItem, dir: -1 | 1) {
    const ids = sorted.map((i) => i.id);
    const from = ids.indexOf(item.id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    moving = true;
    const res = await taskPlansApi.reorder(planId, ids);
    if (!res.ok) snackbar.error(res.error);
    else await onchanged();
    moving = false;
  }

  async function confirmDelete() {
    if (!deleting) return;
    deleteBusy = true;
    const res = await taskPlansApi.deleteItem(planId, deleting.id);
    deleteBusy = false;
    if (!res.ok) {
      snackbar.error(res.error);
      return;
    }
    snackbar.success(
      res.data.removedTasks > 0
        ? `Task deleted · removed from ${res.data.removedTasks} learner${res.data.removedTasks === 1 ? '' : 's'}`
        : 'Task deleted'
    );
    deleteOpen = false;
    await onchanged();
  }
</script>

<section class="flex flex-col gap-3 rounded-xl border bg-(--card) p-4" aria-labelledby="tp-tasks-h">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h2 id="tp-tasks-h" class="text-lg font-semibold tracking-tight">
      Tasks <span class="text-sm font-normal text-(--muted-foreground)">({items.length})</span>
    </h2>
    <div class="flex items-center gap-2">
      {#if items.length > 3}
        <Search placeholder="Search tasks" bind:value={search} />
      {/if}
      <Button size="sm" onclick={openAdd}><PlusIcon class="size-4" /> Add task</Button>
    </div>
  </div>

  {#if items.length === 0}
    <p class="rounded-md border border-dashed p-6 text-center text-sm text-(--muted-foreground)">
      No tasks yet. Add the tasks learners should complete, then assign the plan.
    </p>
  {:else if visible.length === 0}
    <p class="p-4 text-center text-sm text-(--muted-foreground)">No tasks match your search.</p>
  {:else}
    <ol class="space-y-2">
      {#each visible as item (item.id)}
        {@const idx = sorted.findIndex((i) => i.id === item.id)}
        <li class="flex items-start gap-3 rounded-lg border p-3">
          <span class="mt-0.5 w-6 shrink-0 text-center text-sm font-medium text-(--muted-foreground) tabular-nums">
            {idx + 1}
          </span>
          <div class="min-w-0 flex-1 space-y-1">
            <p class="font-medium break-words">{item.title}</p>
            {#if item.details}
              <p class="line-clamp-2 text-sm break-words text-(--muted-foreground)">{item.details}</p>
            {/if}
            <div class="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs">
              <Badge variant="secondary">{typeLabel(item.typeKey)}</Badge>
              <span class="text-(--muted-foreground)">
                Due start + {item.monthOffset} month{item.monthOffset === 1 ? '' : 's'}
              </span>
              <span class="text-(--muted-foreground)">· {fmtMinutes(item.expectedMinutes)}</span>
              <span class="text-(--muted-foreground)">
                · {item.criteria.length} criteri{item.criteria.length === 1 ? 'on' : 'a'}
              </span>
              {#if item.files.length > 0}
                <span class="inline-flex items-center gap-0.5 text-(--muted-foreground)">
                  · <PaperclipIcon size={12} />{item.files.length} file{item.files.length === 1 ? '' : 's'}
                </span>
              {/if}
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={moving || idx === 0 || !!search.trim()}
              aria-label="Move {item.title} up"
              onclick={() => move(item, -1)}
            >
              <ArrowUpIcon class="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={moving || idx === sorted.length - 1 || !!search.trim()}
              aria-label="Move {item.title} down"
              onclick={() => move(item, 1)}
            >
              <ArrowDownIcon class="size-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Edit {item.title}" onclick={() => openEdit(item)}>
              <PencilIcon class="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Delete {item.title}"
              onclick={() => {
                deleting = item;
                deleteOpen = true;
              }}
            >
              <Trash2Icon class="size-4" />
            </Button>
          </div>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<TaskItemDialog bind:open={dialogOpen} {planId} item={editing} {tree} onsaved={onchanged} />

<ConfirmDeleteDialog
  bind:open={deleteOpen}
  title="Delete this task?"
  description="“{deleting?.title ??
    ''}” is removed from the plan and from every learner who has not started it. Tasks learners have already answered are kept."
  confirmLabel="Delete task"
  busy={deleteBusy}
  onconfirm={confirmDelete}
/>
