<script lang="ts">
  import { onMount } from 'svelte';
  import { page as appPage } from '$app/state';
  import * as Page from '@cio/ui/base/page';
  import * as Select from '@cio/ui/base/select';
  import * as Table from '@cio/ui/base/table';
  import * as Dialog from '@cio/ui/base/dialog';
  import * as Sheet from '@cio/ui/base/sheet';
  import * as RadioGroup from '@cio/ui/base/radio-group';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Textarea } from '@cio/ui/base/textarea';
  import { Skeleton } from '@cio/ui/base/skeleton';
  import { Empty } from '@cio/ui/custom/empty';
  import {
    APPR_IQA_FEEDBACK_MAX,
    APPR_IQA_OUTCOMES,
    APPR_IQA_OUTCOME_LABELS
  } from '@cio/utils/constants/apprenticeship';
  import { snackbar } from '$features/ui/snackbar/store';
  import { currentOrg } from '$lib/utils/store/org';
  import { apprenticeshipsBase } from '../utils/paths';
  import { enrolmentsApi } from '../api/enrolments.svelte';
  import { apprIqaApi, type IqaCoverage, type IqaOutcome, type IqaSample } from '../api/iqa.svelte';
  import EvidenceStatusChip from '../components/shared/evidence-status-chip.svelte';
  import IqaOutcomeChip from '../components/shared/iqa-outcome-chip.svelte';
  import { fmtDate } from '../components/shared/format';

  // Gecko Apprenticeships — IQA sampling (admin). Coverage per assessor and unit against the sampling target, a
  // "Suggest sample" flow (preview → confirm) and the list of samples with the agree / disagree review.
  // A disagree never changes the evidence status; the evidence is referred separately from the portfolio.

  let programmeId = $state('');
  let assessorId = $state('');
  let outcome = $state<IqaOutcome | ''>('');
  let coverage = $state<IqaCoverage | null>(null);
  let samples = $state<IqaSample[] | null>(null);
  let error = $state<string | null>(null);
  let reload = $state(0);
  let reqId = 0;

  // Target editor
  let targetInput = $state<number | string>('');
  let loadedTarget: number | null = null;
  let savingTarget = $state(false);

  // Suggest dialog
  let suggestOpen = $state(false);
  let suggestLoading = $state(false);
  let suggestError = $state<string | null>(null);
  let picks = $state<IqaSample[]>([]);
  let confirming = $state(false);

  // Review sheet
  let sheetOpen = $state(false);
  let reviewing = $state<IqaSample | null>(null);
  let decision = $state<'AGREE' | 'DISAGREE' | ''>('');
  let feedback = $state('');
  let saving = $state(false);
  let reviewError = $state<string | null>(null);
  let removing = $state(false);

  const base = $derived(apprenticeshipsBase(appPage.url.pathname, $currentOrg.siteName));
  const programmeLabel = $derived(
    programmeId ? (enrolmentsApi.programmes.find((p) => p.id === programmeId)?.title ?? 'Programme') : 'All programmes'
  );
  const assessorLabel = $derived(
    assessorId ? (coverage?.assessors.find((a) => a.assessorId === assessorId)?.name ?? 'Assessor') : 'All assessors'
  );
  const outcomeLabel = $derived(outcome ? APPR_IQA_OUTCOME_LABELS[outcome] : 'Any outcome');
  const targetPct = $derived(coverage?.targetPct ?? null);
  const targetNumber = $derived(Number(targetInput));
  const targetValid = $derived(Number.isInteger(targetNumber) && targetNumber >= 1 && targetNumber <= 100);
  const hasFilters = $derived(!!programmeId || !!assessorId || !!outcome);
  const canSave = $derived(!!decision && (decision !== 'DISAGREE' || feedback.trim().length > 0));

  onMount(() => {
    enrolmentsApi.loadOptions(true);
  });

  $effect(() => {
    const filters = {
      programmeId: programmeId || undefined,
      assessorId: assessorId || undefined,
      outcome: outcome || undefined
    };
    reload;
    const id = ++reqId;
    Promise.all([apprIqaApi.coverage(filters.programmeId), apprIqaApi.samples(filters)]).then(([c, s]) => {
      if (id !== reqId) return;
      if (c.ok && s.ok) {
        coverage = c.data;
        samples = s.data;
        // Keep a typed-but-unsaved target when only the filters changed.
        if (targetInput === '' || Number(targetInput) === loadedTarget) targetInput = c.data.targetPct;
        loadedTarget = c.data.targetPct;
        error = null;
      } else {
        error = (!c.ok && c.error) || (!s.ok && s.error) || 'Could not load IQA';
      }
    });
  });

  async function saveTarget() {
    if (!targetValid) return;
    savingTarget = true;
    const res = await apprIqaApi.setTarget(targetNumber);
    savingTarget = false;
    if (res.ok) {
      snackbar.success('Sampling target saved.');
      reload += 1;
    } else {
      snackbar.error(res.error);
    }
  }

  async function openSuggest() {
    suggestOpen = true;
    suggestLoading = true;
    suggestError = null;
    picks = [];
    const res = await apprIqaApi.suggest({
      programmeId: programmeId || undefined,
      assessorId: assessorId || undefined,
      preview: true
    });
    suggestLoading = false;
    if (res.ok) picks = res.data;
    else suggestError = res.error;
  }

  async function confirmSuggest() {
    confirming = true;
    const res = await apprIqaApi.suggest({
      programmeId: programmeId || undefined,
      assessorId: assessorId || undefined,
      preview: false,
      // Save exactly the previewed picks (the server re-checks each), not a fresh random draw.
      evidenceIds: picks.map((p) => p.evidenceId)
    });
    confirming = false;
    if (res.ok) {
      snackbar.success(`${res.data.length} sample${res.data.length === 1 ? '' : 's'} created.`);
      suggestOpen = false;
      reload += 1;
    } else {
      suggestError = res.error;
    }
  }

  function openReview(row: IqaSample) {
    reviewing = row;
    decision = row.outcome === 'PENDING' ? '' : row.outcome;
    feedback = row.feedback ?? '';
    reviewError = null;
    sheetOpen = true;
  }

  async function saveReview() {
    if (!reviewing?.id || !decision || !canSave) return;
    saving = true;
    reviewError = null;
    const res = await apprIqaApi.decide(reviewing.id, {
      outcome: decision,
      feedback: feedback.trim(),
      expectedOutcome: reviewing.outcome,
      expectedDecidedAt: reviewing.decidedAt
    });
    saving = false;
    if (res.ok) {
      snackbar.success('IQA outcome saved.');
      sheetOpen = false;
      reload += 1;
    } else {
      // 409: someone else decided it first — reload so the row shows what is now recorded.
      reviewError = res.error;
      if (/changed/i.test(res.error)) {
        snackbar.error('This sample was changed by someone else. Reloaded.');
        sheetOpen = false;
        reload += 1;
      }
    }
  }

  async function removeSample() {
    if (!reviewing?.id || reviewing.outcome !== 'PENDING') return;
    removing = true;
    const res = await apprIqaApi.remove(reviewing.id);
    removing = false;
    if (res.ok) {
      snackbar.success('Sample removed.');
      sheetOpen = false;
      reload += 1;
    } else {
      reviewError = res.error;
    }
  }

  function reset() {
    programmeId = '';
    assessorId = '';
    outcome = '';
  }

  const underTarget = (pct: number) => targetPct !== null && pct < targetPct;
  const chip = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';
