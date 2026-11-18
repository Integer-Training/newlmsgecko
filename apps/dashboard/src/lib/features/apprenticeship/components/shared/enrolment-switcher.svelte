<script lang="ts">
  import { myApprenticeshipApi } from '../../api/my-apprenticeship.svelte';

  // Only for learners with two or more DISTINCT apprenticeships (a diploma + standard pair is one apprenticeship and
  // never shows this). Options are carrier ids; the pick is remembered per viewer.
  const list = $derived(myApprenticeshipApi.enrolments);
  const label = (e: (typeof list)[number]) =>
    e.linked ? `${e.programmeTitle} + ${e.linked.programmeTitle}` : e.programmeTitle;
</script>

{#if myApprenticeshipApi.hasSeveral}
  <div class="px-2 pb-2 group-data-[collapsible=icon]:hidden">
    <label class="sr-only" for="appr-enrolment-switcher">Apprenticeship</label>
    <select
      id="appr-enrolment-switcher"
      class="border-input bg-background w-full rounded-md border px-2 py-1.5 text-sm"
      value={myApprenticeshipApi.currentEnrolmentId}
      onchange={(e) => myApprenticeshipApi.setCurrent(e.currentTarget.value)}
    >
      {#each list as e (e.id)}
        <option value={e.id}>{label(e)}</option>
      {/each}
    </select>
  </div>
{/if}
