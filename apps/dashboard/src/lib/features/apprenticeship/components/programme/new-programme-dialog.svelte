<script lang="ts">
  import { goto } from '$app/navigation';
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Textarea } from '@cio/ui/base/textarea';
  import { currentOrg } from '$lib/utils/store/org';
  import { programmesApi } from '$features/apprenticeship/api/programmes.svelte';

  // Create a programme (also creates its first qualification server-side), then open its setup page.
  interface Props {
    open: boolean;
  }

  let { open = $bindable() }: Props = $props();

  let title = $state('');
  let reference = $state('');
  let level = $state('');
  let description = $state('');
  let saving = $state(false);

  const canSubmit = $derived(!!title.trim() && !saving);

  function reset() {
    title = '';
    reference = '';
    level = '';
    description = '';
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (!canSubmit) return;
    saving = true;
    const created = await programmesApi.create({
      title: title.trim(),
      reference: reference.trim() || null,
      level: level.trim() || null,
      description: description.trim() || null
    });
    saving = false;
    if (!created) return;
    open = false;
    reset();
    goto(`/org/${$currentOrg.siteName}/apprenticeships/programmes/${created.id}`);
  }
</script>

<Dialog.Root bind:open onOpenChange={(next) => !next && reset()}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>New programme</Dialog.Title>
      <Dialog.Description>
        A programme is the qualification learners work towards. You add its units and criteria on the next screen.
      </Dialog.Description>
    </Dialog.Header>

    <form onsubmit={submit} class="flex flex-col gap-3">
      <div class="space-y-1">
        <label for="np-title" class="text-sm font-medium">Title <span class="text-red-500">*</span></label>
        <Input id="np-title" bind:value={title} maxlength={200} placeholder="Level 3 Business Administrator" required />
      </div>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="space-y-1">
          <label for="np-ref" class="text-sm font-medium">Reference</label>
          <Input id="np-ref" bind:value={reference} maxlength={100} placeholder="ST0070" />
        </div>
        <div class="space-y-1">
          <label for="np-level" class="text-sm font-medium">Level</label>
          <Input id="np-level" bind:value={level} maxlength={50} placeholder="3" />
        </div>
      </div>
      <div class="space-y-1">
        <label for="np-desc" class="text-sm font-medium">Description</label>
        <Textarea id="np-desc" bind:value={description} rows={3} maxlength={5000} />
      </div>

      <Dialog.Footer class="mt-2">
        <Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" disabled={!canSubmit} loading={saving}>Create programme</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
