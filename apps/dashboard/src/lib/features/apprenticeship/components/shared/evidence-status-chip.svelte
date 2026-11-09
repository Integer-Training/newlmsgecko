<script lang="ts">
  import { APPR_EVIDENCE_STATUS_LABELS, type ApprEvidenceStatus } from '@cio/utils/constants/apprenticeship';
  import { EVIDENCE_STATUS_CLASS } from './format';

  interface Props {
    status: string;
  }
  let { status }: Props = $props();
</script>

<span
  class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap {EVIDENCE_STATUS_CLASS[
    status
  ] ?? 'bg-(--muted) text-(--muted-foreground)'}"
>
  {APPR_EVIDENCE_STATUS_LABELS[status as ApprEvidenceStatus] ?? status}
</span>
