<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import * as Page from '@cio/ui/base/page';
  import { Button } from '@cio/ui/base/button';
  import { Skeleton } from '@cio/ui/base/skeleton';
  import { evidenceApi, type EvidenceNote } from '../api/evidence.svelte';
  import { tutorNames } from '../api/enrolments.svelte';
  import { apprenticeShell } from '../api/apprentice-shell.svelte';
  import { PortfolioStore } from '../stores/portfolio.svelte';
  import ProgressBar from '../components/shared/progress-bar.svelte';
  import StatusChip from '../components/shared/status-chip.svelte';
  import StageChip from '../components/shared/stage-chip.svelte';
  import { fmtDate, fmtMinutes, fmtPct } from '../components/shared/format';

  interface Props {
    enrolmentId: string;
  }
  let { enrolmentId }: Props = $props();

  // svelte-ignore state_referenced_locally
  const store = new PortfolioStore(enrolmentId);
  const BASE = '/lms/apprenticeship';

  onMount(() => {
    store.load();
    void apprenticeShell.refreshOnboardingBadge(enrolmentId);
  });

  const d = $derived(store.data);
  const onboarding = $derived(
    apprenticeShell.onboarding?.enrolmentId === enrolmentId ? apprenticeShell.onboarding : null
  );

  // Open tasks, overdue first then by due date (no due date last).
  const dueTasks = $derived(
    store.tasks
      .filter((t) => t.status !== 'COMPLETE')
      .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'))
      .slice(0, 5)
  );
  const referred = $derived(store.evidence.filter((e) => e.status === 'REFERRED'));

  // Latest feedback: the newest note on the most recently created reviewed (accepted / referred) evidence.
  let feedback = $state<{ title: string; note: EvidenceNote } | null>(null);
  $effect(() => {
    const latest = [...store.evidence]
      .filter((e) => e.status !== 'SUBMITTED')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!latest) {
      feedback = null;
      return;
    }
    let cancelled = false;
    evidenceApi.detail(latest.id).then((res) => {
      if (cancelled || !res.ok) return;
      const note = [...res.data.notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      feedback = note ? { title: latest.title, note } : null;
    });
    return () => {
      cancelled = true;
    };
  });

  const otjPct = $derived(
    d?.summary.otj.targetMinutes ? Math.floor((d.summary.otj.minutes / d.summary.otj.targetMinutes) * 100) : null
  );
  const tutor = $derived(d ? tutorNames(d.tutors) : '—');
  const hasTutor = $derived(tutor !== '—');

  const card = 'space-y-2 rounded-lg border bg-(--card) p-4';
  const link = 'text-sm text-(--primary) hover:underline';
