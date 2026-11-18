<script lang="ts">
  import { page } from '$app/state';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import { currentOrg, isOrgAdmin } from '$lib/utils/store/org';
  import { apprenticeshipsBase } from '../../utils/paths';
  import type { OverviewPayload } from '../../api/overview.types';

  // "Add the paired standard": a diploma-only learner whose diploma has a paired Standard. Admin only (enrolling is
  // admin-only). Opens the Enrol-apprentice wizard on the learners list pre-filled with this learner and the Standard.
  interface Props {
    canAddPair: NonNullable<OverviewPayload['canAddPair']>;
    learnerId: string;
    /** Override the apprenticeships base (defaults to the current shell's). */
    base?: string;
  }
  let { canAddPair, learnerId, base }: Props = $props();

  const root = $derived(base ?? apprenticeshipsBase(page.url.pathname, $currentOrg.siteName));
  const href = $derived(
    `${root}?enrol=1&learner=${encodeURIComponent(learnerId)}&programme=${encodeURIComponent(canAddPair.programmeId)}`
  );
</script>

{#if $isOrgAdmin}
  <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-4">
    <div class="min-w-0">
      <p class="text-sm font-semibold">Add the paired standard</p>
      <p class="text-sm text-(--muted-foreground)">
        This diploma is paired with <strong>{canAddPair.title}</strong>. Enrol the learner on it to track both.
      </p>
    </div>
    <a
      {href}
      class="inline-flex items-center gap-1 rounded-md bg-(--primary) px-3 py-2 text-sm font-medium text-(--primary-foreground) hover:opacity-90"
    >
      <PlusIcon size={14} /> Add standard
    </a>
  </div>
{/if}
