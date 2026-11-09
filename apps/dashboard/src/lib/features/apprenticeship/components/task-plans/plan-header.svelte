<script lang="ts">
  import { goto } from '$app/navigation';
  import * as Dialog from '@cio/ui/base/dialog';
  import { Badge } from '@cio/ui/base/badge';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import ArchiveIcon from '@lucide/svelte/icons/archive';
  import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import { APPR_TASK_TITLE_MAX } from '@cio/utils/constants/apprenticeship';
  import { currentOrg } from '$lib/utils/store/org';
  import { snackbar } from '$features/ui/snackbar/store';
  import { taskPlansApi, type BriefFile, type TaskPlan } from '../../api/task-plans.svelte';
  import BriefFiles from './brief-files.svelte';

  // Plan details, edited in place: title / valid window / brief files save together; archive toggles status; delete
  // is refused by the API once learners have answered tasks from the plan (its message is shown in the dialog).
  interface Props {
    plan: TaskPlan;
    programmeTitle: string;
    onsaved: (plan: TaskPlan) => void;
  }

  let { plan, programmeTitle, onsaved }: Props = $props();

  let title = $state('');
  let validFrom = $state('');
  let validTo = $state('');
  let files = $state<BriefFile[]>([]);
  let planId = $state<string | undefined>(undefined);
  let saving = $state(false);
  let toggling = $state(false);
  let error = $state<string | null>(null);
  let deleteOpen = $state(false);
  let deleting = $state(false);
  let deleteError = $state<string | null>(null);

  // Re-seed only when the saved plan actually changes, so unsaved typing is never wiped.
  let seeded = '';
  $effect(() => {
    const key = JSON.stringify([plan.id, plan.title, plan.validFrom, plan.validTo, plan.files.map((f) => f.key)]);
    if (key === seeded) return;
    seeded = key;
    title = plan.title;
    validFrom = plan.validFrom ?? '';
    validTo = plan.validTo ?? '';
    files = [...plan.files];
    planId = plan.id;
  });

  const savedKeys = $derived(new Set(plan.files.map((f) => f.key)));
  const badWindow = $derived(!!validFrom && !!validTo && validTo < validFrom);
  const dirty = $derived(
    title.trim() !== plan.title ||
      validFrom !== (plan.validFrom ?? '') ||
      validTo !== (plan.validTo ?? '') ||
      JSON.stringify(files.map((f) => f.key)) !== JSON.stringify(plan.files.map((f) => f.key))
  );
  const canSave = $derived(dirty && !!title.trim() && !badWindow && !saving);

  async function save(e: Event) {
    e.preventDefault();
    if (!canSave) return;
    saving = true;
    error = null;
    const res = await taskPlansApi.update(plan.id, {
      title: title.trim(),
      validFrom: validFrom || null,
      validTo: validTo || null,
      files
    });
    saving = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    snackbar.success('Task plan saved');
    onsaved(res.data);
  }

  async function toggleArchive() {
    toggling = true;
    const res = await taskPlansApi.setArchived(plan.id, plan.status === 'ACTIVE');
    toggling = false;
    if (!res.ok) {
      snackbar.error(res.error);
      return;
    }
    onsaved(res.data);
  }

  async function confirmDelete() {
    deleting = true;
    deleteError = null;
    const res = await taskPlansApi.remove(plan.id);
    deleting = false;
    if (!res.ok) {
      deleteError = res.error;
      return;
    }
    snackbar.success('Task plan deleted');
    deleteOpen = false;
    goto(`/org/${$currentOrg.siteName}/apprenticeships/task-plans`);
  }
</script>

<form onsubmit={save} class="flex flex-col gap-3 rounded-xl border bg-(--card) p-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div class="flex items-center gap-2">
      <h2 class="text-lg font-semibold tracking-tight">Task plan details</h2>
      <Badge variant={plan.status === 'ACTIVE' ? 'success' : 'secondary'}>
        {plan.status === 'ACTIVE' ? 'Active' : 'Archived'}
      </Badge>
    </div>
    <div class="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" onclick={toggleArchive} loading={toggling}>
        {#if plan.status === 'ACTIVE'}
          <ArchiveIcon class="size-4" /> Archive
        {:else}
          <ArchiveRestoreIcon class="size-4" /> Restore
        {/if}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onclick={() => {
          deleteError = null;
          deleteOpen = true;
        }}
      >
        <Trash2Icon class="size-4" /> Delete
      </Button>
    </div>
  </div>

  <p class="text-sm text-(--muted-foreground)">Programme: <span class="text-(--foreground)">{programmeTitle}</span></p>

  <div class="grid grid-cols-1 gap-3 md:grid-cols-[1fr_11rem_11rem]">
    <div class="space-y-1">
      <div class="flex items-baseline justify-between">
        <label for="tp-title" class="text-sm font-medium">Title <span class="text-red-500">*</span></label>
        <span class="text-xs text-(--muted-foreground)" aria-live="polite">{title.length}/{APPR_TASK_TITLE_MAX}</span>
      </div>
      <Input id="tp-title" bind:value={title} maxlength={APPR_TASK_TITLE_MAX} required />
    </div>
    <div class="space-y-1">
      <label for="tp-from" class="text-sm font-medium">Valid from</label>
      <Input id="tp-from" type="date" bind:value={validFrom} />
    </div>
    <div class="space-y-1">
      <label for="tp-to" class="text-sm font-medium">Valid to</label>
      <Input id="tp-to" type="date" bind:value={validTo} aria-invalid={badWindow} />
    </div>
  </div>
  {#if badWindow}
    <p class="text-xs text-rose-600">Valid to must be on or after valid from.</p>
  {/if}

  <BriefFiles bind:files bind:planId {savedKeys} disabled={saving} onerror={(m) => (error = m)} />

  {#if error}
    <p
      role="alert"
      class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
    >
      {error}
    </p>
  {/if}
  <div>
    <Button type="submit" disabled={!canSave} loading={saving}>Save details</Button>
  </div>
</form>

<Dialog.Root bind:open={deleteOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Delete this task plan?</Dialog.Title>
      <Dialog.Description>
        “{plan.title}” and its tasks will be deleted, and any tasks learners have not started from it are removed from
        them. If learners have already answered tasks from it, it cannot be deleted. Archive it instead.
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
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (deleteOpen = false)} disabled={deleting}>Cancel</Button>
      <Button variant="destructive" onclick={confirmDelete} loading={deleting}>Delete task plan</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
