<script lang="ts">
  import {
    APPR_PROGRAMME_TYPE_LABELS,
    APPR_PROGRAMME_TYPE_SHORT,
    type ApprProgrammeType
  } from '@cio/utils/constants/apprenticeship';

  // Blue "Diploma" / violet "Standard" chip. The full label ("Apprenticeship diploma") is the accessible name.
  interface Props {
    type: ApprProgrammeType | string;
    size?: 'sm' | 'md';
  }
  let { type, size = 'sm' }: Props = $props();

  const CLASS: Record<string, string> = {
    DIPLOMA: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
    STANDARD: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200'
  };
  const short = $derived(APPR_PROGRAMME_TYPE_SHORT[type as ApprProgrammeType] ?? type);
  const full = $derived(APPR_PROGRAMME_TYPE_LABELS[type as ApprProgrammeType] ?? type);
</script>

<span
  class="inline-flex items-center rounded-full font-medium whitespace-nowrap {size === 'md'
    ? 'px-2.5 py-1 text-sm'
    : 'px-2 py-0.5 text-xs'} {CLASS[type] ?? 'bg-(--muted) text-(--muted-foreground)'}"
  title={full}
>
  <span aria-hidden="true">{short}</span>
  <span class="sr-only">{full}</span>
</span>
