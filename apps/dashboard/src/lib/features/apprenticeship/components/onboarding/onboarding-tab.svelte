<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '@cio/ui/base/button';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import { Skeleton } from '@cio/ui/base/skeleton';
  import { Textarea } from '@cio/ui/base/textarea';
  import { Empty } from '@cio/ui/custom/empty';
  import FileIcon from '@lucide/svelte/icons/file';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import XIcon from '@lucide/svelte/icons/x';
  import { APPR_NOTE_MAX, APPR_ONBOARDING_STATUS_LABELS } from '@cio/utils/constants/apprenticeship';
  import { isOrgAdmin, isOrgTeamMember } from '$lib/utils/store/org';
  import { snackbar } from '$features/ui/snackbar/store';
  import {
    apprOnboardingApi,
    type OnboardingFile,
    type OnboardingItem,
    type OnboardingView
  } from '../../api/onboarding.svelte';
  import { fmtBytes, fmtDate } from '../shared/format';

  // Onboarding documents for one enrolment (photo ID, NI proof…). The learner uploads (or says "I don't have this"
  // where allowed); an admin approves or sends back with a reason; a tutor sees status only (the API sends them no
  // files). Every change refreshes the list and bumps `onboardingChanged` so the sidebar badge follows.

  interface Props {
    enrolmentId: string;
  }
  let { enrolmentId }: Props = $props();

  const role = $derived<'admin' | 'tutor' | 'learner'>($isOrgAdmin ? 'admin' : $isOrgTeamMember ? 'tutor' : 'learner');

  let view = $state<OnboardingView | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(true);
  // Per document-type UI state.
  let busy = $state<Record<string, boolean>>({});
  let errors = $state<Record<string, string | null>>({});
  let rejecting = $state<Record<string, boolean>>({});
  let rejectNote = $state<Record<string, string>>({});
  let notHeldDraft = $state<Record<string, boolean>>({});
  let noteDraft = $state<Record<string, string>>({});
  const inputs: Record<string, HTMLInputElement | undefined> = {};

  async function load(quiet = false) {
    if (!quiet) loading = true;
    const res = await apprOnboardingApi.get(enrolmentId);
    if (res.ok) {
      view = res.data;
      loadError = null;
    } else {
      loadError = res.error;
    }
    loading = false;
  }

  onMount(() => {
    load();
  });

  const STATUS_CLASS = {
    NONE: 'bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300',
    SUBMITTED: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
    APPROVED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
    REJECTED: 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300'
  };

  const statusKey = (i: OnboardingItem) => i.doc?.status ?? 'NONE';
  const statusLabel = (i: OnboardingItem) => (i.doc ? APPR_ONBOARDING_STATUS_LABELS[i.doc.status] : 'Not uploaded');
  // An approved slot is locked for the learner; an admin can always change it (that sends it back for review).
  const canEdit = (i: OnboardingItem) =>
    i.type.active && (role === 'admin' || (role === 'learner' && i.doc?.status !== 'APPROVED'));
  // "I don't have this" is offered while the slot holds no uploaded files.
  const offerNotHeld = (i: OnboardingItem) =>
    i.type.allowNotHeld && (!i.doc || i.doc.notHeld || i.doc.files.length === 0);

  async function run(typeId: string, fn: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    busy[typeId] = true;
    errors[typeId] = null;
    const res = await fn();
    busy[typeId] = false;
    if (!res.ok) {
      errors[typeId] = res.error;
      return false;
    }
    await load(true);
    return true;
  }

  async function onPicked(item: OnboardingItem, e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const picked = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (picked.length === 0) return;
    const typeId = item.type.id;
    await run(typeId, async () => {
      const up = await apprOnboardingApi.presign(enrolmentId, typeId, picked);
      if (!up.ok) return up;
      const kept = item.doc?.notHeld ? [] : (item.doc?.files ?? []);
      return apprOnboardingApi.save(enrolmentId, typeId, {
        files: [...kept, ...up.data],
        notHeld: false,
        learnerNote: item.doc?.learnerNote ?? null
      });
    });
  }

  async function removeFile(item: OnboardingItem, file: OnboardingFile) {
    const rest = (item.doc?.files ?? []).filter((f) => f.key !== file.key);
    await run(item.type.id, () =>
      rest.length === 0
        ? apprOnboardingApi.withdraw(enrolmentId, item.type.id)
        : apprOnboardingApi.save(enrolmentId, item.type.id, {
            files: rest,
            notHeld: false,
            learnerNote: item.doc?.learnerNote ?? null
          })
    );
  }

  async function withdraw(item: OnboardingItem) {
    await run(item.type.id, () => apprOnboardingApi.withdraw(enrolmentId, item.type.id));
  }

  async function submitNotHeld(item: OnboardingItem) {
    const typeId = item.type.id;
    const ok = await run(typeId, () =>
      apprOnboardingApi.save(enrolmentId, typeId, {
        files: [],
        notHeld: true,
        learnerNote: noteDraft[typeId]?.trim() || null
      })
    );
    if (ok) {
      notHeldDraft[typeId] = false;
      noteDraft[typeId] = '';
    }
  }

  async function review(item: OnboardingItem, decision: 'APPROVE' | 'REJECT') {
    if (!item.doc) return;
    const typeId = item.type.id;
    const note = rejectNote[typeId]?.trim() ?? '';
    if (decision === 'REJECT' && !note) {
      errors[typeId] = 'Say what needs fixing.';
      return;
    }
    const ok = await run(typeId, () =>
      apprOnboardingApi.review(enrolmentId, typeId, {
        decision,
        note: decision === 'REJECT' ? note : null,
        expectedStatus: item.doc!.status
      })
    );
    if (ok) {
      rejecting[typeId] = false;
      rejectNote[typeId] = '';
      snackbar.success(decision === 'APPROVE' ? 'Document approved' : 'Sent back for re-upload');
    } else {
      // A stale status means someone else changed it: show their version (the error stays visible).
      await load(true);
    }
  }
