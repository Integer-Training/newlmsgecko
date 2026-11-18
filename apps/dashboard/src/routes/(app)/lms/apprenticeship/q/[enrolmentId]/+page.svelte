<script lang="ts">
  import { page } from '$app/state';
  import { myApprenticeshipApi } from '$features/apprenticeship/api/my-apprenticeship.svelte';
  import Qualification from '$features/apprenticeship/pages/qualification.svelte';

  // Learner mode of the shared qualification page. `enrolmentId` is the qualification (either enrolment of the pair);
  // the API scopes a learner to their own enrolments and 404s anyone else's.
  const BASE = '/lms/apprenticeship';
  const qualId = $derived(page.params.enrolmentId ?? '');
  const carrierId = $derived(myApprenticeshipApi.carrierOf(qualId) ?? qualId);
</script>

<svelte:head><title>Qualification — My apprenticeship</title></svelte:head>

{#key qualId}
  <Qualification
    mode="learner"
    enrolmentId={carrierId}
    qualEnrolmentId={qualId}
    backHref={BASE}
    unitHref={(unitId: string) => `${BASE}/q/${qualId}/units/${unitId}`}
  />
{/key}
