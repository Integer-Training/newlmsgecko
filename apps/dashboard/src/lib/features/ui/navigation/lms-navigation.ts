import {
  AttachmentIcon,
  CertificateIcon,
  ChartColumnIcon,
  CommunityIcon,
  ContentIcon,
  CourseIcon,
  DashboardIcon,
  ExerciseIcon,
  ExploreIcon,
  GoalIcon,
  HomeIcon,
  NewsFeedIcon,
  ReviewIcon,
  SettingsIcon,
  SetupIcon
} from '@cio/ui/custom/moving-icons';

import type { AccountOrg } from '$features/app/types';
import type { Component } from 'svelte';
import { isActive } from '$lib/utils/functions/app';
import { PUBLIC_IS_SELFHOSTED } from '$env/static/public';
import {
  CERTIFICATES_ENABLED,
  COHORTS_ENABLED,
  COMMUNITY_ENABLED,
  EXPLORE_ENABLED
} from '$lib/utils/constants/features';
import { myApprenticeshipApi } from '$features/apprenticeship/api/my-apprenticeship.svelte';
import { apprenticeShell } from '$features/apprenticeship/api/apprentice-shell.svelte';

export interface NavItem {
  title: string;
  url: string;
  path: string;
  icon?: Component;
  isActive?: boolean;
  isExpanded?: boolean;
  show?: () => boolean;
  /** Small pill after the title (e.g. onboarding progress); undefined/null = none. */
  badge?: string | null;
  items?: NavItem[];
  useHashUrl?: boolean;
  nestedRoutes?: NestedRouteConfig[];
  supportsDynamicSegment?: boolean;
}

export interface NestedRouteConfig {
  path: string; // Relative to parent (e.g., 'ask', 'integrations')
  titleKey: string; // Translation key or plain text
}

export interface NavItemConfig {
  titleKey: string;
  path: string;
  icon?: Component;
  show?: (currentOrg: AccountOrg | null) => boolean;
  matchPattern?: string;
  /** Evaluated on every render so a rune-backed value stays reactive. */
  badge?: () => string | null;
  items?: NavItemConfig[];
  useHashUrl?: boolean;
  nestedRoutes?: NestedRouteConfig[];
  supportsDynamicSegment?: boolean;
}

// Base navigation configuration structure
export const baseNavConfig: NavItemConfig[] = [
  {
    titleKey: 'lms_navigation.home',
    path: '',
    icon: HomeIcon,
    matchPattern: '^/lms/?$'
  },
  {
    titleKey: 'lms_navigation.my_learning',
    path: '/mylearning',
    icon: CourseIcon,
    matchPattern: '^/lms/mylearning(/.*)?$'
  },
  {
    // Gecko Apprenticeships (Phase C): only for learners who actually have an apprenticeship — the learner shell loads
    // their enrolments once; reading the rune here keeps the sidebar reactive.
    titleKey: 'My apprenticeship',
    path: '/apprenticeship',
    icon: GoalIcon,
    matchPattern: '^/lms/apprenticeship(/.*)?$',
    show: () => myApprenticeshipApi.hasAny
  },
  {
    titleKey: 'lms_navigation.certificates',
    path: '/certificates',
    icon: CertificateIcon,
    matchPattern: '^/lms/certificates(/.*)?$',
    show: () => CERTIFICATES_ENABLED // certificates are issued off-platform / manually in PearlLMS
  },
  {
    titleKey: 'lms_navigation.explore',
    path: '/explore',
    icon: ExploreIcon,
    matchPattern: '^/lms/explore(/.*)?$',
    show: () => EXPLORE_ENABLED // closed LMS — no public catalogue to explore
  },
  {
    titleKey: 'lms_navigation.cohorts',
    path: '/cohorts',
    icon: GoalIcon,
    matchPattern: '^/lms/cohorts(/.*)?$',
    show: () => COHORTS_ENABLED // scheduled cohorts unused — learners enrolled via staff allocation
  },
  {
    // PearlLMS: this page is the learner's coursework board (workbooks / case studies), a core feature —
    // always visible on the self-hosted build. Upstream still gates it on the exercise customization flag.
    titleKey: 'lms_navigation.exercise',
    path: '/exercises',
    icon: ExerciseIcon,
    matchPattern: '^/lms/exercises(/.*)?$',
    show: (currentOrg) => PUBLIC_IS_SELFHOSTED === 'true' || currentOrg?.customization?.dashboard?.exercise === true
  },
  {
    titleKey: 'lms_navigation.community',
    path: '/community',
    icon: CommunityIcon,
    matchPattern: '^/lms/community(/.*)?$',
    show: (currentOrg) => COMMUNITY_ENABLED && currentOrg?.customization?.dashboard?.community === true,
    supportsDynamicSegment: true,
    nestedRoutes: [
      {
        path: 'ask',
        titleKey: 'Ask Question'
      }
    ]
  },
  {
    // PearlLMS: learners may NOT edit profile (name/email) — Settings now holds only Notification
    // preferences. Profile + Integrations are removed (their routes redirect to notifications).
    titleKey: 'lms_navigation.settings',
    path: '/settings/notifications',
    icon: SettingsIcon,
    matchPattern: '^/lms/settings(/.*)?$'
  }
];

