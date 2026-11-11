<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '@cio/ui/base/button';
  import { Spinner } from '@cio/ui/base/spinner';
  import { profile } from '$lib/utils/store/user';
  import { snackbar } from '$features/ui/snackbar/store';
  import { evidenceIqaApi, type EvidenceIqaSample } from '../../api/evidence-iqa.svelte';
  import { fmtDate } from '../shared/format';

  // IQA section of the evidence sheet — STAFF ONLY (the API 404s for a learner, so the parent never mounts this for one).
  // Admin samples reviewed evidence and agrees / disagrees; the assessor acknowledges. A disagree never changes the
  // evidence status.

  interface Props {
    evidenceId: string;
    evidenceStatus: string;
    isAdmin: boolean;
  }
  let { evidenceId, evidenceStatus, isAdmin }: Props = $props();

  let sample = $state<EvidenceIqaSample | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let busy = $state(false);
  let editing = $state(false);
  let choice = $state<'AGREE' | 'DISAGREE'>('AGREE');
  let feedback = $state('');

  const reviewed = $derived(evidenceStatus === 'ACCEPTED' || evidenceStatus === 'REFERRED');
  const pending = $derived(sample?.outcome === 'PENDING');
  const isAssessor = $derived(!!sample?.assessorId && sample.assessorId === $profile.id);
  const showForm = $derived(isAdmin && !!sample && (pending || editing));

  async function load() {
    loading = true;
    const res = await evidenceIqaApi.get(evidenceId);
    loading = false;
    if (res.ok) {
      sample = res.data;
      loadError = null;
    } else {
      loadError = res.error;
    }
  }
  onMount(load);

  function startEdit() {
    if (!sample) return;
    choice = sample.outcome === 'DISAGREE' ? 'DISAGREE' : 'AGREE';
    feedback = sample.feedback ?? '';
    editing = true;
  }

  async function doSample() {
    busy = true;
    const res = await evidenceIqaApi.sample(evidenceId);
    busy = false;
    if (res.ok) {
      sample = res.data;
    } else {
      snackbar.error(res.error);
      await load();
    }
  }

  async function doDecide() {
    if (!sample) return;
    if (choice === 'DISAGREE' && !feedback.trim()) {
      snackbar.error('Give feedback for the assessor when you disagree');
      return;
    }
    busy = true;
    const res = await evidenceIqaApi.decide(sample.id, {
      outcome: choice,
      feedback: feedback.trim() || undefined,
      expectedOutcome: sample.outcome as 'PENDING' | 'AGREE' | 'DISAGREE',
      expectedDecidedAt: sample.decidedAt
    });
    busy = false;
    if (res.ok) {
      sample = res.data;
      editing = false;
    } else {
      snackbar.error(res.error);
      // Stale (someone else decided first): show what is there now.
      editing = false;
      await load();
    }
  }

  async function doAcknowledge() {
    if (!sample?.decidedAt) return;
    busy = true;
    const res = await evidenceIqaApi.acknowledge(sample.id, sample.decidedAt);
    busy = false;
    if (res.ok) sample = res.data;
    else {
      snackbar.error(res.error);
      await load(); // the decision changed since it was shown: show the current one
    }
  }

  const chip = 'rounded-full px-2 py-0.5 text-xs font-medium';
</script>

<section class="mx-4 mb-4 space-y-2 rounded-lg border p-4" aria-label="IQA">
  <h3 class="text-sm font-semibold">IQA</h3>

  {#if loading}
    <div class="flex py-2" role="status" aria-label="Loading IQA"><Spinner /></div>
  {:else if loadError}
    <p role="alert" class="text-sm text-rose-600">{loadError}</p>
    <Button variant="outline" size="sm" onclick={load}>Try again</Button>
  {:else if !sample}
    {#if isAdmin && reviewed}
      <p class="text-sm text-(--muted-foreground)">
        This evidence has not been sampled for internal quality assurance.
      </p>
      <Button size="sm" variant="outline" disabled={busy} onclick={doSample}>Sample for IQA</Button>
    {:else}
      <p class="text-sm text-(--muted-foreground)">Not sampled for IQA.</p>
    {/if}
  {:else}
    {#if pending}
      <p class="text-sm">
        <span class="{chip} bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
          >Awaiting IQA review</span
        >
        <span class="ml-1 text-xs text-(--muted-foreground)">Sampled {fmtDate(sample.createdAt)}</span>
      </p>
    {:else}
      <p class="text-sm">
        <span
          class="{chip} {sample.outcome === 'AGREE'
            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300'
            : 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300'}"
          >{sample.outcome === 'AGREE' ? 'IQA agreed' : 'IQA disagreed'}</span
        >
        <span class="ml-1 text-xs text-(--muted-foreground)">
          {sample.decidedByName ?? 'IQA'}{sample.decidedAt ? `, ${fmtDate(sample.decidedAt)}` : ''}
        </span>
      </p>
      {#if sample.feedback}
        <p class="text-sm whitespace-pre-wrap">{sample.feedback}</p>
      {/if}
    {/if}

    {#if showForm}
      <div class="space-y-2 pt-1">
        <div class="flex gap-4 text-sm" role="radiogroup" aria-label="IQA outcome">
          <label class="flex items-center gap-1.5"
            ><input type="radio" bind:group={choice} value="AGREE" /> Agree with assessor</label
          >
          <label class="flex items-center gap-1.5"
            ><input type="radio" bind:group={choice} value="DISAGREE" /> Disagree</label
          >
        </div>
        <textarea
          class="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
          rows="3"
          maxlength="5000"
          placeholder={choice === 'DISAGREE' ? 'Feedback for the assessor (required)' : 'Feedback (optional)'}
          bind:value={feedback}
        ></textarea>
        <p class="text-xs text-(--muted-foreground)">Disagree does not change the evidence status.</p>
        <div class="flex gap-2">
          <Button size="sm" disabled={busy} onclick={doDecide}>{pending ? 'Save decision' : 'Save change'}</Button>
          {#if editing}
            <Button size="sm" variant="ghost" disabled={busy} onclick={() => (editing = false)}>Cancel</Button>
          {/if}
        </div>
      </div>
    {:else if isAdmin && !pending}
      <Button size="sm" variant="ghost" onclick={startEdit}>Change decision</Button>
    {/if}

    {#if !pending}
      {#if sample.acknowledgedAt}
        <p class="text-xs text-(--muted-foreground)">Acknowledged {fmtDate(sample.acknowledgedAt)}</p>
      {:else if isAssessor}
        <Button size="sm" variant="outline" disabled={busy} onclick={doAcknowledge}>Acknowledge</Button>
      {/if}
    {/if}
  {/if}
</section>
