<script lang="ts">
  import { onMount } from 'svelte';
  import { page as appPage } from '$app/state';
  import * as Page from '@cio/ui/base/page';
  import * as Select from '@cio/ui/base/select';
  import * as Table from '@cio/ui/base/table';
  import { Button } from '@cio/ui/base/button';
  import { Skeleton } from '@cio/ui/base/skeleton';
  import { Empty } from '@cio/ui/custom/empty';
  import { APPR_PROGRESS_STATUSES, type ApprProgressStatus } from '@cio/utils/constants/apprenticeship';
  import { currentOrg, isOrgAdmin } from '$lib/utils/store/org';
  import { apprenticeshipsBase } from '../utils/paths';
  import { enrolmentsApi } from '../api/enrolments.svelte';
  import { apprSummaryApi, type ApprSummary } from '../api/summary.svelte';
  import { fmtDate, fmtMinutes, STATUS_CLASS, STATUS_LABEL } from '../components/shared/format';

  // Gecko Apprenticeships — the summary dashboard. Counts only, all computed by the API: an admin sees the whole
  // organisation, a tutor only their own learners. Each card links to the screen where the work gets done.

  const OVERDUE_SHOWN = 10;

  let programmeId = $state('');
  let data = $state<ApprSummary | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let reload = $state(0);
  let reqId = 0;

  const base = $derived(apprenticeshipsBase(appPage.url.pathname, $currentOrg.siteName));
  const programmeLabel = $derived(
    programmeId ? (enrolmentsApi.programmes.find((p) => p.id === programmeId)?.title ?? 'Programme') : 'All programmes'
  );

  onMount(() => {
    enrolmentsApi.loadOptions($isOrgAdmin === true);
  });

  $effect(() => {
    const pid = programmeId;
    reload;
    const id = ++reqId;
    apprSummaryApi.get(pid || undefined).then((res) => {
      if (id !== reqId) return;
      loading = false;
      if (res.ok) {
        data = res.data;
        error = null;
      } else {
        error = res.error;
      }
    });
  });

  const overdueTasks = $derived(data?.tasks.overdueList.slice(0, OVERDUE_SHOWN) ?? []);
  const learnerTotal = $derived(data?.learners.total ?? 0);
  const otjStatuses = APPR_PROGRESS_STATUSES.filter((s) => s !== 'COMPLETE');
  const otjPct = $derived(
    data && data.otj.minutesTarget > 0
      ? Math.min(100, Math.round((data.otj.minutesDone / data.otj.minutesTarget) * 100))
      : 0
  );

  // Segment colours for the stacked bars; same hues as the status chips.
  const BAR_CLASS: Record<ApprProgressStatus, string> = {
    ON_TARGET: 'bg-emerald-500',
    BEHIND: 'bg-amber-500',
    CONCERN: 'bg-rose-500',
    NOT_SET: 'bg-slate-400',
    COMPLETE: 'bg-sky-500'
  };

  const cardClass = 'rounded-lg border p-4';
  const linkClass = 'text-sm text-(--primary) hover:underline';
  const warnTone = 'text-amber-700 dark:text-amber-300';
</script>

<svelte:head>
  <title>Apprenticeship summary — {$currentOrg.name}</title>
</svelte:head>

