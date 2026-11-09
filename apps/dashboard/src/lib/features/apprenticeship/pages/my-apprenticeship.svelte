<script lang="ts">
  import { onMount } from 'svelte';
  import * as Page from '@cio/ui/base/page';
  import { Button } from '@cio/ui/base/button';
  import { Spinner } from '@cio/ui/base/spinner';
  import { Empty } from '@cio/ui/custom/empty';
  import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap';
  import { myApprenticeshipApi } from '../api/my-apprenticeship.svelte';
  import Portfolio from './portfolio.svelte';

  // Phase C — the apprentice's landing page. One apprenticeship (the usual case) opens straight into its portfolio;
  // several show a short list to pick from.
  onMount(() => {
    myApprenticeshipApi.load(true);
  });

  const list = $derived(myApprenticeshipApi.enrolments);
</script>

{#if !myApprenticeshipApi.loaded}
  <div class="flex justify-center py-16" role="status" aria-label="Loading your apprenticeship"><Spinner /></div>
{:else if myApprenticeshipApi.error && list.length === 0}
  <div class="flex flex-col items-center gap-3 py-16" role="alert">
    <p class="text-sm text-rose-600">{myApprenticeshipApi.error}</p>
    <Button variant="outline" onclick={() => myApprenticeshipApi.load(true)}>Try again</Button>
  </div>
{:else if list.length === 0}
  <Empty
    title="No apprenticeship yet"
    description="When you are enrolled on an apprenticeship, your portfolio and progress will appear here."
    icon={GraduationCapIcon}
    variant="page"
  />
{:else if list.length === 1}
  {#key list[0].id}
    <Portfolio enrolmentId={list[0].id} showBack={false} />
  {/key}
{:else}
  <Page.Root class="w-full">
    <Page.Header>
      <Page.HeaderContent>
        <Page.Title>My apprenticeships</Page.Title>
      </Page.HeaderContent>
    </Page.Header>
    <Page.Body>
      {#snippet child()}
        <ul class="divide-y rounded-lg border">
          {#each list as e (e.id)}
            <li class="flex items-center justify-between gap-3 px-4 py-3">
              <span class="font-medium">{e.programmeTitle}</span>
              <Button variant="outline" size="sm" href="/lms/apprenticeship/{e.id}">Open</Button>
            </li>
          {/each}
        </ul>
      {/snippet}
    </Page.Body>
  </Page.Root>
{/if}
