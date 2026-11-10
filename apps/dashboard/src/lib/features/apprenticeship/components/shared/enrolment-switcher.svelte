<script lang="ts">
  import { myApprenticeshipApi } from '../../api/my-apprenticeship.svelte';

  // Only rendered by the sidebar when the apprentice has several enrolments; the pick is remembered per viewer.
  const list = $derived(myApprenticeshipApi.enrolments);
</script>

<div class="px-2 pb-2 group-data-[collapsible=icon]:hidden">
  <label class="sr-only" for="appr-enrolment-switcher">Apprenticeship</label>
  <select
    id="appr-enrolment-switcher"
    class="border-input bg-background w-full rounded-md border px-2 py-1.5 text-sm"
    value={myApprenticeshipApi.currentEnrolmentId}
    onchange={(e) => myApprenticeshipApi.setCurrent(e.currentTarget.value)}
  >
    {#each list as e (e.id)}
      <option value={e.id}>{e.programmeTitle}</option>
    {/each}
  </select>
</div>
