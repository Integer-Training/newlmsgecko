<script lang="ts">
  import { DashboardPage } from '$features/lms/pages';
  import { Spinner } from '@cio/ui/base/spinner';
  import { myApprenticeshipApi } from '$features/apprenticeship/api/my-apprenticeship.svelte';
</script>

<svelte:head>
  <title>Student Dashboard</title>
</svelte:head>

<!-- Apprentices are redirected to /lms/apprenticeship by the layout once the check loads; hold the course dashboard
     back until then so they never see it flash. -->
{#if !myApprenticeshipApi.loaded || myApprenticeshipApi.hasAny}
  <div class="flex justify-center py-16" role="status" aria-label="Loading"><Spinner /></div>
{:else}
  <div class="w-full py-4">
    <DashboardPage />
  </div>
{/if}