{#snippet statusBar(
  counts: Partial<Record<ApprProgressStatus, number>>,
  order: readonly ApprProgressStatus[],
  label: string
)}
  {@const total = order.reduce((n, s) => n + (counts[s] ?? 0), 0)}
  {#if total > 0}
    <div class="flex h-3 w-full overflow-hidden rounded-full bg-(--muted)" role="img" aria-label={label}>
      {#each order as s (s)}
        {#if (counts[s] ?? 0) > 0}
          <div class={BAR_CLASS[s]} style="width: {((counts[s] ?? 0) / total) * 100}%"></div>
        {/if}
      {/each}
    </div>
  {/if}
  <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
    {#each order as s (s)}
      <div class="rounded-md px-3 py-2 {STATUS_CLASS[s]}">
        <p class="text-xl font-semibold">{counts[s] ?? 0}</p>
        <p class="text-xs">{STATUS_LABEL(s)}</p>
      </div>
    {/each}
  </div>
{/snippet}

{#snippet stat(value: number, label: string, href?: string, tone = '')}
  <div class={cardClass}>
    <p class="text-2xl font-semibold {tone}">{value}</p>
    <p class="text-sm text-(--muted-foreground)">{label}</p>
    {#if href}<a class="{linkClass} mt-1 inline-block" {href}>View</a>{/if}
  </div>
{/snippet}

{#snippet figures(items: [string, number][])}
  <div class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
    {#each items as [label, n] (label)}
      <div>
        <p class="text-xl font-semibold">{n}</p>
        <p class="text-sm text-(--muted-foreground)">{label}</p>
      </div>
    {/each}
  </div>
{/snippet}

{#snippet reviewList(items: ApprSummary['reviews']['overdue'], total: number, empty: string)}
  {#if items.length === 0}
    <p class="text-sm text-(--muted-foreground)">{empty}</p>
  {:else}
    <ul class="divide-y">
      {#each items as r (r.reviewId)}
        <li class="flex items-center justify-between gap-3 py-2">
          <div class="min-w-0">
            <a class="font-medium hover:underline" href="{base}/learners/{r.enrolmentId}?tab=reviews"
              >{r.learnerName ?? 'Learner'}</a
            >
            <p class="truncate text-xs text-(--muted-foreground)">{r.programmeTitle}</p>
          </div>
          <span class="text-sm whitespace-nowrap">{fmtDate(r.dueDate)}</span>
        </li>
      {/each}
    </ul>
    {#if total > items.length}
      <p class="mt-2 text-xs text-(--muted-foreground)">Showing {items.length} of {total}.</p>
    {/if}
  {/if}
{/snippet}

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      <Page.Title>Summary</Page.Title>
      <Page.Subtitle>
        {$isOrgAdmin ? `Everything across ${$currentOrg.name}` : 'Your allocated apprentices'}
      </Page.Subtitle>
    </Page.HeaderContent>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      <div class="mb-4 flex flex-col gap-1">
        <span class="text-xs text-(--muted-foreground)" id="sm-prog">Programme</span>
        <Select.Root type="single" bind:value={programmeId}>
          <Select.Trigger class="ui:w-fit min-w-[220px]" aria-labelledby="sm-prog"
            ><p class="truncate">{programmeLabel}</p></Select.Trigger
          >
          <Select.Content>
            <Select.Item value="">All programmes</Select.Item>
            {#each enrolmentsApi.programmes as p (p.id)}
              <Select.Item value={p.id}>{p.title}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>

      {#if loading}
        <div class="space-y-3" role="status" aria-label="Loading the summary">
          {#each Array(4) as _, i (i)}<Skeleton class="h-24 w-full" />{/each}
        </div>
      {:else if error && !data}
        <div class="rounded-lg border border-rose-200 p-6 text-center">
          <p role="alert" class="text-sm text-rose-600">{error}</p>
          <Button variant="outline" size="sm" class="mt-3" onclick={() => (reload += 1)}>Try again</Button>
        </div>
      {:else if data && learnerTotal === 0}
        <Empty
          title="No apprentices yet"
          description={$isOrgAdmin
            ? 'Add a learner to start tracking progress.'
            : 'Apprentices allocated to you will appear here.'}
        />
      {:else if data}
        <div class="space-y-4">
          <section class={cardClass} aria-labelledby="sm-learners">
            <div class="flex items-baseline justify-between">
              <h2 id="sm-learners" class="font-medium">Learners · {learnerTotal}</h2>
              <a class={linkClass} href={base}>All learners</a>
            </div>
            <div class="mt-3">
              {@render statusBar(data.learners.byStatus, APPR_PROGRESS_STATUSES, 'Learners by status')}
            </div>
          </section>

          <section class={cardClass} aria-labelledby="sm-otj">
            <h2 id="sm-otj" class="font-medium">Off-the-job hours</h2>
            <p class="mt-1 text-sm text-(--muted-foreground)">
              {fmtMinutes(data.otj.minutesDone)} done of {fmtMinutes(data.otj.minutesTarget)} target{data.otj
                .minutesTarget > 0
                ? ` (${otjPct}%)`
                : ''}
            </p>
            <div class="mt-3">{@render statusBar(data.otj.byStatus, otjStatuses, 'Off-the-job hours by status')}</div>
          </section>

          <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
            {@render stat(data.toMark, 'Evidence to mark', `${base}/to-mark`, data.toMark > 0 ? warnTone : '')}
            {#if $isOrgAdmin}
              {@render stat(data.onboardingIncomplete, 'Onboarding incomplete', `${base}?onboarding=incomplete`)}
              {@render stat(data.iqa.pending, 'IQA samples pending', `${base}/iqa`)}
            {:else}
              {@render stat(
                data.iqa.awaitingAck,
                'IQA feedback to acknowledge',
                `${base}/iqa`,
                data.iqa.awaitingAck > 0 ? warnTone : ''
              )}
            {/if}
            {@render stat(
              data.tasks.overdue,
              'Overdue tasks',
              undefined,
              data.tasks.overdue > 0 ? 'text-rose-700 dark:text-rose-300' : ''
            )}
          </div>

          <section class={cardClass} aria-labelledby="sm-gateway">
            <h2 id="sm-gateway" class="font-medium">Gateway &amp; EPA</h2>
            {@render figures([
              ['Ready for gateway', data.gateway.ready],
              ['At gateway', data.gateway.atGateway],
              ['EPA booked', data.gateway.epaBooked],
              ['Achieved', data.gateway.achieved],
              ['EPA not passed', data.gateway.epaFailed]
            ])}
          </section>

          <div class="grid gap-3 md:grid-cols-2">
            <section class={cardClass} aria-labelledby="sm-evidence">
              <h2 id="sm-evidence" class="font-medium">Evidence</h2>
              {@render figures([
                ['Submitted', data.evidence.SUBMITTED],
                ['Accepted', data.evidence.ACCEPTED],
                ['Referred', data.evidence.REFERRED]
              ])}
            </section>
            <section class={cardClass} aria-labelledby="sm-tasks">
              <h2 id="sm-tasks" class="font-medium">Tasks</h2>
              {@render figures([
                ['Planned', data.tasks.byStatus.PLANNED],
                ['Submitted', data.tasks.byStatus.SUBMITTED],
                ['Referred', data.tasks.byStatus.REFERRED],
                ['Complete', data.tasks.byStatus.COMPLETE]
              ])}
            </section>
          </div>

          <section class={cardClass} aria-labelledby="sm-overdue">
            <div class="flex items-baseline justify-between">
              <h2 id="sm-overdue" class="font-medium">Overdue tasks · {data.tasks.overdue}</h2>
              {#if data.tasks.overdue > OVERDUE_SHOWN}
                <a class={linkClass} href={base}>View all learners</a>
              {/if}
            </div>
            {#if overdueTasks.length === 0}
              <p class="mt-2 text-sm text-(--muted-foreground)">No overdue tasks.</p>
            {:else}
              <div class="mt-3 overflow-x-auto rounded-lg border">
                <Table.Root>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Learner</Table.Head>
                      <Table.Head>Task</Table.Head>
                      <Table.Head>Programme</Table.Head>
                      <Table.Head>Due</Table.Head>
                      <Table.Head class="text-right">Overdue</Table.Head>
                      <Table.Head><span class="sr-only">Actions</span></Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {#each overdueTasks as t (t.taskId)}
                      <Table.Row>
                        <Table.Cell class="font-medium">{t.learnerName ?? '—'}</Table.Cell>
                        <Table.Cell class="max-w-72 break-words whitespace-normal!">{t.title}</Table.Cell>
                        <Table.Cell>{t.programmeTitle}</Table.Cell>
                        <Table.Cell class="whitespace-nowrap">{fmtDate(t.dueDate)}</Table.Cell>
                        <Table.Cell class="text-right whitespace-nowrap text-rose-700 dark:text-rose-300"
                          >{t.daysOverdue} day{t.daysOverdue === 1 ? '' : 's'}</Table.Cell
                        >
                        <Table.Cell>
                          <Button
                            variant="outline"
                            size="sm"
                            href="{base}/learners/{t.enrolmentId}?tab=tasks"
                            aria-label="Open tasks for {t.learnerName ?? 'learner'}">Open</Button
                          >
                        </Table.Cell>
                      </Table.Row>
                    {/each}
                  </Table.Body>
                </Table.Root>
              </div>
            {/if}
          </section>

          <div class="grid gap-3 md:grid-cols-2">
            <section class={cardClass} aria-labelledby="sm-rev-over">
              <h2 id="sm-rev-over" class="mb-2 font-medium">Overdue reviews · {data.reviews.overdueTotal}</h2>
              {@render reviewList(data.reviews.overdue, data.reviews.overdueTotal, 'No overdue reviews.')}
            </section>
            <section class={cardClass} aria-labelledby="sm-rev-up">
              <h2 id="sm-rev-up" class="mb-2 font-medium">Upcoming reviews (14 days) · {data.reviews.upcomingTotal}</h2>
              {@render reviewList(
                data.reviews.upcoming,
                data.reviews.upcomingTotal,
                'No reviews due in the next 14 days.'
              )}
            </section>
          </div>
        </div>
      {/if}
    {/snippet}
  </Page.Body>
</Page.Root>
