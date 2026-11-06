<script lang="ts">
  import type { ApprProgressStatus } from '@cio/utils/constants/apprenticeship';
  import { STATUS_CLASS, STATUS_LABEL } from './format';

  interface Props {
    status: ApprProgressStatus;
    class?: string;
  }
  let { status, class: className = '' }: Props = $props();
</script>

<span
  class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap {STATUS_CLASS[
    status
  ]} {className}"
>
  {STATUS_LABEL(status)}
</span>
