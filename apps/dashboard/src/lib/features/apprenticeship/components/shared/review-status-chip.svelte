<script lang="ts">
  import { APPR_REVIEW_STATUS_LABELS, type ApprReviewStatus } from '@cio/utils/constants/apprenticeship';

  // Review status chip (+ a red "Overdue" chip when flagged).
  interface Props {
    status: string;
    overdue?: boolean;
  }
  let { status, overdue = false }: Props = $props();

  const CLASS: Record<string, string> = {
    SCHEDULED: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300',
    DRAFT: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
    AWAITING_SIGNATURES: 'bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-300',
    COMPLETE: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
    CANCELLED: 'bg-(--muted) text-(--muted-foreground)'
  };
</script>

<span class="inline-flex flex-wrap items-center gap-1">
  <span
    class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap {CLASS[status] ??
      'bg-(--muted) text-(--muted-foreground)'}"
  >
    {APPR_REVIEW_STATUS_LABELS[status as ApprReviewStatus] ?? status}
  </span>
  {#if overdue}
    <span
      class="inline-flex items-center rounded-full bg-rose-600 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-white"
    >
      Overdue
    </span>
  {/if}
</span>
