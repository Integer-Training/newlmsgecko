<script lang="ts">
  import { page as appPage } from '$app/state';
  import * as Page from '@cio/ui/base/page';
  import { Button } from '@cio/ui/base/button';
  import { Skeleton } from '@cio/ui/base/skeleton';
  import { Empty } from '@cio/ui/custom/empty';
  import { snackbar } from '$features/ui/snackbar/store';
  import { currentOrg } from '$lib/utils/store/org';
  import { apprenticeshipsBase } from '../utils/paths';
  import { apprIqaApi, type IqaSample } from '../api/iqa.svelte';
  import EvidenceStatusChip from '../components/shared/evidence-status-chip.svelte';
  import IqaOutcomeChip from '../components/shared/iqa-outcome-chip.svelte';
  import { fmtDate } from '../components/shared/format';

  // Gecko Apprenticeships — a tutor's IQA feedback: the samples of evidence they assessed. Decided ones carry the
  // internal quality assurer's outcome and feedback and are acknowledged here; undecided ones show as "Being reviewed".
  // The API only ever returns the signed-in tutor's own samples.

  let samples = $state<IqaSample[] | null>(null);
  let error = $state<string | null>(null);
  let acknowledging = $state<string | null>(null);
  let reload = $state(0);

  const base = $derived(apprenticeshipsBase(appPage.url.pathname, $currentOrg.siteName));
  // Feedback still to acknowledge first, then the rest newest first.
  const rows = $derived(
    [...(samples ?? [])].sort((a, b) => {
      const need = (s: IqaSample) => (s.outcome !== 'PENDING' && !s.acknowledgedAt ? 0 : 1);
      return need(a) - need(b) || b.createdAt.localeCompare(a.createdAt);
    })
  );

  $effect(() => {
    reload;
    apprIqaApi.samples().then((res) => {
      if (res.ok) {
        samples = res.data;
        error = null;
      } else {
        error = res.error;
      }
    });
  });

  async function acknowledge(row: IqaSample) {
    if (!row.id || !row.decidedAt) return;
    acknowledging = row.id;
    const res = await apprIqaApi.acknowledge(row.id, row.decidedAt);
    acknowledging = null;
    if (res.ok) {
      snackbar.success('Feedback acknowledged.');
    } else {
      snackbar.error(res.error);
    }
    reload += 1; // on a 409 the decision changed since it was shown: reload shows the current one
  }
</script>

<svelte:head>
  <title>IQA feedback — Apprenticeships</title>
</svelte:head>

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      <Page.Title>IQA feedback</Page.Title>
      <Page.Subtitle>Quality assurance checks on evidence you assessed</Page.Subtitle>
    </Page.HeaderContent>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      {#if error && !samples}
        <div class="rounded-lg border border-rose-200 p-6 text-center">
          <p role="alert" class="text-sm text-rose-600">{error}</p>
          <Button variant="outline" size="sm" class="mt-3" onclick={() => (reload += 1)}>Try again</Button>
        </div>
      {:else if !samples}
        <div class="space-y-2" role="status" aria-label="Loading IQA feedback">
          {#each Array(4) as _, i (i)}<Skeleton class="h-20 w-full" />{/each}
        </div>
      {:else if rows.length === 0}
        <Empty title="No IQA feedback" description="When someone samples evidence you assessed, it appears here." />
      {:else}
        <ul class="space-y-3">
          {#each rows as s (s.id)}
            <li class="rounded-lg border p-4">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="font-medium">{s.evidenceTitle}</p>
                  <p class="text-sm text-(--muted-foreground)">{s.learnerName ?? 'Learner'} · {s.programmeTitle}</p>
                </div>
                <div class="flex items-center gap-2">
                  <EvidenceStatusChip status={s.evidenceStatus} />
                  <IqaOutcomeChip outcome={s.outcome} pendingLabel="Being reviewed" />
                </div>
              </div>

              {#if s.outcome !== 'PENDING'}
                {#if s.feedback}
                  <p class="mt-3 text-sm whitespace-pre-wrap">{s.feedback}</p>
                {:else}
                  <p class="mt-3 text-sm text-(--muted-foreground)">No written feedback.</p>
                {/if}
                <p class="mt-1 text-xs text-(--muted-foreground)">
                  {s.decidedByName ?? 'IQA'} · {fmtDate(s.decidedAt)}
                </p>
              {:else}
                <p class="mt-3 text-sm text-(--muted-foreground)">Sampled {fmtDate(s.createdAt)}. No outcome yet.</p>
              {/if}

              <div class="mt-3 flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" href="{base}/learners/{s.enrolmentId}?evidence={s.evidenceId}"
                  >Open evidence</Button
                >
                {#if s.outcome !== 'PENDING'}
                  {#if s.acknowledgedAt}
                    <span class="text-xs text-(--muted-foreground)">Acknowledged {fmtDate(s.acknowledgedAt)}</span>
                  {:else}
                    <Button
                      size="sm"
                      loading={acknowledging === s.id}
                      disabled={!!acknowledging}
                      onclick={() => acknowledge(s)}>Acknowledge</Button
                    >
                  {/if}
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    {/snippet}
  </Page.Body>
</Page.Root>
