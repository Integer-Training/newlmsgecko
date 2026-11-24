<script lang="ts">
  import { Button } from '@cio/ui/base/button';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import EyeIcon from '@lucide/svelte/icons/eye';
  import FileIcon from '@lucide/svelte/icons/file';
  import FileTextIcon from '@lucide/svelte/icons/file-text';
  import PresentationIcon from '@lucide/svelte/icons/presentation';
  import SheetIcon from '@lucide/svelte/icons/sheet';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import type { LearnerResourceItem } from '../../../api/resources-learner.svelte';
  import { fmtBytes, fmtDate } from '../../shared/format';
  import ResourceStatusChip from './resource-status-chip.svelte';
  import { canPreview, fileFamily } from './resource-utils';
  import type { ResourceActions } from './resource-actions.svelte';

  // One resource: type icon, title, description, size, "View only" / "Workbook" chip, progress chip, an "Updated" badge
  // when the tutor replaced the file since the learner downloaded it, and the actions the API allows. Used on the
  // Resources page and in the unit page card (learner and staff: staff get view / download only).

  interface Props {
    resource: LearnerResourceItem;
    actions: ResourceActions;
    mode?: 'learner' | 'staff';
    /** The apprenticeship is closed or at end-point assessment: no upload. */
    uploadBlocked?: boolean;
    uploadBlockedReason?: string;
  }
  let { resource: r, actions, mode = 'learner', uploadBlocked = false, uploadBlockedReason }: Props = $props();

  const family = $derived(fileFamily(r));
  const isWorkbook = $derived(r.kind === 'WORKBOOK');
  const previewable = $derived(canPreview(r));
  const busy = $derived(actions.downloadingId === r.id);
  const Icon = $derived(
    family === 'sheet'
      ? SheetIcon
      : family === 'slides'
        ? PresentationIcon
        : family === 'other'
          ? FileIcon
          : FileTextIcon
  );
  const iconColour = $derived(
    family === 'pdf'
      ? 'text-rose-600 bg-rose-50 dark:bg-rose-500/10'
      : family === 'word'
        ? 'text-sky-600 bg-sky-50 dark:bg-sky-500/10'
        : family === 'sheet'
          ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-500/10'
          : 'text-(--muted-foreground) bg-(--muted)'
  );
</script>

<li class="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:gap-4">
  <div class="flex min-w-0 flex-1 items-start gap-3">
    <span class="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg {iconColour}" aria-hidden="true">
      <Icon size={20} />
    </span>
    <div class="min-w-0 flex-1 space-y-1">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 class="min-w-0 text-sm font-semibold break-words">{r.title}</h4>
        {#if r.updatedSinceDownload}
          <span
            class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
            title="This workbook was updated after you downloaded it"
          >
            Updated
          </span>
        {/if}
      </div>
      {#if r.description}
        <p class="text-sm text-(--muted-foreground)">{r.description}</p>
      {/if}
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-(--muted-foreground)">
        <span
          class="rounded-full px-2 py-0.5 font-medium {isWorkbook
            ? 'bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-300'
            : 'bg-(--muted) text-(--muted-foreground)'}"
        >
          {isWorkbook ? 'Workbook' : 'View only'}
        </span>
        {#if mode === 'learner'}<ResourceStatusChip status={r.status} />{/if}
        <span>{fmtBytes(r.file.size)}</span>
        <span aria-hidden="true">·</span>
        <span>Updated {fmtDate(r.updatedAt)}</span>
      </div>
    </div>
  </div>

  <div class="flex flex-wrap gap-2 sm:shrink-0 sm:justify-end">
    {#if previewable}
      <Button variant="outline" size="sm" aria-label="View {r.title}" onclick={() => actions.view(r)}>
        <EyeIcon size={14} class="mr-1" /> View
      </Button>
    {/if}
    {#if r.downloadable && (isWorkbook || mode === 'staff')}
      <Button
        variant="outline"
        size="sm"
        aria-label="Download {r.title}"
        loading={busy}
        disabled={!!actions.downloadingId}
        onclick={() => actions.download(r)}
      >
        <DownloadIcon size={14} class="mr-1" /> Download
      </Button>
    {/if}
    {#if mode === 'learner' && isWorkbook}
      <Button
        size="sm"
        aria-label="Upload completed workbook for {r.title}"
        disabled={uploadBlocked}
        title={uploadBlocked ? uploadBlockedReason : undefined}
        onclick={() => actions.upload(r)}
      >
        <UploadIcon size={14} class="mr-1" /> Upload completed workbook
      </Button>
    {/if}
  </div>
</li>
