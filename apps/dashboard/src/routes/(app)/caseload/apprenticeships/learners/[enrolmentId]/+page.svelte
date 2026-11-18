<script lang="ts">
  import { page } from '$app/state';
  import Portfolio from '$features/apprenticeship/pages/portfolio.svelte';
  import { loadCrumbNames } from '$features/apprenticeship/components/shell/crumbs.svelte';

  $effect(() => {
    loadCrumbNames({ learnerEnrolmentId: page.params.enrolmentId });
  });
</script>

{#key page.params.enrolmentId}
  <Portfolio enrolmentId={page.params.enrolmentId ?? ''} />
{/key}
