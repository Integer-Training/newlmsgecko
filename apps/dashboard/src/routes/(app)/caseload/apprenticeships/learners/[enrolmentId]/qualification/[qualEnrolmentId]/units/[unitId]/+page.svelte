<script lang="ts">
  import { page } from '$app/state';
  import { currentOrg } from '$lib/utils/store/org';
  import Unit from '$features/apprenticeship/pages/unit.svelte';
  import { loadCrumbNames } from '$features/apprenticeship/components/shell/crumbs.svelte';
  import { apprenticeshipsBase } from '$features/apprenticeship/utils/paths';

  const enrolmentId = $derived(page.params.enrolmentId ?? '');
  const qualEnrolmentId = $derived(page.params.qualEnrolmentId ?? '');
  const unitId = $derived(page.params.unitId ?? '');
  $effect(() => {
    loadCrumbNames({ learnerEnrolmentId: enrolmentId, qualEnrolmentId, unitId });
  });
  const qualHref = $derived(
    `${apprenticeshipsBase(page.url.pathname, $currentOrg.siteName)}/learners/${enrolmentId}/qualification/${qualEnrolmentId}`
  );
</script>

{#key `${enrolmentId}:${qualEnrolmentId}:${unitId}`}
  <Unit mode="staff" {enrolmentId} {qualEnrolmentId} {unitId} {qualHref} unitHref={(id) => `${qualHref}/units/${id}`} />
{/key}
