<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  import { UpgradeModal, PageLoadProgress, PageRestricted } from '$features/ui';
  import ImpersonationBanner from '$features/ui/impersonation-banner.svelte';
  import { VerifyEmailModal } from '$features/onboarding/components';
  import { CommandPalette, KeyboardShortcutListener } from '$features/search';
  import { isPublicRoute } from '$lib/utils/functions/routes/isPublicRoute';
  import { currentOrg } from '$lib/utils/store/org';
  import { authClient } from '$lib/utils/services/auth/client';
  import { classroomio } from '$lib/utils/services/api';
  import { profile } from '$lib/utils/store/user';
  import { needsPasswordChange, changePasswordUrl } from '$lib/utils/functions/routes/needsPasswordChange';
  import { readImpersonatingName } from '$lib/utils/functions/impersonation';
  import { Spinner } from '@cio/ui/base/spinner';
  import { appInitApi } from '$features/app/init.svelte';

  interface Props {
    children?: import('svelte').Snippet;
    data: {
      isOrgSite: boolean;
      orgSiteName: string;
      org: import('$features/app/types').AccountOrg | null;
      skipAuth: boolean;
      locals: App.Locals;
    };
  }

  let { children, data }: Props = $props();

  let path = $derived(page.url.pathname);

  const session = authClient.useSession();
  let authed = $derived(!!$session.data);

  // Live-presence heartbeat: while signed in, ping every 60s so "Online now" reflects real activity (the
  // panel counts sessions refreshed within 5 minutes). Best-effort — failures are ignored.
  // Paused while the tab is hidden (saves requests); pings once when it becomes visible again.
  onMount(() => {
    const HEARTBEAT_MS = 60_000;
    const ping = () => {
      if (authed && !document.hidden) void classroomio.account.heartbeat.$post().catch(() => {});
    };
    ping();
    const timer = setInterval(ping, HEARTBEAT_MS);
    const onVisible = () => {
      if (!document.hidden) ping();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  });

  // First-login password change: while an admin-provisioned account still has its temporary password, every app
  // page is replaced by a spinner and sent to /change-password (the requested page is kept as ?redirect=). Reactive,
  // so it also catches client-side navigation and typed URLs. Skipped while an admin is impersonating ("Login As").
  let impersonating = $state(false);
  onMount(() => {
    impersonating = !!readImpersonatingName();
  });
  let mustChangePassword = $derived(authed && !impersonating && needsPasswordChange($profile, path));
  // While the signed-in account is still loading we don't know the flag yet: show the spinner instead of an empty
  // shell (prevents a brief flash of the dashboard before the password page). `loading` always ends, so no hang.
  // Covers the whole gap: session still resolving after login, and /account not yet loaded. Safety net: after 10s the
  // page renders anyway, so a stalled load can never leave anyone stuck on a spinner.
  let gateTimedOut = $state(false);
  onMount(() => {
    const t = setTimeout(() => (gateTimedOut = true), 10_000);
    return () => clearTimeout(t);
  });
  let accountLoading = $derived(
    !gateTimedOut &&
      !data.skipAuth &&
      !isPublicRoute(path) &&
      ($session.isPending || (authed && !appInitApi.isInitializedAndReady && !appInitApi.error))
  );
  $effect(() => {
    if (mustChangePassword) goto(changePasswordUrl(path + page.url.search), { replaceState: true });
  });

  $effect(() => {
    if ($session.isPending || $session.isRefetching || !!$session.data) {
      return;
    }

    if (data.skipAuth) return;

    if (isPublicRoute(path) && (path !== '/' || data.isOrgSite)) {
      return;
    }

    if (!$session.data && !path.startsWith('/login')) {
      window.location.href = '/login';
    }
  });
</script>

<UpgradeModal />
<VerifyEmailModal />
<ImpersonationBanner />
<CommandPalette />
<KeyboardShortcutListener />

{#if data.org?.isRestricted || $currentOrg.isRestricted}
  <PageRestricted />
{:else if mustChangePassword || accountLoading}
  <div class="flex min-h-dvh items-center justify-center"><Spinner /></div>
{:else}
  <PageLoadProgress zIndex={10000} />

  {@render children?.()}
{/if}
