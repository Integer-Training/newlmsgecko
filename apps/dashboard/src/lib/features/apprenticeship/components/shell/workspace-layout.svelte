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
  import { workspaceCrumbs, type Crumb } from './crumbs.svelte';

  // Gecko Apprenticeships — shared shell for the admin and tutor areas: a teal header band (so it never looks like
  // a course screen), the section tabs, then the page. enrolHref is passed for admins only (Enrol apprentice).

  interface Props {
    tabs: WorkspaceTab[];
    enrolHref?: string;
    children?: Snippet;
  }

  let { tabs, enrolHref, children }: Props = $props();

  let toMark = $state(0);

  // Breadcrumbs: Apprenticeships / <Tab> / <Learner> / <Qualification> / <Unit>, built from the URL; names come from
  // workspaceCrumbs (set by the learner / qualification / unit routes). A page may override the trail entirely.
  const crumbs = $derived.by((): Crumb[] => {
    const pathname = page.url.pathname;
    const ov = workspaceCrumbs.override;
    if (ov && ov.pathname === pathname) return ov.items;
    const learnersTab = tabs.find((t) => t.key === 'learners');
    const base = learnersTab?.href ?? '';
    const active = tabs.find((t) => t.isActive(pathname));
    const out: Crumb[] = [{ label: 'Apprenticeships', href: tabs[0]?.href }];
    if (active) out.push({ label: active.label, href: active.href });
    const { enrolmentId, qualEnrolmentId, unitId } = page.params;
    if (active?.key === 'learners' && enrolmentId) {
      const learnerHref = `${base}/learners/${enrolmentId}`;
      out.push({ label: workspaceCrumbs.names.learner ?? 'Learner', href: learnerHref });
      if (qualEnrolmentId) {
        const qualHref = `${learnerHref}/qualification/${qualEnrolmentId}`;
        out.push({ label: workspaceCrumbs.names.qualification ?? 'Qualification', href: qualHref });
        if (unitId) out.push({ label: workspaceCrumbs.names.unit ?? 'Unit' });
      }
    }
    // The current page is the last crumb: plain text, not a link.
    const last = out[out.length - 1];
    if (last) out[out.length - 1] = { label: last.label };
    return out;
  });

  // Names belong to one learner: drop them when leaving the learner pages.
  $effect(() => {
    if (!page.params.enrolmentId) workspaceCrumbs.reset();
  });

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

  {#if crumbs.length > 1}
    <nav aria-label="Breadcrumb" class="-mt-2">
      <ol class="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        {#each crumbs as c, i (i)}
          {#if i > 0}<li aria-hidden="true">/</li>{/if}
          <li class="max-w-[60vw] truncate sm:max-w-xs" aria-current={c.href ? undefined : 'page'}>
            {#if c.href}
              <a href={c.href} class="hover:text-foreground hover:underline">{c.label}</a>
            {:else}
              <span class="text-foreground font-medium">{c.label}</span>
            {/if}
          </li>
        {/each}
      </ol>
    </nav>
  {/if}

  <WorkspaceNav {tabs} pathname={page.url.pathname} badges={{ toMark }} />

  <div>
    {@render children?.()}
  </div>
</div>
