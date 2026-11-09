<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Textarea } from '@cio/ui/base/textarea';
  import FileIcon from '@lucide/svelte/icons/file';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import XIcon from '@lucide/svelte/icons/x';
  import { APPR_EVIDENCE_DETAILS_MAX, APPR_TASK_TITLE_MAX } from '@cio/utils/constants/apprenticeship';
  import { snackbar } from '$features/ui/snackbar/store';
  import { evidenceApi } from '../../api/evidence.svelte';
  import { tasksApi, type TaskFile, type TaskItem } from '../../api/tasks.svelte';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import CriteriaPicker from '../evidence/criteria-picker.svelte';
  import { fmtBytes } from '../shared/format';

  // Staff: add an individual task for this learner, or edit a task (plan-derived or individual): title, details, type,
  // due date, expected time, brief files and criteria. Evidence already linked to a task is never touched.

  interface Props {
    open: boolean;
    store: PortfolioStore;
    /** null = new individual task. */
    task?: TaskItem | null;
  }
  let { open = $bindable(), store, task = null }: Props = $props();

  let title = $state('');
  let details = $state('');
  let typeKey = $state('');
  let dueDate = $state('');
  let hours = $state('0');
  let mins = $state('0');
  let criterionIds = $state<string[]>([]);
  let files = $state<TaskFile[]>([]);
  let uploadTaskId = $state<string | undefined>(undefined);
  let saving = $state(false);
  let uploading = $state(false);
  let error = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let nonce = $state(0);

  onMount(() => {
    evidenceApi.loadTypes();
  });

  // Fresh values each time the dialog opens.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      title = task?.title ?? '';
      details = task?.details ?? '';
      typeKey = task?.typeKey ?? '';
      dueDate = task?.dueDate ?? '';
      hours = String(Math.floor((task?.expectedMinutes ?? 0) / 60));
      mins = String((task?.expectedMinutes ?? 0) % 60);
      criterionIds = task ? task.criteria.map((c) => c.id) : [];
      files = task ? task.files.map((f) => ({ key: f.key, name: f.name, size: f.size, type: f.type })) : [];
      uploadTaskId = task?.id;
      error = null;
      nonce += 1;
    });
  });

  const activeTypes = $derived(evidenceApi.types.filter((t) => t.active || t.key === typeKey));
  const expectedMinutes = $derived(
    Math.max(0, Math.floor(Number(hours) || 0)) * 60 + Math.max(0, Math.floor(Number(mins) || 0))
  );
  const canSave = $derived(!!title.trim() && !!typeKey && !saving && !uploading);

  async function onFilesPicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const picked = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (picked.length === 0) return;
    uploading = true;
    error = null;
    const res = await tasksApi.upload(store.enrolmentId, picked, uploadTaskId);
    uploading = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    uploadTaskId = res.data.taskId;
    files = [...files, ...res.data.files];
  }

  async function save() {
    if (!canSave) return;
    saving = true;
    error = null;
    const body = {
      title: title.trim(),
      details: details.trim(),
      typeKey,
      dueDate: dueDate || null,
      expectedMinutes,
      files: files.map((f) => ({ key: f.key, name: f.name, size: f.size, type: f.type })),
      criterionIds
    };
    const res = task
      ? await tasksApi.update(task.id, body)
      : await tasksApi.create(store.enrolmentId, { ...body, ...(uploadTaskId ? { id: uploadTaskId } : {}) });
    saving = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    snackbar.success(task ? 'Task updated' : 'Task added');
    open = false;
    await store.refresh();
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>{task ? 'Edit task' : 'New individual task'}</Dialog.Title>
      <Dialog.Description>
        {task
          ? 'Changes apply to this learner only. Evidence already linked to the task stays linked.'
          : `A task for ${store.data?.learner.name ?? 'this learner'} only, outside any task plan.`}
      </Dialog.Description>
    </Dialog.Header>

    <form
      class="space-y-4"
      onsubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div class="space-y-1">
        <div class="flex items-baseline justify-between">
          <label for="task-title" class="text-sm font-medium">Title <span class="text-red-500">*</span></label>
          <span class="text-xs text-(--muted-foreground)" aria-live="polite">{title.length}/{APPR_TASK_TITLE_MAX}</span>
        </div>
        <Input id="task-title" bind:value={title} maxlength={APPR_TASK_TITLE_MAX} required />
      </div>

      <div class="space-y-1">
        <label for="task-details" class="text-sm font-medium">Details</label>
        <Textarea id="task-details" class="min-h-[96px]!" bind:value={details} maxlength={APPR_EVIDENCE_DETAILS_MAX} />
      </div>

      <fieldset class="space-y-2">
        <legend class="text-sm font-medium">Evidence type <span class="text-red-500">*</span></legend>
        <div class="flex flex-wrap gap-1.5">
          {#each activeTypes as t (t.key)}
            <button
              type="button"
              aria-pressed={typeKey === t.key}
              class="rounded-full border px-2.5 py-1 text-xs transition-colors {typeKey === t.key
                ? 'border-(--primary) bg-(--primary) text-(--primary-foreground)'
                : 'hover:bg-(--muted)'}"
              onclick={() => (typeKey = t.key)}
            >
              {t.label}
            </button>
          {/each}
          {#if activeTypes.length === 0}
            <p class="text-sm text-(--muted-foreground)">Loading types…</p>
          {/if}
        </div>
      </fieldset>

      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div class="col-span-2 space-y-1 sm:col-span-1">
          <label for="task-due" class="text-sm font-medium">Due date</label>
          <Input id="task-due" type="date" bind:value={dueDate} />
        </div>
        <div class="space-y-1">
          <label for="task-hours" class="text-sm font-medium">Expected (hours)</label>
          <Input id="task-hours" type="number" min="0" max="1600" bind:value={hours} />
        </div>
        <div class="space-y-1">
          <label for="task-mins" class="text-sm font-medium">Minutes</label>
          <Input id="task-mins" type="number" min="0" max="59" bind:value={mins} />
        </div>
      </div>

      <div class="space-y-2">
        <p class="text-sm font-medium">Brief files</p>
        <input
          bind:this={fileInput}
          type="file"
          multiple
          class="hidden"
          aria-label="Choose brief files"
          onchange={onFilesPicked}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={uploading}
          disabled={uploading || saving}
          onclick={() => fileInput?.click()}
        >
          <UploadIcon size={16} class="mr-1" /> Add files
        </Button>
        {#if files.length > 0}
          <ul class="space-y-1">
            {#each files as f (f.key)}
              <li class="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm">
                <span class="inline-flex min-w-0 items-center gap-1.5">
                  <FileIcon size={14} class="shrink-0" />
                  <span class="truncate">{f.name}</span>
                  <span class="shrink-0 text-xs text-(--muted-foreground)">{fmtBytes(f.size)}</span>
                </span>
                <button
                  type="button"
                  class="text-(--muted-foreground) hover:text-(--foreground)"
                  aria-label="Remove {f.name}"
                  onclick={() => (files = files.filter((x) => x.key !== f.key))}
                >
                  <XIcon size={14} />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div class="space-y-1">
        <p class="text-sm font-medium">Criteria the evidence should cover</p>
        {#key nonce}
          <CriteriaPicker tree={store.pickerTree} bind:selected={criterionIds} idPrefix="task-crit" />
        {/key}
      </div>

      {#if error}
        <p
          role="alert"
          class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
        >
          {error}
        </p>
      {/if}

      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (open = false)} disabled={saving}>Cancel</Button>
        <Button type="submit" loading={saving} disabled={!canSave}>{task ? 'Save changes' : 'Add task'}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
