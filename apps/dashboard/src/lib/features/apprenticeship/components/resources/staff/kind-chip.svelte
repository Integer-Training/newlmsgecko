<script lang="ts">
  import type { ApprResourceKind } from '@cio/utils/constants/apprenticeship';

  // "Learning · view only" (sky) / "Workbook · downloadable" (violet).
  interface Props {
    kind: ApprResourceKind;
  }
  let { kind }: Props = $props();
</script>

<span
  class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap {kind === 'WORKBOOK'
    ? 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200'
    : 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200'}"
>
  {kind === 'WORKBOOK' ? 'Workbook · downloadable' : 'Learning · view only'}
</span>
