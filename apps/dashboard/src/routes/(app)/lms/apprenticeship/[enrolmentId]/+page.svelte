<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { myApprenticeshipApi } from '$features/apprenticeship/api/my-apprenticeship.svelte';
  import Portfolio from '$features/apprenticeship/pages/portfolio.svelte';
  import { Spinner } from '@cio/ui/base/spinner';

  // One of the apprentice's own apprenticeships (the API 404s anyone else's). A COMPONENT id (e.g. an old
  // notification link) opens that qualification's page instead of a portfolio.
  const id = $derived(page.params.enrolmentId ?? '');
  const isComponent = $derived(myApprenticeshipApi.loaded && myApprenticeshipApi.isComponent(id));

  $effect(() => {
    void myApprenticeshipApi.load();
    if (isComponent) void goto(`/lms/apprenticeship/q/${id}`, { replaceState: true });
  });
</script>

{#if !myApprenticeshipApi.loaded || isComponent}
  <div class="flex justify-center py-16" role="status" aria-label="Loading"><Spinner /></div>
{:else}
  {#key id}
    <Portfolio
      enrolmentId={id}
      qualHref={(q) => `/lms/apprenticeship/q/${q}`}
      unitHref={(q, u) => `/lms/apprenticeship/q/${q}/units/${u}`}
    />
  {/key}
{/if}
