<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { Button } from '@cio/ui/base/button';
  import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap';
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import { currentOrg } from '$lib/utils/store/org';
  import { apprSummaryApi } from '../../api/summary.svelte';
  import type { WorkspaceTab } from '../../utils/paths';
  import WorkspaceNav from './workspace-nav.svelte';

  // Gecko Apprenticeships — shared shell for the admin and tutor areas: a teal header band (so it never looks like
  // a course screen), the section tabs, then the page. enrolHref is passed for admins only (Enrol apprentice).

  interface Props {
    tabs: WorkspaceTab[];
    enrolHref?: string;
    children?: Snippet;
  }

  let { tabs, enrolHref, children }: Props = $props();

  let toMark = $state(0);

  onMount(() => {
    apprSummaryApi.get().then((res) => {
      if (res.ok) toMark = res.data.toMark;
    });
  });
</script>

<div class="flex flex-col gap-4 py-4">
  <header
    class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-l-4 border-teal-600 bg-teal-50 px-4 py-3 dark:border-teal-400 dark:bg-teal-950/30"
  >
    <div class="flex items-center gap-3">
      <span
        class="flex size-9 items-center justify-center rounded-md bg-teal-600 text-white dark:bg-teal-500"
        aria-hidden="true"
      >
        <GraduationCapIcon size={18} />
      </span>
      <div class="leading-tight">
        <p class="text-lg font-semibold tracking-tight">Apprenticeships</p>
        {#if $currentOrg.name}
          <p class="text-muted-foreground text-xs">{$currentOrg.name}</p>
        {/if}
      </div>
    </div>
    {#if enrolHref}
      <Button href={enrolHref}>
        <UserPlusIcon size={16} class="mr-1" /> Enrol apprentice
      </Button>
    {/if}
  </header>

  <WorkspaceNav {tabs} pathname={page.url.pathname} badges={{ toMark }} />

  <div>
    {@render children?.()}
  </div>
</div>
