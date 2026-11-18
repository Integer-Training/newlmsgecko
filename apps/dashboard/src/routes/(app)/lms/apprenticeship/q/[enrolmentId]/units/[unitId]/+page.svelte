<script lang="ts">
  import { page } from '$app/state';
  import { myApprenticeshipApi } from '$features/apprenticeship/api/my-apprenticeship.svelte';
  import Unit from '$features/apprenticeship/pages/unit.svelte';

  // Learner mode of the shared unit page (prev/next stay inside this qualification).
  const BASE = '/lms/apprenticeship';
  const qualId = $derived(page.params.enrolmentId ?? '');
  const unitId = $derived(page.params.unitId ?? '');
  const carrierId = $derived(myApprenticeshipApi.carrierOf(qualId) ?? qualId);
</script>

<svelte:head><title>Unit — My apprenticeship</title></svelte:head>

{#key `${qualId}:${unitId}`}
  <Unit
    mode="learner"
    enrolmentId={carrierId}
    qualEnrolmentId={qualId}
    {unitId}
    qualHref="{BASE}/q/{qualId}"
    unitHref={(id: string) => `${BASE}/q/${qualId}/units/${id}`}
  />
{/key}
