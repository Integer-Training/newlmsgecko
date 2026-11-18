<script lang="ts">
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import { Textarea } from '@cio/ui/base/textarea';
  import { snackbar } from '$features/ui/snackbar/store';
  import { otjApi, type OtjRow } from '../../api/otj.svelte';

  // Add or edit one off-the-job log. Staff adding a log may record it as already validated.

  const TITLE_MAX = 120;

  interface Props {
    open: boolean;
    enrolmentId: string;
    /** The row being edited; null = a new log. */
    row: OtjRow | null;
    isStaff: boolean;
    onDone: () => void;
  }
  let { open = $bindable(), enrolmentId, row, isStaff, onDone }: Props = $props();

  const today = () => new Date().toLocaleDateString('en-CA');

  let title = $state('');
  let logDate = $state(today());
  let hours = $state('0');
  let mins = $state('0');
  let isOtj = $state(true);
  let details = $state('');
  let validated = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (!open) return;
    title = row?.title ?? '';
    logDate = row?.date ? row.date.slice(0, 10) : today();
    const m = row?.minutes ?? 0;
    hours = String(Math.floor(m / 60));
    mins = String(m % 60);
    isOtj = row?.isOtj ?? true;
    details = row?.details ?? '';
    validated = false;
    error = null;
  });

  const minutes = $derived(
    Math.max(0, Math.floor(Number(hours) || 0)) * 60 + Math.max(0, Math.floor(Number(mins) || 0))
  );
  const canSave = $derived(!saving && title.trim().length > 0 && !!logDate && logDate <= today() && minutes >= 1);

  async function save() {
    if (!canSave) return;
    saving = true;
    error = null;
    const body = {
      title: title.trim(),
      details: details.trim(),
      logDate,
      minutes,
      isOtj
    };
    const res = row
      ? await otjApi.update(row.id, body)
      : await otjApi.add(enrolmentId, { ...body, ...(isStaff && validated ? { status: 'VALIDATED' as const } : {}) });
    saving = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    snackbar.success(row ? 'Log saved' : 'Log added');
    open = false;
    onDone();
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{row ? 'Edit log' : 'Add log'}</Dialog.Title>
      <Dialog.Description>
        Only validated time counts towards the off-the-job target.
        {#if row?.status === 'REJECTED'}Saving a rejected log sends it back for validation.{/if}
      </Dialog.Description>
    </Dialog.Header>
    <form
      class="space-y-3"
      onsubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div class="space-y-1">
        <label for="otj-title" class="text-sm font-medium">Title</label>
        <Input id="otj-title" bind:value={title} maxlength={TITLE_MAX} required />
      </div>
      <div class="flex flex-wrap items-end gap-3">
        <div class="space-y-1">
          <label for="otj-date" class="text-sm font-medium">Date</label>
          <Input id="otj-date" class="w-40" type="date" max={today()} bind:value={logDate} required />
        </div>
        <div class="space-y-1">
          <label for="otj-hours" class="text-sm font-medium">Hours</label>
          <Input id="otj-hours" class="w-20" type="number" min="0" bind:value={hours} />
        </div>
        <div class="space-y-1">
          <label for="otj-mins" class="text-sm font-medium">Minutes</label>
          <Input id="otj-mins" class="w-20" type="number" min="0" max="59" bind:value={mins} />
        </div>
      </div>
      <label class="flex items-center gap-2 text-sm">
        <Checkbox bind:checked={isOtj} />
        Counts as off-the-job
      </label>
      {#if isStaff && !row}
        <label class="flex items-center gap-2 text-sm">
          <Checkbox bind:checked={validated} />
          Record as already validated
        </label>
      {/if}
      <div class="space-y-1">
        <label for="otj-details" class="text-sm font-medium">Details (optional)</label>
        <Textarea id="otj-details" class="min-h-[80px]!" bind:value={details} maxlength={2000} />
      </div>
      {#if error}<p role="alert" class="text-sm text-rose-600">{error}</p>{/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" loading={saving} disabled={!canSave}>{row ? 'Save' : 'Add log'}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
