<script lang="ts">
  import * as Sheet from '@cio/ui/base/sheet';
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import FileIcon from '@lucide/svelte/icons/file';
  import { isOrgTeamMember } from '$lib/utils/store/org';
  import { snackbar } from '$features/ui/snackbar/store';
  import { evidenceApi } from '../../api/evidence.svelte';
  import { tasksApi, type TaskItem } from '../../api/tasks.svelte';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import EvidenceStatusChip from '../shared/evidence-status-chip.svelte';
  import TaskStatusChip from '../shared/task-status-chip.svelte';
  import { fmtBytes, fmtDate, fmtMinutes } from '../shared/format';

  // One task in a side sheet: details, brief files, criteria and the evidence linked to it. The learner answers it
  // (evidence sheet pre-filled); staff can also add evidence for it, edit it or delete it (evidence stays).

  interface Props {
    open: boolean;
    task: TaskItem | null;
    store: PortfolioStore;
    onEdit: (t: TaskItem) => void;
  }
  let { open = $bindable(), task, store, onEdit }: Props = $props();

  const isStaff = $derived($isOrgTeamMember === true);
  let confirmOpen = $state(false);
  let deleting = $state(false);
  let deleteError = $state<string | null>(null);

  const typeLabel = $derived(
    task ? (evidenceApi.types.find((t) => t.key === task.typeKey)?.label ?? task.typeKey) : ''
  );
  // criterion id → "code — text" from the portfolio structure (the task only carries ids + codes).
  const criterionText = $derived(
    new Map(store.pickerTree.flatMap((q) => q.units.flatMap((u) => u.criteria.map((c) => [c.id, c.text] as const))))
  );

  function answer() {
    if (!task) return;
    open = false;
    store.openAnswerTask(task);
  }

  function openEvidence(id: string) {
    open = false;
    store.openEvidence(id);
  }

  async function remove() {
    if (!task) return;
    deleting = true;
    deleteError = null;
    const res = await tasksApi.remove(task.id);
    deleting = false;
    if (!res.ok) {
      deleteError = res.error;
      return;
    }
    confirmOpen = false;
    open = false;
    snackbar.success(res.data.detachedEvidence > 0 ? 'Task deleted — its evidence was kept' : 'Task deleted');
    await store.refresh();
  }
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="right" class="ui:w-full ui:overflow-y-auto sm:max-w-xl!">
    {#if task}
      <Sheet.Header>
        <Sheet.Title>{task.title}</Sheet.Title>
        <Sheet.Description>
          {task.fromPlan ? (task.planTitle ?? 'Task plan') : 'Individual task'} · {typeLabel}
        </Sheet.Description>
      </Sheet.Header>

      <div class="space-y-5 px-4 pb-6">
        <div class="flex flex-wrap items-center gap-3">
          <TaskStatusChip status={task.status} overdue={task.overdue} />
          <span class="text-sm">
            {#if task.dueDate}
              Due {fmtDate(task.dueDate)}
            {:else if isStaff}
              <span class="text-(--muted-foreground)">No due date — learner start date not set</span>
            {:else}
              <span class="text-(--muted-foreground)">No due date yet</span>
            {/if}
          </span>
          {#if task.expectedMinutes > 0}
            <span class="text-sm text-(--muted-foreground)">Expected time {fmtMinutes(task.expectedMinutes)}</span>
          {/if}
        </div>

        {#if task.details}
          <section aria-label="Task details">
            <h3 class="mb-1 text-sm font-semibold">Details</h3>
            <p class="text-sm whitespace-pre-wrap">{task.details}</p>
          </section>
        {/if}

        {#if task.files.length > 0}
          <section aria-label="Brief files">
            <h3 class="mb-1 text-sm font-semibold">Brief</h3>
            <ul class="space-y-1">
              {#each task.files as f (f.key)}
                <li>
                  <button
                    type="button"
                    class="flex w-full items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-left text-sm hover:bg-(--muted)"
                    onclick={() => tasksApi.openFile(task.id, f.key)}
                  >
                    <FileIcon size={14} class="shrink-0" />
                    <span class="truncate">{f.name}</span>
                    <span class="shrink-0 text-xs text-(--muted-foreground)">{fmtBytes(f.size)}</span>
                  </button>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <section aria-label="Criteria">
          <h3 class="mb-1 text-sm font-semibold">Criteria</h3>
          {#if task.criteria.length === 0}
            <p class="text-sm text-(--muted-foreground)">No criteria are linked to this task.</p>
          {:else}
            <ul class="space-y-1 text-sm">
              {#each task.criteria as c (c.id)}
                <li>
                  <span class="font-medium">{c.code}</span>
                  {#if criterionText.get(c.id)}<span class="text-(--muted-foreground)">
                      — {criterionText.get(c.id)}</span
                    >{/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <section aria-label="Linked evidence">
          <h3 class="mb-1 text-sm font-semibold">Evidence for this task</h3>
          {#if task.evidence.length === 0}
            <p class="text-sm text-(--muted-foreground)">Nothing has been added for this task yet.</p>
          {:else}
            <ul class="space-y-1">
              {#each task.evidence as e (e.id)}
                <li>
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm hover:bg-(--muted)"
                    onclick={() => openEvidence(e.id)}
                  >
                    <span class="truncate">{e.title}</span>
                    <EvidenceStatusChip status={e.status} />
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <div class="flex flex-wrap justify-between gap-2 border-t pt-4">
          <div class="flex flex-wrap gap-2">
            {#if task.status !== 'COMPLETE'}
              <Button onclick={answer}>{isStaff ? 'Add evidence for this task' : 'Answer task'}</Button>
            {/if}
          </div>
          {#if isStaff}
            <div class="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onclick={() => {
                  open = false;
                  onEdit(task);
                }}>Edit</Button
              >
              <Button
                variant="outline"
                class="text-rose-600"
                onclick={() => {
                  deleteError = null;
                  confirmOpen = true;
                }}>Delete</Button
              >
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </Sheet.Content>
</Sheet.Root>

<Dialog.Root bind:open={confirmOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Delete this task?</Dialog.Title>
      <Dialog.Description>
        “{task?.title}” will be removed for this learner. Any evidence they added for it is kept — it just stops being
        linked to a task.
      </Dialog.Description>
    </Dialog.Header>
    {#if deleteError}
      <p
        role="alert"
        class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
      >
        {deleteError}
      </p>
    {/if}
    <Dialog.Footer class="mt-4">
      <Button variant="outline" onclick={() => (confirmOpen = false)} disabled={deleting}>Cancel</Button>
      <Button variant="destructive" onclick={remove} loading={deleting} disabled={deleting}>Delete task</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
