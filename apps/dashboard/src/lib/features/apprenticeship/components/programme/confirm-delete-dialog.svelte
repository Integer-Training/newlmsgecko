<script lang="ts">
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';

  // Generic "are you sure" dialog for deleting part of a programme structure.
  interface Props {
    open: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    busy?: boolean;
    onconfirm: () => void | Promise<void>;
  }

  let { open = $bindable(), title, description, confirmLabel = 'Delete', busy = false, onconfirm }: Props = $props();
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>{description}</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (open = false)} disabled={busy}>Cancel</Button>
      <Button variant="destructive" onclick={onconfirm} loading={busy}>{confirmLabel}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
