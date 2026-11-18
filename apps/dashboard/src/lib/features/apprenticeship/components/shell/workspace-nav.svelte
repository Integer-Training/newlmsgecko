<script lang="ts">
  import type { WorkspaceTab } from '../../utils/paths';

  // Horizontal section nav for the apprenticeship workspace. Plain links with aria-current on the active tab;
  // scrolls sideways on narrow screens instead of wrapping.

  interface Props {
    tabs: WorkspaceTab[];
    pathname: string;
    badges?: Partial<Record<NonNullable<WorkspaceTab['badge']>, number>>;
  }

  let { tabs, pathname, badges = {} }: Props = $props();
</script>

<nav aria-label="Apprenticeship sections" class="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
  <ul class="flex min-w-max gap-1 border-b">
    {#each tabs as tab (tab.key)}
      {@const active = tab.isActive(pathname)}
      {@const count = tab.badge ? (badges[tab.badge] ?? 0) : 0}
      <li>
        <a
          href={tab.href}
          aria-current={active ? 'page' : undefined}
          class="-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:outline-none {active
            ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
            : 'text-muted-foreground hover:text-foreground border-transparent'}"
        >
          {tab.label}
          {#if count > 0}
            <span
              class="rounded-full bg-teal-600 px-1.5 py-0.5 text-[10px] leading-none font-semibold text-white"
              aria-label="{count} to mark"
            >
              {count > 99 ? '99+' : count}
            </span>
          {/if}
        </a>
      </li>
    {/each}
  </ul>
</nav>
