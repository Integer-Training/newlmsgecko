<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import * as Avatar from '@cio/ui/base/avatar';
  import * as Sidebar from '@cio/ui/base/sidebar';
  import { UserAvatar } from '@cio/ui/custom/user-avatar';
  import { currentOrg } from '$lib/utils/store/org';
  import { profile } from '$lib/utils/store/user';
  import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
  import BookOpenIcon from '@lucide/svelte/icons/book-open';
  import TrendingUpIcon from '@lucide/svelte/icons/trending-up';
  import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
  import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap';
  import { SidebarLogoutButton } from '$features/ui/sidebar/footer';
  import { apprSummaryApi } from '$features/apprenticeship/api/summary.svelte';

  // Tutor shell nav. Labelled groups; active state is derived from the current pathname. Apprenticeships is ONE
  // item — its sections (learners / overview / to mark / IQA) live in the workspace tabs on those pages.
  let toMark = $state(0);

  onMount(() => {
    apprSummaryApi.get().then((res) => {
      if (res.ok) toMark = res.data.toMark;
    });
  });

  const groups = $derived([
    {
      label: null as string | null,
      items: [
        {
          title: 'Dashboard',
          url: '/caseload',
          icon: LayoutDashboardIcon,
          isActive: page.url.pathname === '/caseload',
          badge: 0
        },
        {
          title: 'Messages',
          url: '/caseload/messages',
          icon: MessagesSquareIcon,
          isActive: page.url.pathname.startsWith('/caseload/messages') || page.url.pathname.startsWith('/messages'),
          badge: 0
        }
      ]
    },
    {
      label: 'Courses',
      items: [
        {
          title: 'My Courses',
          url: '/caseload/courses',
          icon: BookOpenIcon,
          isActive: page.url.pathname.startsWith('/caseload/courses'),
          badge: 0
        },
        {
          title: 'Learner Progression',
          url: '/caseload/progression',
          icon: TrendingUpIcon,
          isActive: page.url.pathname.startsWith('/caseload/progression'),
          badge: 0
        }
      ]
    },
    {
      label: 'Apprenticeships',
      items: [
        {
          title: 'Apprenticeships',
          url: '/caseload/apprenticeships',
          icon: GraduationCapIcon,
          isActive: page.url.pathname.startsWith('/caseload/apprenticeships'),
          badge: toMark
        }
      ]
    }
  ]);
</script>

<Sidebar.Root collapsible="icon">
  <Sidebar.Header>
    <Sidebar.Menu>
      <Sidebar.MenuItem>
        <Sidebar.MenuButton size="lg">
          {#snippet child({ props })}
            <a href="/caseload" {...props}>
              <Avatar.Root class="ui:flex ui:size-8 ui:items-center ui:justify-center ui:rounded-md">
                <Avatar.Image src={$currentOrg.avatarUrl || '/logo-192.png'} alt="{$currentOrg.name || 'Home'} logo" />
              </Avatar.Root>
              <div class="grid flex-1 text-left text-sm leading-tight">
                <span class="truncate font-medium">{$currentOrg.name || 'Home'}</span>
                <span class="text-muted-foreground truncate text-xs">Tutor</span>
              </div>
            </a>
          {/snippet}
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
  </Sidebar.Header>

  <Sidebar.Content>
    {#each groups as group (group.label ?? 'main')}
      <Sidebar.Group>
        {#if group.label}
          <Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
        {/if}
        <Sidebar.Menu>
          {#each group.items as item (item.title)}
            <Sidebar.MenuItem>
              <Sidebar.MenuButton tooltipContent={item.title} isActive={item.isActive}>
                {#snippet child({ props })}
                  {@const Icon = item.icon}
                  <a href={item.url} {...props}>
                    <Icon size={16} />
                    <span>{item.title}</span>
                  </a>
                {/snippet}
              </Sidebar.MenuButton>
              {#if item.badge > 0}
                <Sidebar.MenuBadge>{item.badge > 99 ? '99+' : item.badge}</Sidebar.MenuBadge>
              {/if}
            </Sidebar.MenuItem>
          {/each}
        </Sidebar.Menu>
      </Sidebar.Group>
    {/each}
  </Sidebar.Content>

  <Sidebar.Footer>
    <Sidebar.Menu>
      <Sidebar.MenuItem>
        <Sidebar.MenuButton size="lg" class="ui:cursor-default hover:ui:bg-transparent">
          <UserAvatar src={$profile.avatarUrl} alt={$profile.fullname} />
          <div class="grid flex-1 text-left text-sm leading-tight font-normal">
            <span class="truncate font-medium">{$profile.fullname || 'Tutor'}</span>
            <span class="text-muted-foreground truncate text-xs">{$profile.email || 'Tutor'}</span>
          </div>
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
    <SidebarLogoutButton />
  </Sidebar.Footer>

  <Sidebar.Rail />
</Sidebar.Root>
