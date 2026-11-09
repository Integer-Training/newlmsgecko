<script lang="ts">
  import { page } from '$app/state';
  import Portfolio from '$features/apprenticeship/pages/portfolio.svelte';
</script>

{#key page.params.enrolmentId}
  <Portfolio enrolmentId={page.params.enrolmentId ?? ''} />
{/key}
