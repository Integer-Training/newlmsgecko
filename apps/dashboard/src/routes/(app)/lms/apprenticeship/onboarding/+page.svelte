<script lang="ts">
  import * as Page from '@cio/ui/base/page';
  import { Spinner } from '@cio/ui/base/spinner';
  import { Empty } from '@cio/ui/custom/empty';
  import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap';
  import { myApprenticeshipApi } from '$features/apprenticeship/api/my-apprenticeship.svelte';
  import OnboardingTab from '$features/apprenticeship/components/onboarding/onboarding-tab.svelte';
</script>

<svelte:head><title>Onboarding — My apprenticeship</title></svelte:head>

{#if !myApprenticeshipApi.loaded}
  <div class="flex justify-center py-16" role="status" aria-label="Loading your apprenticeship"><Spinner /></div>
{:else if !myApprenticeshipApi.currentEnrolmentId}
  <Empty
    title="No apprenticeship yet"
    description="When you are enrolled on an apprenticeship, it will appear here."
    icon={GraduationCapIcon}
    variant="page"
  />
{:else}
  <Page.Root class="w-full">
    <Page.Header>
      <Page.HeaderContent>
        <Page.Title>Onboarding</Page.Title>
      </Page.HeaderContent>
    </Page.Header>
    <Page.Body>
      {#snippet child()}
        {#key myApprenticeshipApi.currentEnrolmentId}
          <OnboardingTab enrolmentId={myApprenticeshipApi.currentEnrolmentId ?? ''} />
        {/key}
      {/snippet}
    </Page.Body>
  </Page.Root>
{/if}
