<script lang="ts">
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import type { EnrolmentUpdateBody } from '../../api/enrolments.svelte';

  // Edit the enrolment dates and hours. A blank OTJ override means "use the calculated target".

  interface Props {
    open: boolean;
    store: PortfolioStore;
  }
  let { open = $bindable(), store }: Props = $props();

  let start = $state('');
  let end = $state('');
  let hoursWeek = $state('');
  let otjHours = $state('');
  let error = $state<string | null>(null);

  // Load the current values each time the dialog opens.
  $effect(() => {
    if (!open || !store.data) return;
    const e = store.data.enrolment;
    start = e.startDate ?? '';
    end = e.plannedEndDate ?? '';
    hoursWeek = e.contractedHoursWeek === null ? '' : String(e.contractedHoursWeek);
    otjHours =
      e.otjTargetMinutesOverride === null ? '' : String(Math.round((e.otjTargetMinutesOverride / 60) * 100) / 100);
    error = null;
  });

  const valid = $derived(!!start && !!end && end >= start);

  async function save() {
    if (!store.data || !valid) return;
    const e = store.data.enrolment;
    const body: EnrolmentUpdateBody = {};
    if (start !== (e.startDate ?? '')) body.startDate = start;
    if (end !== (e.plannedEndDate ?? '')) body.plannedEndDate = end;
    const hw = String(hoursWeek ?? '').trim() === '' ? null : Number(hoursWeek);
    if (hw !== e.contractedHoursWeek) body.contractedHoursWeek = hw;
    const otj = String(otjHours ?? '').trim() === '' ? null : Math.round(Number(otjHours) * 60);
    if (otj !== e.otjTargetMinutesOverride) body.otjTargetMinutesOverride = otj;
    if (Object.keys(body).length === 0) {
      open = false;
      return;
    }
    error = null;
    if (await store.patchEnrolment(body)) open = false;
    else error = 'Could not save. Check the dates and hours and try again.';
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Edit dates &amp; hours</Dialog.Title>
      <Dialog.Description>Changing these updates the expected position and off-the-job target.</Dialog.Description>
    </Dialog.Header>

    <form
      class="space-y-3"
      onsubmit={(ev) => {
        ev.preventDefault();
        save();
      }}
    >
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="space-y-1">
          <label for="ed-start" class="text-sm font-medium">Start date</label>
          <Input id="ed-start" type="date" bind:value={start} required />
        </div>
        <div class="space-y-1">
          <label for="ed-end" class="text-sm font-medium">Planned end date</label>
          <Input id="ed-end" type="date" bind:value={end} min={start || undefined} required />
        </div>
      </div>
      <div class="space-y-1">
        <label for="ed-hours" class="text-sm font-medium">Contracted hours per week</label>
        <Input id="ed-hours" type="number" min="0.5" max="168" step="0.5" bind:value={hoursWeek} />
      </div>
      <div class="space-y-1">
        <label for="ed-otj" class="text-sm font-medium">Off-the-job target override (hours)</label>
        <Input
          id="ed-otj"
          type="number"
          min="0"
          step="0.5"
          bind:value={otjHours}
          placeholder="Calculated from contract"
        />
        <p class="text-muted-foreground text-xs">Leave blank to calculate the target from the contracted hours.</p>
      </div>
      {#if error}<p role="alert" class="text-sm text-rose-600">{error}</p>{/if}
      <Dialog.Footer class="mt-4">
        <Button type="button" variant="outline" onclick={() => (open = false)} disabled={store.saving}>Cancel</Button>
        <Button type="submit" loading={store.saving} disabled={!valid || store.saving}>Save</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
