<script lang="ts">
  import { Spinner } from '@cio/ui/base/spinner';
  import { Empty } from '@cio/ui/custom/empty';
  import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap';
  import { myApprenticeshipApi } from '../api/my-apprenticeship.svelte';
  import SectionBody, { type Section } from './apprentice-section-body.svelte';

  // Gecko Apprenticeships — one page of the apprentice shell (Units, Evidence, Tasks…) for the learner's CURRENT
  // enrolment; the body loads the same portfolio store the staff portfolio page uses and renders the existing tab.
  interface Props {
    section: Section;
    title: string;
  }
  let { section, title }: Props = $props();

  const enrolmentId = $derived(myApprenticeshipApi.currentEnrolmentId);
</script>

<svelte:head><title>{title} — My apprenticeship</title></svelte:head>

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
  <!-- A fresh store per enrolment, so switching programme in the sidebar reloads everything. -->
  {#key enrolmentId}
    <SectionBody {enrolmentId} {section} {title} />
  {/key}
{/if}
