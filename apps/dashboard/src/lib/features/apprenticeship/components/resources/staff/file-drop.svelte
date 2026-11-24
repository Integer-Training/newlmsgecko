<script lang="ts">
  import UploadIcon from '@lucide/svelte/icons/upload';
  import type { ApprResourceKind } from '@cio/utils/constants/apprenticeship';

  // Drag-and-drop / click-to-choose zone. Validation of the files happens in the parent (onfiles); the zone only
  // hands over what was picked. The hidden input stays keyboard reachable through the visible button.
  interface Props {
    kind: ApprResourceKind;
    multiple?: boolean;
    disabled?: boolean;
    onfiles: (files: File[]) => void;
    label?: string;
  }
  let { kind, multiple = false, disabled = false, onfiles, label }: Props = $props();

  let over = $state(false);
  let input = $state<HTMLInputElement | null>(null);

  const accept = $derived(kind === 'LEARNING' ? '.pdf,.docx' : '.pdf,.doc,.docx,.xlsx,.pptx');
  const hint = $derived(kind === 'LEARNING' ? 'PDF or Word (.docx)' : 'PDF, Word, Excel or PowerPoint');

  function handle(list: FileList | null | undefined) {
    const files = list ? Array.from(list) : [];
    if (files.length === 0) return;
    onfiles(multiple ? files : files.slice(0, 1));
  }
</script>

<div
  role="group"
  aria-label={label ?? (multiple ? 'Choose files' : 'Choose a file')}
  class="flex flex-col items-center gap-2 rounded-md border-2 border-dashed px-4 py-6 text-center text-sm transition-colors {over
    ? 'border-(--primary) bg-(--primary)/5'
    : 'border-(--border)'} {disabled ? 'opacity-60' : ''}"
  ondragover={(e) => {
    e.preventDefault();
    if (!disabled) over = true;
  }}
  ondragleave={() => (over = false)}
  ondrop={(e) => {
    e.preventDefault();
    over = false;
    if (!disabled) handle(e.dataTransfer?.files);
  }}
>
  <UploadIcon class="size-6 text-(--muted-foreground)" aria-hidden="true" />
  <p>
    Drag {multiple ? 'files' : 'a file'} here or
    <button
      type="button"
      class="font-medium underline underline-offset-2 disabled:no-underline"
      {disabled}
      onclick={() => input?.click()}
    >
      browse
    </button>
  </p>
  <p class="text-xs text-(--muted-foreground)">{hint}</p>
  <input
    bind:this={input}
    type="file"
    class="hidden"
    {accept}
    {multiple}
    {disabled}
    tabindex="-1"
    aria-hidden="true"
    onchange={(e) => {
      handle(e.currentTarget.files);
      e.currentTarget.value = '';
    }}
  />
</div>