const APPRENTICE_BASE = '/apprenticeship';

// Gecko Apprenticeships — the separate shell a learner with an apprenticeship enrolment gets. Replaces the whole
// learner sidebar (Home / Exercises are course-dashboard concepts and stay hidden). Notifications have no page of
// their own (only the header bell), so they are not listed here.
export const apprenticeNavConfig: NavItemConfig[] = [
  {
    titleKey: 'Dashboard',
    path: APPRENTICE_BASE,
    icon: DashboardIcon,
    matchPattern: '^/lms/apprenticeship/?$'
  },
  {
    titleKey: 'Onboarding',
    path: `${APPRENTICE_BASE}/onboarding`,
    icon: SetupIcon,
    matchPattern: '^/lms/apprenticeship/onboarding(/.*)?$',
    badge: () => {
      const o = apprenticeShell.onboarding;
      if (!o || o.enrolmentId !== myApprenticeshipApi.currentEnrolmentId || o.complete) return null;
      return `${o.approved}/${o.required}`;
    }
  },
  {
    titleKey: 'Units & criteria',
    path: `${APPRENTICE_BASE}/units`,
    icon: ContentIcon,
    matchPattern: '^/lms/apprenticeship/units(/.*)?$'
  },
  {
    titleKey: 'Evidence',
    path: `${APPRENTICE_BASE}/evidence`,
    icon: AttachmentIcon,
    matchPattern: '^/lms/apprenticeship/evidence(/.*)?$'
  },
  {
    titleKey: 'Tasks',
    path: `${APPRENTICE_BASE}/tasks`,
    icon: ExerciseIcon,
    matchPattern: '^/lms/apprenticeship/tasks(/.*)?$'
  },
  {
    titleKey: 'Reviews',
    path: `${APPRENTICE_BASE}/reviews`,
    icon: ReviewIcon,
    matchPattern: '^/lms/apprenticeship/reviews(/.*)?$'
  },
  {
    titleKey: 'Off-the-job',
    path: `${APPRENTICE_BASE}/otj`,
    icon: ChartColumnIcon,
    matchPattern: '^/lms/apprenticeship/otj(/.*)?$'
  },
  {
    titleKey: 'Gateway',
    path: `${APPRENTICE_BASE}/gateway`,
    icon: GoalIcon,
    matchPattern: '^/lms/apprenticeship/gateway(/.*)?$'
  },
  {
    // Not under /lms — absolute link (see getLmsNavigationItems).
    titleKey: 'Messages',
    path: '/messages',
    icon: NewsFeedIcon,
    matchPattern: '^/messages(/.*)?$'
  },
  {
    titleKey: 'My courses',
    path: '/mylearning',
    icon: CourseIcon,
    matchPattern: '^/lms/mylearning(/.*)?$',
    // Only for apprentices who also have course enrolments (the same enrolled-courses list the course dashboard uses).
    show: () => apprenticeShell.hasCourses === true
  },
  {
    titleKey: 'lms_navigation.settings',
    path: '/settings/notifications',
    icon: SettingsIcon,
    matchPattern: '^/lms/settings(/.*)?$'
  }
];

/** The nav config in force: the apprentice shell for learners with an apprenticeship, else the standard learner one. */
export function getActiveLmsNavConfig(): NavItemConfig[] {
  return myApprenticeshipApi.hasAny ? apprenticeNavConfig : baseNavConfig;
}

/** Messages lives outside /lms; every other config path is under it. */
export function lmsUrlFor(path: string): string {
  if (path === '') return '/lms';
  return path === '/messages' ? path : `/lms${path}`;
}

/**
 * Get LMS navigation items based on organization context
 */
export function getLmsNavigationItems(
  currentOrg: AccountOrg | null,
  t: (key: string) => string,
  pagePathname: string
): NavItem[] {
  const items: NavItem[] = [];

  for (const config of getActiveLmsNavConfig()) {
    // Skip items that should be hidden based on customization
    if (config.show && !config.show(currentOrg)) {
      continue;
    }

    const url = lmsUrlFor(config.path);
    const fullPath = url;

    const item: NavItem = {
      title: t(config.titleKey),
      url: config.useHashUrl ? '#' : url,
      path: config.path,
      icon: config.icon,
      isActive: isActive(pagePathname, fullPath, config.matchPattern),
      isExpanded: config.items ? isActive(pagePathname, fullPath, config.matchPattern) : undefined,
      badge: config.badge?.() ?? null,
      useHashUrl: config.useHashUrl,
      nestedRoutes: config.nestedRoutes,
      supportsDynamicSegment: config.supportsDynamicSegment,
      show: config.show ? () => config.show!(currentOrg) : undefined
    };

    // Handle nested items (like settings sub-items)
    if (config.items) {
      item.items = config.items.map((subConfig) => ({
        title: t(`settings.tabs.${subConfig.titleKey.toLowerCase()}_tab`) || subConfig.titleKey,
        url: `/lms${subConfig.path}`,
        path: subConfig.path
      }));
    }

    items.push(item);
  }

  return items;
}
