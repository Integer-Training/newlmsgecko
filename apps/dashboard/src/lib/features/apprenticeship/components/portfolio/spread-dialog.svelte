<script lang="ts">
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import { fmtDate } from '../shared/format';

  // Confirm spreading the enrolment window across the units (weighted by criteria count, in programme order).

  interface Props {
    open: boolean;
    store: PortfolioStore;
  }
  let { open = $bindable(), store }: Props = $props();

  let onlyEmpty = $state(false);

  $effect(() => {
    if (open) onlyEmpty = false;
  });

  async function confirm() {
    if (await store.spread(onlyEmpty)) open = false;
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Spread unit dates</Dialog.Title>
      <Dialog.Description>
        Share {fmtDate(store.data?.enrolment.startDate)} to {fmtDate(store.data?.enrolment.plannedEndDate)} across the units,
        in order, giving bigger units more time.
      </Dialog.Description>
    </Dialog.Header>
    <label class="flex items-start gap-2 text-sm">
      <Checkbox class="mt-0.5" bind:checked={onlyEmpty} />
      <span
        >Only units without dates<br /><span class="text-xs text-(--muted-foreground)"
          >Units that already have dates are left alone.</span
        ></span
      >
    </label>
    {#if !onlyEmpty}
      <p class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
        This replaces every unit's start and target date.
      </p>
    {/if}
    <Dialog.Footer class="mt-4">
      <Button variant="outline" onclick={() => (open = false)} disabled={store.saving}>Cancel</Button>
      <Button onclick={confirm} loading={store.saving} disabled={store.saving}>Spread dates</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
