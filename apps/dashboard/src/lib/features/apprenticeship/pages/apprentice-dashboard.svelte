<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '@cio/ui/base/button';
  import { Spinner } from '@cio/ui/base/spinner';
  import { Empty } from '@cio/ui/custom/empty';
  import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap';
  import { myApprenticeshipApi } from '../api/my-apprenticeship.svelte';
  import DashboardBody from './apprentice-dashboard-body.svelte';

  // Gecko Apprenticeships — the apprentice's landing page (the shell's Dashboard). Zero enrolments keeps the original
  // empty state; otherwise the cards for the CURRENT enrolment (sidebar switcher when there are several).
  onMount(() => {
    myApprenticeshipApi.load(true);
  });

  const enrolmentId = $derived(myApprenticeshipApi.currentEnrolmentId);
</script>

{#if !myApprenticeshipApi.loaded}
  <div class="flex justify-center py-16" role="status" aria-label="Loading your apprenticeship"><Spinner /></div>
{:else if myApprenticeshipApi.error && !enrolmentId}
  <div class="flex flex-col items-center gap-3 py-16" role="alert">
    <p class="text-sm text-rose-600">{myApprenticeshipApi.error}</p>
    <Button variant="outline" onclick={() => myApprenticeshipApi.load(true)}>Try again</Button>
  </div>
{:else if !enrolmentId}
  <Empty
    title="No apprenticeship yet"
    description="When you are enrolled on an apprenticeship, your portfolio and progress will appear here."
    icon={GraduationCapIcon}
    variant="page"
  />
{:else}
  {#key enrolmentId}
    <DashboardBody {enrolmentId} />
  {/key}
{/if}
