<script lang="ts">
  import { APPR_TASK_STATUS_LABELS, type ApprTaskStatus } from '@cio/utils/constants/apprenticeship';

  // Task status chip (+ a red "Overdue" chip when the API flags the task overdue).
  interface Props {
    status: string;
    overdue?: boolean;
  }
  let { status, overdue = false }: Props = $props();

  const CLASS: Record<string, string> = {
    PLANNED: 'bg-(--muted) text-(--muted-foreground)',
    SUBMITTED: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
    REFERRED: 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300',
    COMPLETE: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300'
  };
</script>

<span class="inline-flex flex-wrap items-center gap-1">
  <span
    class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap {CLASS[status] ??
      'bg-(--muted) text-(--muted-foreground)'}"
  >
    {APPR_TASK_STATUS_LABELS[status as ApprTaskStatus] ?? status}
  </span>
  {#if overdue}
    <span
      class="inline-flex items-center rounded-full bg-rose-600 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-white"
    >
      Overdue
    </span>
  {/if}
</span>
