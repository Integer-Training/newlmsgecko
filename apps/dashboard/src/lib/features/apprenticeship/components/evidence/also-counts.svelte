<script lang="ts">
  import type { ApprProgrammeType } from '@cio/utils/constants/apprenticeship';
  import { alsoCountsTowards, type MappedQualification } from '../../api/evidence.svelte';
  import ProgrammeTypeChip from '../shared/programme-type-chip.svelte';

  // Cross-mapped evidence markers (Deploy 3). "Also counts towards: <other qualification> · <codes>" on the side the
  // evidence lives on, and "From <Diploma|Standard>" on the other qualification's views.

  interface Props {
    /** The enrolment the evidence lives on. */
    home: string | null | undefined;
    mapped?: MappedQualification[] | null;
    /** The enrolment of the view being shown; when it differs from `home` the "From …" chip shows instead. */
    viewing?: string | null;
    /** The type of the home qualification, if known (used when the mapped list does not include it). */
    homeType?: ApprProgrammeType | null;
  }
  let { home, mapped = null, viewing = null, homeType = null }: Props = $props();

  const others = $derived(alsoCountsTowards(home, mapped));
  const fromOther = $derived(!!viewing && !!home && viewing !== home);
  const fromType = $derived(homeType ?? mapped?.find((m) => m.enrolmentId === home)?.type ?? null);
</script>

{#if fromOther && fromType}
  <span class="inline-flex items-center gap-1 text-xs text-(--muted-foreground)">
    From <ProgrammeTypeChip type={fromType} />
  </span>
{:else if others.length > 0}
  <span class="block text-xs font-normal text-(--muted-foreground)">
    Also counts towards:
    {#each others as m, i (m.enrolmentId)}
      {i > 0 ? '; ' : ''}<span class="font-medium text-(--foreground)">{m.title}</span> · {m.criterionCodes.join(', ')}
    {/each}
  </span>
{/if}
