<script lang="ts">
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { Textarea } from '@cio/ui/base/textarea';
  import { snackbar } from '$features/ui/snackbar/store';
  import { otjApi, type OtjRow } from '../../api/otj.svelte';

  // Validate or reject one submitted log. A rejection needs a note the learner will see.

  interface Props {
    open: boolean;
    row: OtjRow | null;
    decision: 'VALIDATE' | 'REJECT';
    onDone: () => void;
  }
  let { open = $bindable(), row, decision, onDone }: Props = $props();

  let note = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (open) {
      note = '';
      error = null;
    }
  });

  const needsNote = $derived(decision === 'REJECT');
  const canSave = $derived(!saving && (!needsNote || note.trim().length > 0));

  async function save() {
    if (!row || !canSave) return;
    saving = true;
    error = null;
    const res = await otjApi.review(row.id, {
      decision,
      note: note.trim() || undefined,
      expectedStatus: row.status
    });
    saving = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    snackbar.success(decision === 'VALIDATE' ? 'Log validated' : 'Log rejected');
    open = false;
    onDone();
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>{decision === 'VALIDATE' ? 'Validate log' : 'Reject log'}</Dialog.Title>
      <Dialog.Description>{row?.title ?? ''}</Dialog.Description>
    </Dialog.Header>
    <form
      class="space-y-3"
      onsubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div class="space-y-1">
        <label for="otj-review-note" class="text-sm font-medium">
          Note {needsNote ? '(required)' : '(optional)'}
        </label>
        <Textarea id="otj-review-note" class="min-h-[96px]!" bind:value={note} maxlength={1000} />
      </div>
      {#if error}<p role="alert" class="text-sm text-rose-600">{error}</p>{/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" loading={saving} disabled={!canSave}>
          {decision === 'VALIDATE' ? 'Validate' : 'Reject'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