</script>

{#if loading}
  <div class="space-y-3" role="status" aria-label="Loading onboarding documents">
    <Skeleton class="h-10 w-72" />
    <Skeleton class="h-28 w-full" />
    <Skeleton class="h-28 w-full" />
  </div>
{:else if loadError && !view}
  <div class="rounded-lg border border-rose-200 p-6 text-center">
    <p role="alert" class="text-sm text-rose-600">{loadError}</p>
    <Button variant="outline" size="sm" class="mt-3" onclick={() => load()}>Try again</Button>
  </div>
{:else if view}
  {@const v = view}
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <p class="text-sm font-medium" aria-live="polite">
        {v.counts.approved} of {v.counts.required} required documents approved
      </p>
      {#if v.complete}
        <span
          class="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300"
        >
          Onboarding complete
        </span>
      {/if}
      {#if role === 'tutor'}
        <span class="text-xs text-(--muted-foreground)">
          Status only — documents are visible to the learner and admins.
        </span>
      {/if}
    </div>

    {#if v.items.length === 0}
      <Empty title="No documents requested" description="No onboarding documents are set up for this programme." />
    {/if}

    <ul class="space-y-3">
      {#each v.items as item (item.type.id)}
        {@const id = item.type.id}
        {@const doc = item.doc}
        <li class="rounded-lg border bg-(--card) p-4 {item.type.active ? '' : 'opacity-70'}">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0">
              <h3 class="text-sm font-semibold">
                {item.type.label}
                {#if !item.type.required}
                  <span class="text-xs font-normal text-(--muted-foreground)">(optional)</span>
                {/if}
                {#if !item.type.active}
                  <span class="text-xs font-normal text-(--muted-foreground)">(no longer requested)</span>
                {/if}
              </h3>
              {#if item.type.description}
                <p class="mt-0.5 text-sm text-(--muted-foreground)">{item.type.description}</p>
              {/if}
            </div>
            <span
              class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap {STATUS_CLASS[
                statusKey(item)
              ]}"
            >
              {statusLabel(item)}
            </span>
          </div>

          {#if doc?.status === 'REJECTED' && doc.reviewNote}
            <p
              role="status"
              class="mt-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-500/10 dark:text-rose-300"
            >
              {doc.reviewNote}
            </p>
          {/if}

          {#if doc}
            <p class="mt-2 text-xs text-(--muted-foreground)">
              Uploaded {fmtDate(doc.submittedAt)}{doc.submittedByName ? ` by ${doc.submittedByName}` : ''}
              {#if doc.reviewedAt}
                · Reviewed {fmtDate(doc.reviewedAt)}{doc.reviewedByName ? ` by ${doc.reviewedByName}` : ''}
              {/if}
            </p>
            {#if doc.notHeld}
              <p class="mt-2 text-sm">
                Marked as "I don't have this"{doc.learnerNote ? `: ${doc.learnerNote}` : ''}
              </p>
            {:else if v.canSeeFiles && doc.files.length > 0}
              <ul class="mt-2 space-y-1">
                {#each doc.files as f (f.key)}
                  <li class="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm">
                    <button
                      type="button"
                      class="inline-flex min-w-0 items-center gap-1.5 text-left hover:underline"
                      onclick={() => apprOnboardingApi.openFile(enrolmentId, id, f.key)}
                    >
                      <FileIcon size={14} class="shrink-0" />
                      <span class="truncate">{f.name}</span>
                      <span class="shrink-0 text-xs text-(--muted-foreground)">{fmtBytes(f.size)}</span>
                    </button>
                    {#if canEdit(item)}
                      <button
                        type="button"
                        class="text-(--muted-foreground) hover:text-(--foreground)"
                        aria-label="Remove {f.name}"
                        disabled={busy[id]}
                        onclick={() => removeFile(item, f)}
                      >
                        <XIcon size={14} />
                      </button>
                    {/if}
                  </li>
                {/each}
              </ul>
            {:else if !v.canSeeFiles}
              <p class="mt-2 text-xs text-(--muted-foreground)">
                {doc.fileCount} file{doc.fileCount === 1 ? '' : 's'}
              </p>
            {/if}
          {/if}

          {#if canEdit(item)}
            <div class="mt-3 space-y-2">
              <input
                bind:this={inputs[id]}
                type="file"
                multiple
                class="hidden"
                aria-label="Choose files for {item.type.label}"
                onchange={(e) => onPicked(item, e)}
              />
              <div class="flex flex-wrap items-center gap-2">
                {#if !notHeldDraft[id]}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={busy[id]}
                    disabled={busy[id]}
                    onclick={() => inputs[id]?.click()}
                  >
                    <UploadIcon size={16} class="mr-1" />
                    {doc && !doc.notHeld ? 'Add files' : 'Upload files'}
                  </Button>
                {/if}
                {#if doc}
                  <Button type="button" variant="ghost" size="sm" disabled={busy[id]} onclick={() => withdraw(item)}>
                    {role === 'learner' ? 'Withdraw' : 'Remove'}
                  </Button>
                {/if}
              </div>

              {#if offerNotHeld(item) && !doc?.notHeld}
                <label class="flex items-center gap-2 text-sm">
                  <Checkbox bind:checked={notHeldDraft[id]} aria-label="I don't have this" />
                  I don't have this
                </label>
                {#if notHeldDraft[id]}
                  <div class="space-y-2">
                    <Textarea
                      bind:value={noteDraft[id]}
                      maxlength={APPR_NOTE_MAX}
                      rows={2}
                      placeholder="Optional: tell us why"
                      aria-label="Note about {item.type.label}"
                    />
                    <Button type="button" size="sm" loading={busy[id]} onclick={() => submitNotHeld(item)}>
                      Submit
                    </Button>
                  </div>
                {/if}
              {/if}
            </div>
          {/if}

          {#if role === 'admin' && doc && item.type.active}
            <div class="mt-3 space-y-2 border-t pt-3">
              <div class="flex flex-wrap items-center gap-2">
                {#if doc.status !== 'APPROVED'}
                  <Button
                    type="button"
                    size="sm"
                    loading={busy[id]}
                    disabled={busy[id]}
                    onclick={() => review(item, 'APPROVE')}
                  >
                    Approve
                  </Button>
                {/if}
                {#if doc.status !== 'REJECTED'}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy[id]}
                    onclick={() => (rejecting[id] = !rejecting[id])}
                  >
                    Reject
                  </Button>
                {/if}
              </div>
              {#if rejecting[id]}
                <div class="space-y-2">
                  <Textarea
                    bind:value={rejectNote[id]}
                    maxlength={APPR_NOTE_MAX}
                    rows={2}
                    placeholder="What needs fixing? The learner will see this."
                    aria-label="Reason for sending {item.type.label} back"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    loading={busy[id]}
                    onclick={() => review(item, 'REJECT')}
                  >
                    Send back
                  </Button>
                </div>
              {/if}
            </div>
          {/if}

          {#if errors[id]}
            <p role="alert" class="mt-2 text-sm text-rose-600">{errors[id]}</p>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}
