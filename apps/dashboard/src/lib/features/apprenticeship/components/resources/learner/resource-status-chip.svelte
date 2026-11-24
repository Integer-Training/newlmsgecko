<script lang="ts">
  import type { ResourceStatus } from '../../../api/resources-learner.svelte';
  import { STATUS_CLASSES, STATUS_LABELS } from './resource-utils';

  interface Props {
    status: ResourceStatus;
    class?: string;
  }
  let { status, class: className = '' }: Props = $props();
</script>

<span
  class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap {STATUS_CLASSES[
    status
  ] ?? STATUS_CLASSES.NOT_STARTED} {className}"
>
  {STATUS_LABELS[status] ?? status}
</span>
