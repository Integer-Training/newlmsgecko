<script lang="ts">
  import { goto } from '$app/navigation';
  import * as Dialog from '@cio/ui/base/dialog';
  import * as Select from '@cio/ui/base/select';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { APPR_TASK_TITLE_MAX } from '@cio/utils/constants/apprenticeship';
  import { currentOrg } from '$lib/utils/store/org';
  import { snackbar } from '$features/ui/snackbar/store';
  import { taskPlansApi, type BriefFile } from '../../api/task-plans.svelte';
  import BriefFiles from './brief-files.svelte';

  // Create a task plan (programme, title, optional valid window and brief files), then open it to add its tasks.
  interface Props {
    open: boolean;
    programmes: { id: string; title: string }[];
    /** Pre-selected programme (the list's current filter). */
    defaultProgrammeId?: string;
  }

  let { open = $bindable(), programmes, defaultProgrammeId = '' }: Props = $props();

  let programmeId = $state('');
  let title = $state('');
  let validFrom = $state('');
  let validTo = $state('');
  let files = $state<BriefFile[]>([]);
  let planId = $state<string | undefined>(undefined);
  let saving = $state(false);
  let error = $state<string | null>(null);

  const programmeTitle = $derived(programmes.find((p) => p.id === programmeId)?.title ?? 'Choose a programme');
  const badWindow = $derived(!!validFrom && !!validTo && validTo < validFrom);
  const canSubmit = $derived(!!programmeId && !!title.trim() && !badWindow && !saving);

  $effect(() => {
    if (open && !programmeId) programmeId = defaultProgrammeId;
  });

  function reset() {
    programmeId = '';
    title = '';
    validFrom = '';
    validTo = '';
    files = [];
    planId = undefined;
    error = null;
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (!canSubmit) return;
    saving = true;
    error = null;
    const res = await taskPlansApi.create({
      ...(planId && files.length > 0 ? { id: planId } : {}),
      programmeId,
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
    snackbar.success('Task plan created');
    open = false;
    reset();
    goto(`/org/${$currentOrg.siteName}/apprenticeships/task-plans/${res.data.id}`);
  }
</script>

<Dialog.Root bind:open onOpenChange={(next) => !next && reset()}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>New task plan</Dialog.Title>
      <Dialog.Description>
        A reusable set of tasks for one programme. You add the tasks on the next screen, then assign the plan to
        learners.
      </Dialog.Description>
    </Dialog.Header>

    <form onsubmit={submit} class="flex flex-col gap-3">
      <div class="space-y-1">
        <label for="ntp-programme" class="text-sm font-medium">Programme <span class="text-red-500">*</span></label>
        <Select.Root type="single" bind:value={programmeId}>
          <Select.Trigger id="ntp-programme" class="w-full"><p class="truncate">{programmeTitle}</p></Select.Trigger>
          <Select.Content>
            {#each programmes as p (p.id)}
              <Select.Item value={p.id}>{p.title}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>

      <div class="space-y-1">
        <div class="flex items-baseline justify-between">
          <label for="ntp-title" class="text-sm font-medium">Title <span class="text-red-500">*</span></label>
          <span class="text-xs text-(--muted-foreground)" aria-live="polite">{title.length}/{APPR_TASK_TITLE_MAX}</span>
        </div>
        <Input id="ntp-title" bind:value={title} maxlength={APPR_TASK_TITLE_MAX} required />
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="space-y-1">
          <label for="ntp-from" class="text-sm font-medium">Valid from</label>
          <Input id="ntp-from" type="date" bind:value={validFrom} />
        </div>
        <div class="space-y-1">
          <label for="ntp-to" class="text-sm font-medium">Valid to</label>
          <Input id="ntp-to" type="date" bind:value={validTo} aria-invalid={badWindow} />
        </div>
      </div>
      {#if badWindow}
        <p class="text-xs text-rose-600">Valid to must be on or after valid from.</p>
      {:else}
        <p class="text-xs text-(--muted-foreground)">
          The plan can only be assigned to learners between these dates. Leave blank for no limit.
        </p>
      {/if}

      <BriefFiles bind:files bind:planId saved={false} disabled={saving} onerror={(m) => (error = m)} />

      {#if error}
        <p
          role="alert"
          class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
        >
          {error}
        </p>
      {/if}

      <Dialog.Footer class="mt-2">
        <Button type="button" variant="outline" onclick={() => (open = false)} disabled={saving}>Cancel</Button>
        <Button type="submit" disabled={!canSubmit} loading={saving}>Create task plan</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
