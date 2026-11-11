<script lang="ts">
  import { APPR_IQA_OUTCOME_LABELS, type ApprIqaOutcome } from '@cio/utils/constants/apprenticeship';

  interface Props {
    outcome: ApprIqaOutcome;
    /** Label for PENDING (the tutor sees "Being reviewed"). */
    pendingLabel?: string;
  }
  let { outcome, pendingLabel }: Props = $props();

  const CLASS: Record<ApprIqaOutcome, string> = {
    PENDING: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
    AGREE: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
    DISAGREE: 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300'
  };
</script>

<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap {CLASS[outcome]}">
  {outcome === 'PENDING' && pendingLabel ? pendingLabel : APPR_IQA_OUTCOME_LABELS[outcome]}
</span>
