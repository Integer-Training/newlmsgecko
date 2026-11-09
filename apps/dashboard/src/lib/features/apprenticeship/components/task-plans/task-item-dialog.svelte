<script lang="ts">
  import { onMount } from 'svelte';
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Textarea } from '@cio/ui/base/textarea';
  import {
    APPR_EVIDENCE_DETAILS_MAX,
    APPR_TASK_MONTH_OFFSET_MAX,
    APPR_TASK_TITLE_MAX
  } from '@cio/utils/constants/apprenticeship';
  import { snackbar } from '$features/ui/snackbar/store';
  import { evidenceApi, type PickerQualification } from '../../api/evidence.svelte';
  import { taskPlansApi, type BriefFile, type TaskPlanItem } from '../../api/task-plans.svelte';
  import CriteriaPicker from '../evidence/criteria-picker.svelte';
  import BriefFiles from './brief-files.svelte';

  // Add / edit one task of a plan. Month offset 0–120: the learner's task is due that many months after their start
  // date. Brief files upload as soon as they are chosen and are attached on save.
  interface Props {
    open: boolean;
    planId: string;
    /** Set when editing. */
    item?: TaskPlanItem | null;
    tree: PickerQualification[];
    onsaved: () => void;
  }

  let { open = $bindable(), planId, item = null, tree, onsaved }: Props = $props();

  let title = $state('');
  let details = $state('');
  let typeKey = $state('');
  let monthOffset = $state('0');
  let hours = $state('0');
  let mins = $state('0');
  let criterionIds = $state<string[]>([]);
  let files = $state<BriefFile[]>([]);
  let filesPlanId = $state<string | undefined>(undefined);
  let saving = $state(false);
  let error = $state<string | null>(null);

  onMount(() => {
    evidenceApi.loadTypes();
  });

  // Seed the form each time the dialog opens.
  $effect(() => {
    if (!open) return;
    title = item?.title ?? '';
    details = item?.details ?? '';
    typeKey = item?.typeKey ?? '';
    monthOffset = String(item?.monthOffset ?? 0);
    hours = String(Math.floor((item?.expectedMinutes ?? 0) / 60));
    mins = String((item?.expectedMinutes ?? 0) % 60);
    criterionIds = item ? item.criteria.map((c) => c.id) : [];
    files = item ? [...item.files] : [];
    filesPlanId = planId;
    error = null;
  });

  const activeTypes = $derived(evidenceApi.types.filter((t) => t.active || t.key === typeKey));
  const offset = $derived(Math.min(APPR_TASK_MONTH_OFFSET_MAX, Math.max(0, Math.floor(Number(monthOffset) || 0))));
  const offsetValid = $derived(
    monthOffset.trim() !== '' &&
      Number.isInteger(Number(monthOffset)) &&
      Number(monthOffset) >= 0 &&
      Number(monthOffset) <= APPR_TASK_MONTH_OFFSET_MAX
  );
  const expectedMinutes = $derived(
    Math.max(0, Math.floor(Number(hours) || 0)) * 60 + Math.max(0, Math.floor(Number(mins) || 0))
  );
  const savedKeys = $derived(new Set(item?.files.map((f) => f.key) ?? []));
  const canSave = $derived(!!title.trim() && !!typeKey && offsetValid && !saving);

  async function save(e: Event) {
    e.preventDefault();
    if (!canSave) return;
    saving = true;
    error = null;
    const body = {
      title: title.trim(),
      details: details.trim(),
      typeKey,
      monthOffset: offset,
      expectedMinutes,
      files,
      criterionIds
    };
    const res = item ? await taskPlansApi.updateItem(planId, item.id, body) : await taskPlansApi.addItem(planId, body);
    saving = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    snackbar.success(item ? 'Task saved' : 'Task added');
    open = false;
    onsaved();
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>{item ? 'Edit task' : 'Add task'}</Dialog.Title>
      <Dialog.Description>
        Learners get a copy of this task when the plan is assigned. Use “Update assigned learners” on the plan to push
        later edits to tasks they have not started.
      </Dialog.Description>
    </Dialog.Header>

    <form onsubmit={save} class="space-y-4">
      <div class="space-y-1">
        <div class="flex items-baseline justify-between">
          <label for="ti-title" class="text-sm font-medium">Title <span class="text-red-500">*</span></label>
          <span class="text-xs text-(--muted-foreground)" aria-live="polite">{title.length}/{APPR_TASK_TITLE_MAX}</span>
        </div>
        <Input id="ti-title" bind:value={title} maxlength={APPR_TASK_TITLE_MAX} required />
      </div>

      <div class="space-y-1">
        <label for="ti-details" class="text-sm font-medium">Details</label>
        <Textarea id="ti-details" class="min-h-[96px]!" bind:value={details} maxlength={APPR_EVIDENCE_DETAILS_MAX} />
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

      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="col-span-2 space-y-1">
          <label for="ti-offset" class="text-sm font-medium">Due after (months)</label>
          <Input
            id="ti-offset"
            type="number"
            min="0"
            max={APPR_TASK_MONTH_OFFSET_MAX}
            step="1"
            bind:value={monthOffset}
            aria-invalid={!offsetValid}
            aria-describedby="ti-offset-hint"
          />
          <p
            id="ti-offset-hint"
            class="text-xs {offsetValid ? 'text-(--muted-foreground)' : 'text-rose-600'}"
            aria-live="polite"
          >
            {#if offsetValid}
              Due = learner start date + {offset} month{offset === 1 ? '' : 's'}
            {:else}
              Enter a whole number from 0 to {APPR_TASK_MONTH_OFFSET_MAX}.
            {/if}
          </p>
        </div>
        <div class="space-y-1">
          <label for="ti-hours" class="text-sm font-medium">Expected (hours)</label>
          <Input id="ti-hours" type="number" min="0" max="1600" bind:value={hours} />
        </div>
        <div class="space-y-1">
          <label for="ti-mins" class="text-sm font-medium">Minutes</label>
          <Input id="ti-mins" type="number" min="0" max="59" bind:value={mins} />
        </div>
      </div>

      <BriefFiles bind:files bind:planId={filesPlanId} {savedKeys} disabled={saving} onerror={(m) => (error = m)} />

      <div class="space-y-1">
        <p class="text-sm font-medium">Criteria</p>
        <CriteriaPicker {tree} bind:selected={criterionIds} idPrefix="task-crit" disabled={saving} />
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
        <Button type="submit" disabled={!canSave} loading={saving}>{item ? 'Save task' : 'Add task'}</Button>
      </Dialog.Footer>
      {#if !canSave && !saving}
        <p class="text-right text-xs text-(--muted-foreground)">A title and an evidence type are required.</p>
      {/if}
    </form>
  </Dialog.Content>
</Dialog.Root>