</script>

<svelte:head>
  <title>IQA — Apprenticeships</title>
</svelte:head>

{#snippet pctCell(pct: number, accepted: number)}
  <span class="inline-flex items-center gap-2 whitespace-nowrap">
    {pct}%
    {#if accepted > 0 && underTarget(pct)}
      <span class="{chip} bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">Under {targetPct}%</span
      >
    {/if}
  </span>
{/snippet}

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      <Page.Title>IQA</Page.Title>
      <Page.Subtitle>Sample assessed evidence and check each assessor's decisions</Page.Subtitle>
    </Page.HeaderContent>
    <Page.Action>
      <Button onclick={openSuggest}>Suggest sample</Button>
    </Page.Action>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      <div class="mb-4 flex flex-wrap items-end gap-3">
        <div class="flex flex-col gap-1">
          <span class="text-xs text-(--muted-foreground)" id="iqa-prog">Programme</span>
          <Select.Root type="single" bind:value={programmeId}>
            <Select.Trigger class="min-w-[200px]" aria-labelledby="iqa-prog"
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
        <div class="flex flex-col gap-1">
          <span class="text-xs text-(--muted-foreground)" id="iqa-assessor">Assessor</span>
          <Select.Root type="single" bind:value={assessorId}>
            <Select.Trigger class="min-w-[180px]" aria-labelledby="iqa-assessor"
              ><p class="truncate">{assessorLabel}</p></Select.Trigger
            >
            <Select.Content>
              <Select.Item value="">All assessors</Select.Item>
              {#each coverage?.assessors ?? [] as a (a.assessorId)}
                <Select.Item value={a.assessorId}>{a.name ?? 'Assessor'}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-xs text-(--muted-foreground)" id="iqa-outcome">Outcome</span>
          <Select.Root type="single" bind:value={outcome}>
            <Select.Trigger class="min-w-[150px]" aria-labelledby="iqa-outcome"
              ><p class="truncate">{outcomeLabel}</p></Select.Trigger
            >
            <Select.Content>
              <Select.Item value="">Any outcome</Select.Item>
              {#each APPR_IQA_OUTCOMES as o (o)}
                <Select.Item value={o}>{APPR_IQA_OUTCOME_LABELS[o]}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        {#if hasFilters}
          <Button variant="ghost" onclick={reset}>Reset filters</Button>
        {/if}
      </div>

      {#if error && !coverage}
        <div class="rounded-lg border border-rose-200 p-6 text-center">
          <p role="alert" class="text-sm text-rose-600">{error}</p>
          <Button variant="outline" size="sm" class="mt-3" onclick={() => (reload += 1)}>Try again</Button>
        </div>
      {:else if !coverage || !samples}
        <div class="space-y-2" role="status" aria-label="Loading IQA">
          {#each Array(5) as _, i (i)}<Skeleton class="h-12 w-full" />{/each}
        </div>
      {:else}
        <div class="space-y-6">
          <section class="rounded-lg border p-4" aria-labelledby="iqa-target">
            <h2 id="iqa-target" class="font-medium">Sampling target</h2>
            <p class="mt-1 text-sm text-(--muted-foreground)">
              The share of each assessor's accepted evidence that should be sampled.
            </p>
            <form
              class="mt-3 flex items-end gap-2"
              onsubmit={(e) => {
                e.preventDefault();
                saveTarget();
              }}
            >
              <div class="flex flex-col gap-1">
                <label for="iqa-target-input" class="text-xs text-(--muted-foreground)">Target (%)</label>
                <Input
                  id="iqa-target-input"
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  class="w-28"
                  bind:value={targetInput}
                />
              </div>
              <Button
                type="submit"
                loading={savingTarget}
                disabled={!targetValid || savingTarget || targetNumber === targetPct}>Save</Button
              >
            </form>
            {#if !targetValid}
              <p role="alert" class="mt-1 text-xs text-rose-600">Enter a whole number from 1 to 100.</p>
            {/if}
          </section>

          <section aria-labelledby="iqa-assessors">
            <h2 id="iqa-assessors" class="mb-2 font-medium">Coverage by assessor</h2>
            {#if coverage.assessors.length === 0}
              <Empty title="No assessed evidence yet" description="Coverage appears once evidence has been accepted." />
            {:else}
              <div class="overflow-x-auto rounded-lg border">
                <Table.Root>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Assessor</Table.Head>
                      <Table.Head class="text-right">Accepted</Table.Head>
                      <Table.Head class="text-right">Sampled</Table.Head>
                      <Table.Head>Coverage</Table.Head>
                      <Table.Head class="text-right">Pending</Table.Head>
                      <Table.Head class="text-right">Agree</Table.Head>
                      <Table.Head class="text-right">Disagree</Table.Head>
                      <Table.Head class="text-right">Awaiting acknowledgement</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {#each coverage.assessors as a (a.assessorId)}
                      <Table.Row>
                        <Table.Cell class="font-medium">{a.name ?? '—'}</Table.Cell>
                        <Table.Cell class="text-right">{a.accepted}</Table.Cell>
                        <Table.Cell class="text-right">{a.sampled}</Table.Cell>
                        <Table.Cell>{@render pctCell(a.pct, a.accepted)}</Table.Cell>
                        <Table.Cell class="text-right">{a.pending}</Table.Cell>
                        <Table.Cell class="text-right">{a.agree}</Table.Cell>
                        <Table.Cell class="text-right">{a.disagree}</Table.Cell>
                        <Table.Cell class="text-right">{a.awaitingAck}</Table.Cell>
                      </Table.Row>
                    {/each}
                  </Table.Body>
                </Table.Root>
              </div>
            {/if}
          </section>

          <section aria-labelledby="iqa-units">
            <h2 id="iqa-units" class="mb-2 font-medium">Coverage by unit</h2>
            {#if coverage.units.length === 0}
              <p class="text-sm text-(--muted-foreground)">No units with accepted evidence yet.</p>
            {:else}
              <div class="overflow-x-auto rounded-lg border">
                <Table.Root>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Unit</Table.Head>
                      <Table.Head>Programme</Table.Head>
                      <Table.Head class="text-right">Accepted</Table.Head>
                      <Table.Head class="text-right">Sampled</Table.Head>
                      <Table.Head>Coverage</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {#each coverage.units as u (u.unitId)}
                      <Table.Row>
                        <Table.Cell class="font-medium">
                          {u.unitRef ? `${u.unitRef} · ` : ''}{u.unitTitle}
                        </Table.Cell>
                        <Table.Cell>{u.programmeTitle}</Table.Cell>
                        <Table.Cell class="text-right">{u.accepted}</Table.Cell>
                        <Table.Cell class="text-right">{u.sampled}</Table.Cell>
                        <Table.Cell>{@render pctCell(u.pct, u.accepted)}</Table.Cell>
                      </Table.Row>
                    {/each}
                  </Table.Body>
                </Table.Root>
              </div>
            {/if}
          </section>

          <section aria-labelledby="iqa-samples">
            <h2 id="iqa-samples" class="mb-1 font-medium">Samples</h2>
            <p class="mb-2 text-sm text-(--muted-foreground)">
              Disagree does not change the evidence status — refer the evidence from the portfolio if needed.
            </p>
            {#if samples.length === 0}
              <Empty
                title={hasFilters ? 'No samples match' : 'No samples yet'}
                description={hasFilters ? 'Try different filters.' : 'Use "Suggest sample" to pick evidence to check.'}
              />
            {:else}
              <div class="overflow-x-auto rounded-lg border">
                <Table.Root>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Learner</Table.Head>
                      <Table.Head>Evidence</Table.Head>
                      <Table.Head>Assessor</Table.Head>
                      <Table.Head>Sampled</Table.Head>
                      <Table.Head>Outcome</Table.Head>
                      <Table.Head>Decided</Table.Head>
                      <Table.Head>Acknowledged</Table.Head>
                      <Table.Head><span class="sr-only">Actions</span></Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {#each samples as s (s.id)}
                      <Table.Row class="cursor-pointer" onclick={() => openReview(s)}>
                        <Table.Cell>
                          <p class="font-medium">{s.learnerName ?? '—'}</p>
                          <p class="text-xs text-(--muted-foreground)">{s.programmeTitle}</p>
                        </Table.Cell>
                        <Table.Cell class="max-w-64 break-words whitespace-normal!">
                          <p>{s.evidenceTitle}</p>
                          <div class="mt-1"><EvidenceStatusChip status={s.evidenceStatus} /></div>
                        </Table.Cell>
                        <Table.Cell>{s.assessorName ?? '—'}</Table.Cell>
                        <Table.Cell class="text-sm whitespace-nowrap">
                          {fmtDate(s.createdAt)}
                          <p class="text-xs text-(--muted-foreground)">{s.sampledByName ?? ''}</p>
                        </Table.Cell>
                        <Table.Cell><IqaOutcomeChip outcome={s.outcome} /></Table.Cell>
                        <Table.Cell class="text-sm whitespace-nowrap">
                          {#if s.decidedAt}
                            {fmtDate(s.decidedAt)}
                            <p class="text-xs text-(--muted-foreground)">{s.decidedByName ?? ''}</p>
                          {:else}
                            <span class="text-(--muted-foreground)">—</span>
                          {/if}
                        </Table.Cell>
                        <Table.Cell class="text-sm whitespace-nowrap">
                          {#if s.acknowledgedAt}
                            {fmtDate(s.acknowledgedAt)}
                          {:else if s.outcome === 'PENDING'}
                            <span class="text-(--muted-foreground)">—</span>
                          {:else}
                            <span class={chip + ' bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300'}
                              >Awaiting</span
                            >
                          {/if}
                        </Table.Cell>
                        <Table.Cell>
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label="Review {s.evidenceTitle}"
                            onclick={(e: MouseEvent) => {
                              e.stopPropagation();
                              openReview(s);
                            }}>Review</Button
                          >
                        </Table.Cell>
                      </Table.Row>
                    {/each}
                  </Table.Body>
                </Table.Root>
              </div>
            {/if}
          </section>
        </div>
      {/if}
    {/snippet}
  </Page.Body>
</Page.Root>

<Dialog.Root bind:open={suggestOpen}>
  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Suggest sample</Dialog.Title>
      <Dialog.Description>
        Random accepted evidence, enough to bring each assessor up to the {targetPct ?? ''}% target
        {programmeId || assessorId ? 'for the current filters' : ''}.
      </Dialog.Description>
    </Dialog.Header>

    {#if suggestLoading}
      <div class="space-y-2" role="status" aria-label="Finding evidence to sample">
        {#each Array(3) as _, i (i)}<Skeleton class="h-10 w-full" />{/each}
      </div>
    {:else if suggestError}
      <p role="alert" class="text-sm text-rose-600">{suggestError}</p>
    {:else if picks.length === 0}
      <p class="text-sm text-(--muted-foreground)">Nothing to sample — every assessor is already at the target.</p>
    {:else}
      <div class="max-h-80 overflow-auto rounded-lg border">
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Learner</Table.Head>
              <Table.Head>Evidence</Table.Head>
              <Table.Head>Assessor</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each picks as p (p.evidenceId)}
              <Table.Row>
                <Table.Cell class="font-medium">{p.learnerName ?? '—'}</Table.Cell>
                <Table.Cell class="break-words whitespace-normal!">{p.evidenceTitle}</Table.Cell>
                <Table.Cell>{p.assessorName ?? '—'}</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </div>
      <p class="text-xs text-(--muted-foreground)">{picks.length} piece{picks.length === 1 ? '' : 's'} of evidence.</p>
    {/if}

    <Dialog.Footer class="mt-4">
      <Button variant="outline" onclick={() => (suggestOpen = false)} disabled={confirming}>Cancel</Button>
      <Button
        onclick={confirmSuggest}
        loading={confirming}
        disabled={suggestLoading || confirming || picks.length === 0}
      >
        Create {picks.length || ''} sample{picks.length === 1 ? '' : 's'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Sheet.Root bind:open={sheetOpen}>
  <Sheet.Content side="right" class="ui:w-full ui:overflow-y-auto sm:max-w-lg!">
    {#if reviewing}
      <Sheet.Header>
        <Sheet.Title>{reviewing.evidenceTitle}</Sheet.Title>
        <Sheet.Description>
          {reviewing.learnerName ?? 'Learner'} · {reviewing.programmeTitle} · assessed by {reviewing.assessorName ??
            '—'}
        </Sheet.Description>
      </Sheet.Header>

      <div class="space-y-4 px-4 pb-4">
        <div class="flex flex-wrap items-center gap-2">
          <EvidenceStatusChip status={reviewing.evidenceStatus} />
          <IqaOutcomeChip outcome={reviewing.outcome} />
        </div>
        <Button
          variant="outline"
          size="sm"
          href="{base}/learners/{reviewing.enrolmentId}?evidence={reviewing.evidenceId}">Open evidence</Button
        >

        <fieldset class="space-y-2">
          <legend class="text-sm font-medium">Your decision</legend>
          <RadioGroup.Root bind:value={decision} class="flex gap-4">
            <label class="flex items-center gap-2 text-sm">
              <RadioGroup.Item value="AGREE" id="iqa-agree" /> Agree with the assessor
            </label>
            <label class="flex items-center gap-2 text-sm">
              <RadioGroup.Item value="DISAGREE" id="iqa-disagree" /> Disagree
            </label>
          </RadioGroup.Root>
        </fieldset>

        <div class="space-y-1">
          <label for="iqa-feedback" class="text-sm font-medium"
            >Feedback for the assessor{decision === 'DISAGREE' ? ' (required)' : ''}</label
          >
          <Textarea id="iqa-feedback" rows={5} maxlength={APPR_IQA_FEEDBACK_MAX} bind:value={feedback} />
        </div>
        <p class="text-xs text-(--muted-foreground)">
          Disagree does not change the evidence status — refer the evidence from the portfolio if needed.
        </p>
        {#if reviewError}<p role="alert" class="text-sm text-rose-600">{reviewError}</p>{/if}

        <div class="flex items-center justify-between gap-2">
          {#if reviewing.outcome === 'PENDING'}
            <Button variant="outline" onclick={removeSample} loading={removing} disabled={removing || saving}
              >Remove sample</Button
            >
          {:else}
            <span></span>
          {/if}
          <div class="flex gap-2">
            <Button variant="outline" onclick={() => (sheetOpen = false)} disabled={saving}>Cancel</Button>
            <Button onclick={saveReview} loading={saving} disabled={!canSave || saving || removing}>Save</Button>
          </div>
        </div>
      </div>
    {/if}
  </Sheet.Content>
</Sheet.Root>
