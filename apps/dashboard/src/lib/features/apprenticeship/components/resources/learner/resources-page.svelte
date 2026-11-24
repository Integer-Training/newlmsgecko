<script lang="ts">
  import { Spinner } from '@cio/ui/base/spinner';
  import { Empty } from '@cio/ui/custom/empty';
  import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap';
  import { myApprenticeshipApi } from '../../../api/my-apprenticeship.svelte';
  import ResourcesBody from './resources-body.svelte';

  // Gecko Apprenticeships — the apprentice's Resources page wrapper: waits for the shell to know the current
  // apprenticeship, then renders the body for it.
  const enrolmentId = $derived(myApprenticeshipApi.currentEnrolmentId);
</script>

<svelte:head><title>Resources — My apprenticeship</title></svelte:head>

{#if !myApprenticeshipApi.loaded}
  <div class="flex justify-center py-16" role="status" aria-label="Loading your apprenticeship"><Spinner /></div>
{:else if !enrolmentId}
  <Empty
    title="No apprenticeship yet"
    description="When you are enrolled on an apprenticeship, it will appear here."
    icon={GraduationCapIcon}
    variant="page"
  />
{:else}
  <!-- A fresh body per apprenticeship, so switching in the sidebar reloads everything. -->
  {#key enrolmentId}
    <ResourcesBody {enrolmentId} />
  {/key}
{/if}
