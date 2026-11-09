<script lang="ts">
  // Where the learner is on the road to end-point assessment (stage + label come from the API).
  interface Props {
    stage?: string;
    label?: string;
  }
  let { stage, label }: Props = $props();

  const CLASS: Record<string, string> = {
    IN_LEARNING: 'bg-(--muted) text-(--muted-foreground)',
    READY_FOR_GATEWAY: 'bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-300',
    AT_GATEWAY: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300',
    EPA_BOOKED: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
    ACHIEVED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
    EPA_FAILED: 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300'
  };
</script>

{#if stage && label}
  <span
    class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap {CLASS[stage] ??
      'bg-(--muted) text-(--muted-foreground)'}"
  >
    {label}
  </span>
{/if}