</script>

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      <Page.Title>My apprenticeship</Page.Title>
    </Page.HeaderContent>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      {#if store.loading}
        <div class="grid gap-4 md:grid-cols-2" role="status" aria-label="Loading">
          <Skeleton class="h-32 w-full" />
          <Skeleton class="h-32 w-full" />
          <Skeleton class="h-40 w-full" />
          <Skeleton class="h-40 w-full" />
        </div>
      {:else if store.error && !d}
        <div class="rounded-lg border border-rose-200 p-6 text-center">
          <p role="alert" class="text-sm text-rose-600">{store.error}</p>
          <Button variant="outline" size="sm" class="mt-3" onclick={() => store.load()}>Try again</Button>
        </div>
      {:else if d}
        <div class="space-y-4">
          <div>
            <h2 class="text-xl font-semibold">{d.programme.title}</h2>
            <p class="text-sm text-(--muted-foreground)">
              {fmtDate(d.enrolment.startDate)} → {fmtDate(d.enrolment.plannedEndDate)}
            </p>
          </div>

          <div class="grid gap-4 md:grid-cols-2">
            <!-- (a) Onboarding first, while it is incomplete -->
            {#if onboarding && !onboarding.complete}
              <section class="{card} md:col-span-2" aria-label="Onboarding">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 class="font-semibold">Complete your onboarding</h3>
                    <p class="text-sm text-(--muted-foreground)">
                      {onboarding.approved} of {onboarding.required} documents approved
                      {#if onboarding.rejected > 0}
                        <span class="ml-1 font-medium text-rose-600">· {onboarding.rejected} need fixing</span>
                      {/if}
                    </p>
                  </div>
                  <Button size="sm" href="{BASE}/onboarding">Go to onboarding</Button>
                </div>
                <ProgressBar
                  actual={onboarding.required ? Math.floor((onboarding.approved / onboarding.required) * 100) : null}
                  label="Onboarding documents approved"
                />
              </section>
            {/if}

            <!-- (b) Overall progress -->
            <section class={card} aria-label="Progress">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="font-semibold">Progress</h3>
                <StatusChip status={d.summary.status} />
                <StageChip stage={d.summary.stage} label={d.summary.stageLabel} />
              </div>
              <div class="flex justify-between text-sm">
                <span>{fmtPct(d.summary.actualPct)}</span>
                <span class="text-(--muted-foreground)">expected {fmtPct(d.summary.expectedPct)}</span>
              </div>
              <ProgressBar
                actual={d.summary.actualPct}
                expected={d.summary.expectedPct}
                label="Qualification progress"
              />
              <a class={link} href="{BASE}/units">Units &amp; criteria</a>
            </section>

            <!-- (c) Off-the-job hours -->
            <section class={card} aria-label="Off-the-job hours">
              <h3 class="font-semibold">Off-the-job hours</h3>
              <div class="flex justify-between text-sm">
                <span>{fmtMinutes(d.summary.otj.minutes)} of {fmtMinutes(d.summary.otj.targetMinutes)}</span>
                <span class="text-(--muted-foreground)">expected {fmtMinutes(d.summary.otj.expectedMinutes)}</span>
              </div>
              <ProgressBar
                actual={otjPct}
                expected={d.summary.otj.targetMinutes && d.summary.otj.expectedMinutes !== null
                  ? Math.round((d.summary.otj.expectedMinutes / d.summary.otj.targetMinutes) * 100)
                  : null}
                label="Off-the-job hours"
              />
              <a class={link} href="{BASE}/otj">Off-the-job</a>
            </section>

            <!-- (d) Tasks due soon / overdue -->
            <section class={card} aria-label="Tasks">
              <div class="flex items-center justify-between">
                <h3 class="font-semibold">Tasks</h3>
                {#if store.overdueTaskCount > 0}
                  <span class="rounded-full bg-rose-600 px-2 text-xs font-medium text-white">
                    {store.overdueTaskCount} overdue
                  </span>
                {/if}
              </div>
              {#if dueTasks.length === 0}
                <p class="text-sm text-(--muted-foreground)">Nothing due right now.</p>
              {:else}
                <ul class="divide-y text-sm">
                  {#each dueTasks as t (t.id)}
                    <li class="flex items-center justify-between gap-2 py-1.5">
                      <span class="truncate">{t.title}</span>
                      <span class="shrink-0 {t.overdue ? 'font-medium text-rose-600' : 'text-(--muted-foreground)'}">
                        {t.overdue ? 'Overdue · ' : ''}{fmtDate(t.dueDate)}
                      </span>
                    </li>
                  {/each}
                </ul>
              {/if}
              <a class={link} href="{BASE}/tasks">All tasks</a>
            </section>

            <!-- (e) Next review -->
            <section class={card} aria-label="Next review">
              <h3 class="font-semibold">Next review</h3>
              {#if store.nextReview}
                <p class="text-sm">
                  <strong>{fmtDate(store.nextReview.scheduledDate)}</strong>
                  {#if store.nextReview.overdue}
                    <span class="ml-1 font-medium text-rose-600">· Overdue</span>
                  {/if}
                </p>
              {:else}
                <p class="text-sm text-(--muted-foreground)">No review scheduled yet.</p>
              {/if}
              <a class={link} href="{BASE}/reviews">Reviews</a>
            </section>

            <!-- (f) Evidence referred back -->
            <section class={card} aria-label="Evidence to fix">
              <div class="flex items-center justify-between">
                <h3 class="font-semibold">Evidence to fix</h3>
                {#if referred.length > 0}
                  <span
                    class="rounded-full bg-rose-100 px-2 text-xs font-medium text-rose-800 dark:bg-rose-500/20 dark:text-rose-300"
                  >
                    {referred.length} referred back
                  </span>
                {/if}
              </div>
              {#if referred.length === 0}
                <p class="text-sm text-(--muted-foreground)">Nothing has been referred back to you.</p>
              {:else}
                <ul class="divide-y text-sm">
                  {#each referred.slice(0, 3) as e (e.id)}
                    <li class="truncate py-1.5">
                      <button
                        type="button"
                        class="truncate text-left hover:underline"
                        onclick={() => store.openEvidence(e.id)}
                      >
                        {e.title}
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
              <a class={link} href="{BASE}/evidence">All evidence</a>
            </section>

            <!-- (g) Latest feedback -->
            <section class={card} aria-label="Latest feedback">
              <h3 class="font-semibold">Latest feedback</h3>
              {#if feedback}
                <p class="line-clamp-4 text-sm whitespace-pre-line">{feedback.note.body}</p>
                <p class="text-xs text-(--muted-foreground)">
                  {feedback.note.authorName ?? 'Your tutor'} on “{feedback.title}” · {fmtDate(feedback.note.createdAt)}
                </p>
              {:else}
                <p class="text-sm text-(--muted-foreground)">No feedback on your evidence yet.</p>
              {/if}
            </section>

            <!-- (h) Tutor -->
            <section class={card} aria-label="Your tutor">
              <h3 class="font-semibold">Your tutor</h3>
              {#if hasTutor}
                <p class="text-sm">{tutor}</p>
                <Button size="sm" variant="outline" onclick={() => goto('/messages')}>Message</Button>
              {:else}
                <p class="text-sm text-(--muted-foreground)">No tutor assigned yet.</p>
              {/if}
            </section>
          </div>
        </div>
      {/if}
    {/snippet}
  </Page.Body>
</Page.Root>
