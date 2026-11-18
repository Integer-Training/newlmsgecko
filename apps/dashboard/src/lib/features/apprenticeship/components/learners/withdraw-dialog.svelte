<script lang="ts">
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { Textarea } from '@cio/ui/base/textarea';
  import { snackbar } from '$features/ui/snackbar/store';
  import { enrolmentsApi, type WithdrawScope } from '../../api/enrolments.svelte';

  // Withdraw (admin only): a reason is required. For a linked Diploma + Standard pair the admin chooses whether to
  // withdraw only this qualification (the apprenticeship carries on) or both (the apprenticeship is closed, read-only).
  // An unlinked enrolment has nothing to choose: withdrawing it closes the apprenticeship.
  interface Props {
    open: boolean;
    /** The qualification being withdrawn. */
    enrolmentId: string;
    title: string;
    /** The paired qualification's title when this one is part of a linked pair, otherwise null. */
    pairedTitle?: string | null;
    onDone: () => void;
  }
  let { open = $bindable(), enrolmentId, title, pairedTitle = null, onDone }: Props = $props();

  let reason = $state('');
  let scope = $state<WithdrawScope>('THIS');
  let saving = $state(false);
  let touched = $state(false);

  $effect(() => {
    if (open) {
      reason = '';
      scope = 'THIS';
      touched = false;
    }
  });

  const trimmed = $derived(reason.trim());
  const reasonError = $derived(
    touched && trimmed.length === 0
      ? 'Enter a reason.'
      : trimmed.length > 2000
        ? 'Keep the reason under 2000 characters.'
        : ''
  );

  async function confirm() {
    touched = true;
    if (trimmed.length === 0 || trimmed.length > 2000) return;
    saving = true;
    const res = await enrolmentsApi.withdraw(enrolmentId, { reason: trimmed, scope: pairedTitle ? scope : 'BOTH' });
    saving = false;
    if (!res.ok) {
      snackbar.error(res.error);
      return;
    }
    snackbar.success('Withdrawn.');
    open = false;
    onDone();
  }

  const radio = 'flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm hover:bg-(--muted)/50';
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Withdraw {title}</Dialog.Title>
      <Dialog.Description>
        Progress is frozen and it is excluded from the learner's overall figures. You can reinstate it later.
      </Dialog.Description>
    </Dialog.Header>

    {#if pairedTitle}
      <fieldset class="space-y-2">
        <legend class="mb-1 text-sm font-medium">What to withdraw</legend>
        <label class={radio}>
          <input type="radio" class="mt-1" name="withdraw-scope" value="THIS" bind:group={scope} />
          <span>
            <strong>Only {title}</strong><br />
            <span class="text-xs text-(--muted-foreground)"
              >Its units are frozen. {pairedTitle} stays active and the apprenticeship carries on.</span
            >
          </span>
        </label>
        <label class={radio}>
          <input type="radio" class="mt-1" name="withdraw-scope" value="BOTH" bind:group={scope} />
          <span>
            <strong>Both qualifications</strong><br />
            <span class="text-xs text-(--muted-foreground)"
              >{title} and {pairedTitle} are withdrawn. The apprenticeship is closed: it leaves the default lists and is
              read-only for everyone. The learner can still see it.</span
            >
          </span>
        </label>
      </fieldset>
    {:else}
      <p class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
        This closes the apprenticeship. It leaves the default lists and becomes read-only for everyone. The learner can
        still see it.
      </p>
    {/if}

    <div class="space-y-1">
      <label for="withdraw-reason" class="text-sm font-medium">Reason (required)</label>
      <Textarea
        id="withdraw-reason"
        rows={3}
        maxlength={2000}
        bind:value={reason}
        aria-invalid={reasonError ? 'true' : undefined}
        aria-describedby={reasonError ? 'withdraw-reason-err' : undefined}
      />
      {#if reasonError}<p id="withdraw-reason-err" role="alert" class="text-xs text-rose-600">{reasonError}</p>{/if}
    </div>

    <Dialog.Footer class="mt-4">
      <Button variant="outline" onclick={() => (open = false)} disabled={saving}>Cancel</Button>
      <Button variant="destructive" onclick={confirm} loading={saving} disabled={saving}>Withdraw</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
