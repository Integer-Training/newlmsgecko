<script lang="ts">
  import { Button } from '@cio/ui/base/button';
  import FileIcon from '@lucide/svelte/icons/file';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import XIcon from '@lucide/svelte/icons/x';
  import { taskPlansApi, type BriefFile } from '../../api/task-plans.svelte';
  import { fmtBytes } from '../shared/format';

  // Brief files for a plan or one of its tasks. Files upload as soon as they are chosen (presign → PUT) and are
  // attached when the parent saves. `planId` is the id they are presigned for: bind it for a plan not saved yet (the
  // server issues one on the first upload). Saved files can be opened; files only just uploaded cannot until saved.
  interface Props {
    files: BriefFile[];
    planId?: string;
    /** True once the plan exists, so already-saved files can be opened. */
    saved?: boolean;
    /** Keys of files that are saved on the server (openable). */
    savedKeys?: Set<string>;
    disabled?: boolean;
    label?: string;
    onerror?: (message: string | null) => void;
  }

  let {
    files = $bindable(),
    planId = $bindable(),
    saved = true,
    savedKeys = new Set<string>(),
    disabled = false,
    label = 'Brief files',
    onerror
  }: Props = $props();

  let uploading = $state(false);
  let input = $state<HTMLInputElement | null>(null);

  async function onPicked(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const picked = el.files ? Array.from(el.files) : [];
    el.value = '';
    if (picked.length === 0) return;
    uploading = true;
    onerror?.(null);
    const res = await taskPlansApi.upload(planId, picked);
    uploading = false;
    if (!res.ok) {
      onerror?.(res.error);
      return;
    }
    planId = res.data.planId;
    files = [...files, ...res.data.files];
  }

  function remove(key: string) {
    files = files.filter((f) => f.key !== key);
  }

  function open(key: string) {
    if (planId && saved && savedKeys.has(key)) taskPlansApi.openFile(planId, key);
  }
</script>

<div class="space-y-2">
  <p class="text-sm font-medium">{label}</p>
  <input
    bind:this={input}
    type="file"
    multiple
    class="hidden"
    aria-label="Choose {label.toLowerCase()}"
    onchange={onPicked}
  />
  <Button
    type="button"
    variant="outline"
    size="sm"
    loading={uploading}
    disabled={disabled || uploading}
    onclick={() => input?.click()}
  >
    <UploadIcon size={16} class="mr-1" /> Add files
  </Button>
  {#if files.length > 0}
    <ul class="space-y-1">
      {#each files as f (f.key)}
        <li class="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm">
          <span class="inline-flex min-w-0 items-center gap-1.5">
            <FileIcon size={14} class="shrink-0" />
            {#if saved && planId && savedKeys.has(f.key)}
              <button type="button" class="truncate hover:underline" onclick={() => open(f.key)}>{f.name}</button>
            {:else}
              <span class="truncate">{f.name}</span>
            {/if}
            <span class="shrink-0 text-xs text-(--muted-foreground)">{fmtBytes(f.size)}</span>
          </span>
          <button
            type="button"
            class="text-(--muted-foreground) hover:text-(--foreground)"
            aria-label="Remove {f.name}"
            {disabled}
            onclick={() => remove(f.key)}
          >
            <XIcon size={14} />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
