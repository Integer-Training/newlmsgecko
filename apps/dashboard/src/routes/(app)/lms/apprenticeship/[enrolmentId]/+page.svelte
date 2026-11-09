<script lang="ts">
  import { page } from '$app/state';
  import Portfolio from '$features/apprenticeship/pages/portfolio.svelte';
</script>

<!-- Phase C: one of the apprentice's own portfolios (the API 404s anyone else's). -->
{#key page.params.enrolmentId}
  <Portfolio enrolmentId={page.params.enrolmentId ?? ''} />
{/key}
