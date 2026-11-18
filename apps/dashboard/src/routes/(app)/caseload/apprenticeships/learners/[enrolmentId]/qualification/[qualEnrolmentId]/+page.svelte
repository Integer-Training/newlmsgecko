<script lang="ts">
  import { page } from '$app/state';
  import { currentOrg } from '$lib/utils/store/org';
  import Qualification from '$features/apprenticeship/pages/qualification.svelte';
  import { apprenticeshipsBase } from '$features/apprenticeship/utils/paths';

  const enrolmentId = $derived(page.params.enrolmentId ?? '');
  const qualEnrolmentId = $derived(page.params.qualEnrolmentId ?? '');
  const learnerHref = $derived(
    `${apprenticeshipsBase(page.url.pathname, $currentOrg.siteName)}/learners/${enrolmentId}`
  );
</script>

{#key `${enrolmentId}:${qualEnrolmentId}`}
  <Qualification
    mode="staff"
    {enrolmentId}
    {qualEnrolmentId}
    backHref={learnerHref}
    unitHref={(unitId) => `${learnerHref}/qualification/${qualEnrolmentId}/units/${unitId}`}
  />
{/key}
