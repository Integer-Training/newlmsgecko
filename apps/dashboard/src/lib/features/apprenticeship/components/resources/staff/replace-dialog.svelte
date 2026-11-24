<script lang="ts">
  import { untrack } from 'svelte';
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import FileIcon from '@lucide/svelte/icons/file';
  import XIcon from '@lucide/svelte/icons/x';
  import { snackbar } from '$features/ui/snackbar/store';
  import { resourcesAdminApi, type ResourceItem } from '../../../api/resources-admin.svelte';
  import { fmtBytes } from '../../shared/format';
  import FileDrop from './file-drop.svelte';

  // Replace a resource's file: presign (with the resource id) → PUT → PATCH file. Version goes up by one; learners who
  // downloaded the old version see an Updated badge, earlier submissions are untouched.
  interface Props {
    open: boolean;
    programmeId: string;
    resource: ResourceItem;
  }
  let { open = $bindable(), programmeId, resource }: Props = $props();

  let file = $state<File | null>(null);
  let saving = $state(false);
  let progress = $state(0);
  let error = $state<string | null>(null);

  $effect(() => {
    if (!open) return;
    void resource.id;
    untrack(() => {
      file = null;
      saving = false;
      progress = 0;
      error = null;
    });
  });

  function pick(files: File[]) {
    const f = files[0];
    if (!f) return;
    const problem = resourcesAdminApi.validateFile(resource.kind, f);
    error = problem;
    if (!problem) file = f;
  }

  async function save(e: Event) {
    e.preventDefault();
    if (!file || saving) return;
    saving = true;
    error = null;
    const up = await resourcesAdminApi.uploadFile(programmeId, resource.kind, file, {
      resourceId: resource.id,
      onProgress: (p) => (progress = p)
    });
    if (!up.ok) {
      saving = false;
      error = up.error;
      return;
    }
    const res = await resourcesAdminApi.update(resource.id, { file: up.data.file });
    saving = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    snackbar.success(`File replaced — now version ${resource.version + 1}`);
    open = false;
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Replace file</Dialog.Title>
      <Dialog.Description>
        {resource.title} · currently {resource.file.name} (v{resource.version}).
      </Dialog.Description>
    </Dialog.Header>

    <form onsubmit={save} class="space-y-4">
      <p class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
        Learners who downloaded the old version will see <strong>Updated</strong>. Anything they already submitted is
        left as it was.
      </p>

      {#if file}
        <div class="flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-sm">
          <span class="inline-flex min-w-0 items-center gap-1.5">
            <FileIcon size={14} class="shrink-0" />
            <span class="truncate">{file.name}</span>
            <span class="shrink-0 text-xs text-(--muted-foreground)">{fmtBytes(file.size)}</span>
          </span>
          <button
            type="button"
            class="text-(--muted-foreground) hover:text-(--foreground)"
            aria-label="Remove {file.name}"
            disabled={saving}
            onclick={() => (file = null)}
          >
            <XIcon size={14} />
          </button>
        </div>
      {:else}
        <FileDrop kind={resource.kind} disabled={saving} onfiles={pick} label="Choose the new file" />
      {/if}

      {#if saving}
        <div
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin="0"
          aria-valuemax="100"
          aria-label="Upload progress"
          class="h-2 overflow-hidden rounded-full bg-(--muted)"
        >
          <div class="h-full bg-(--primary) transition-all" style="width: {progress}%"></div>
        </div>
      {/if}

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
        <Button type="submit" disabled={!file || saving} loading={saving}>Replace file</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
