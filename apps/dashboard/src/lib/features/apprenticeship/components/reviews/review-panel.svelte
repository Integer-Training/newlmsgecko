<script lang="ts">
  import { untrack } from 'svelte';
  import * as Sheet from '@cio/ui/base/sheet';
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import { Input } from '@cio/ui/base/input';
  import { Textarea } from '@cio/ui/base/textarea';
  import LockIcon from '@lucide/svelte/icons/lock';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import XIcon from '@lucide/svelte/icons/x';
  import { APPR_REVIEW_TARGETS_MAX } from '@cio/utils/constants/apprenticeship';
  import { isOrgTeamMember } from '$lib/utils/store/org';
  import { profile } from '$lib/utils/store/user';
  import { snackbar } from '$features/ui/snackbar/store';
  import { reviewsApi, type ReviewItem, type ReviewSnapshot, type ReviewUpdateBody } from '../../api/reviews.svelte';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import ReviewSnapshotView from './review-snapshot.svelte';
  import ReviewStatusChip from '../shared/review-status-chip.svelte';
  import { fmtDate } from '../shared/format';

  // One progress review in a side sheet. Staff fill it in (held date, summary, targets, comments) and move it
  // Scheduled -> In progress -> Awaiting signatures; the tutor signs, the employer's signature is recorded by staff on
  // their behalf and the apprentice signs for themselves (and may add their own comment first). Once any signature
  // exists the fields lock. Every write is conditional on the version loaded here, so a concurrent change comes back as
  // a conflict and the sheet offers to reload.

  interface Props {
    open: boolean;
    review: ReviewItem | null;
    store: PortfolioStore;
  }
  let { open = $bindable(), review, store }: Props = $props();

  const isStaff = $derived($isOrgTeamMember === true);

  // ── Form state (reset whenever the server version changes) ──
  let scheduledDate = $state('');
  let heldDate = $state('');
  let progressSummary = $state('');
  let targets = $state<{ text: string; due: string }[]>([]);
  let tutorComment = $state('');
  let employerComment = $state('');
  let learnerComment = $state('');
  let tutorName = $state('');
  let employerName = $state('');
  let learnerName = $state('');
  let employerConfirm = $state(false);

  let busy = $state(false);
  let error = $state<string | null>(null);
  let conflict = $state(false);
  let cancelOpen = $state(false);

  $effect(() => {
    const key = review ? `${review.id}|${review.updatedAt}` : '';
    void key;
    untrack(() => {
      if (!review) return;
      scheduledDate = review.scheduledDate;
      heldDate = review.heldDate ?? '';
      progressSummary = review.progressSummary ?? '';
      targets = review.targets.map((t) => ({ text: t.text, due: t.due ?? '' }));
      tutorComment = review.tutorComment ?? '';
      employerComment = review.employerComment ?? '';
      learnerComment = review.learnerComment ?? '';
      if (!tutorName) tutorName = $profile.fullname ?? '';
      if (!learnerName) learnerName = store.data?.learner.name ?? $profile.fullname ?? '';
      error = null;
      conflict = false;
    });
  });

  // ── Derived state ──
  const status = $derived(review?.status ?? 'SCHEDULED');
  const final = $derived(status === 'COMPLETE' || status === 'CANCELLED');
  const locked = $derived(review?.locked ?? false);
  const anySigned = $derived(
    !!review && (review.signatures.tutor || review.signatures.learner || review.signatures.employer)
  );
  const staffCanEdit = $derived(isStaff && !!review && !locked && !final);
  const learnerCanComment = $derived(
    !isStaff && !!review && ['DRAFT', 'AWAITING_SIGNATURES'].includes(status) && !review.signatures.learner
  );
  const awaiting = $derived(status === 'AWAITING_SIGNATURES');

  const dirty = $derived.by(() => {
    if (!review) return false;
    const r = review;
    const same = (a: string, b: string | null) => a.trim() === (b ?? '').trim();
    const t0 = JSON.stringify(r.targets.map((t) => [t.text, t.due ?? '']));
    const t1 = JSON.stringify(targets.map((t) => [t.text.trim(), t.due]));
    return isStaff
      ? scheduledDate !== r.scheduledDate ||
          heldDate !== (r.heldDate ?? '') ||
          !same(progressSummary, r.progressSummary) ||
          !same(tutorComment, r.tutorComment) ||
          !same(employerComment, r.employerComment) ||
          t0 !== t1
      : !same(learnerComment, r.learnerComment);
  });

  const liveSnapshot = $derived.by((): ReviewSnapshot | null => {
    const d = store.data;
    if (!d) return null;
    const units = d.qualifications.flatMap((q) => q.units);
    return {
      actualPct: d.summary.actualPct,
      expectedPct: d.summary.expectedPct,
      status: d.summary.status,
      otj: d.summary.otj,
      counts: d.summary.counts,
      units: { total: units.length, complete: units.filter((u) => u.status === 'COMPLETE').length }
    };
  });
  const snapshot = $derived(status === 'COMPLETE' && review?.snapshot ? review.snapshot : liveSnapshot);

  const lockReason = $derived.by(() => {
    if (!review) return '';
    if (status === 'COMPLETE') return 'This review is complete and can no longer be changed.';
    if (status === 'CANCELLED') return 'This review was cancelled.';
    if (anySigned)
      return 'This review has been signed, so its fields are locked. Only the apprentice can still add their own comment before they sign.';
    return '';
  });

  // ── Actions ──
  function fail(message: string) {
    error = message;
    conflict = /changed by someone else|reload|closed|locked/i.test(message);
  }

  async function reload() {
    busy = true;
    await store.refresh();
    busy = false;
    error = null;
    conflict = false;
  }

  function staffBody(extra: ReviewUpdateBody = {}): ReviewUpdateBody {
    return {
      scheduledDate,
      heldDate: heldDate || null,
      progressSummary: progressSummary.trim() || null,
      targets: targets.filter((t) => t.text.trim()).map((t) => ({ text: t.text.trim(), due: t.due || null })),
      tutorComment: tutorComment.trim() || null,
      employerComment: employerComment.trim() || null,
      expectedUpdatedAt: review?.updatedAt,
      ...extra
    };
  }

  async function write(body: ReviewUpdateBody, okMessage: string): Promise<boolean> {
    if (!review) return false;
    busy = true;
    error = null;
    const res = await reviewsApi.update(review.id, body);
    busy = false;
    if (!res.ok) {
      fail(res.error);
      return false;
    }
    store.applyReview(res.data);
    snackbar.success(okMessage);
    store.refresh();
    return true;
  }

  const save = () =>
    write(
      isStaff ? staffBody() : { learnerComment: learnerComment.trim() || null, expectedUpdatedAt: review?.updatedAt },
      'Review saved'
    );
  const startReview = () => write(staffBody({ status: 'DRAFT' }), 'Review started');
  const askForSignatures = () => write(staffBody({ status: 'AWAITING_SIGNATURES' }), 'Ready for signatures');
  const backToDraft = () =>
    write({ status: 'DRAFT', expectedUpdatedAt: review?.updatedAt }, 'Moved back to in progress');

  async function sign(role: 'TUTOR' | 'LEARNER' | 'EMPLOYER', name: string) {
    if (!review) return;
    busy = true;
    error = null;
    const res = await reviewsApi.sign(review.id, role, name.trim());
    busy = false;
    if (!res.ok) {
      fail(res.error);
      return;
    }
    store.applyReview(res.data);
    snackbar.success(
      res.data.status === 'COMPLETE'
        ? res.data.scheduledNext
          ? 'Review complete — the next review has been scheduled'
          : 'Review complete'
        : 'Signature recorded'
    );
    store.refresh();
  }

  async function cancelReview() {
    if (!review) return;
    busy = true;
    const res = await reviewsApi.cancel(review.id);
    busy = false;
    if (!res.ok) {
      cancelOpen = false;
      fail(res.error);
      return;
    }
    cancelOpen = false;
    store.applyReview(res.data);
    snackbar.success('Review cancelled');
    store.refresh();
  }

  function addTarget() {
    if (targets.length < APPR_REVIEW_TARGETS_MAX) targets = [...targets, { text: '', due: '' }];
  }

  const signedLine = (name: string | null, at: string | null) => (at ? `${name ?? 'Signed'} · ${fmtDate(at)}` : null);
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="right" class="ui:w-full ui:overflow-y-auto sm:max-w-2xl!">
    {#if review}
      <Sheet.Header>
        <Sheet.Title>Review — {fmtDate(review.heldDate ?? review.scheduledDate)}</Sheet.Title>
        <Sheet.Description>
          <span class="inline-flex flex-wrap items-center gap-2">
            <ReviewStatusChip status={review.status} overdue={review.overdue} />
            {#if review.heldDate}<span>Scheduled {fmtDate(review.scheduledDate)}</span>{/if}
          </span>
        </Sheet.Description>
      </Sheet.Header>

      <div class="space-y-5 px-4 pb-6">
        {#if lockReason}
          <p class="flex items-start gap-2 rounded-md bg-(--muted) px-3 py-2 text-sm">
            <LockIcon size={16} class="mt-0.5 shrink-0" /> <span>{lockReason}</span>
          </p>
        {/if}

        {#if error}
          <div
            role="alert"
            class="space-y-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
          >
            <p>{error}</p>
            {#if conflict}
              <Button size="sm" variant="outline" onclick={reload} loading={busy} disabled={busy}
                >Reload latest version</Button
              >
            {/if}
          </div>
        {/if}

        {#if snapshot}
          <ReviewSnapshotView {snapshot} captured={status === 'COMPLETE' && !!review.snapshot} />
        {/if}

        <!-- Fields -->
        <div class="space-y-4">
          {#if staffCanEdit}
            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-1">
                <label for="rv-scheduled" class="text-sm font-medium">Scheduled for</label>
                <Input id="rv-scheduled" type="date" bind:value={scheduledDate} disabled={busy} />
              </div>
              <div class="space-y-1">
                <label for="rv-held" class="text-sm font-medium">Review held on</label>
                <Input id="rv-held" type="date" bind:value={heldDate} disabled={busy} />
              </div>
            </div>
          {:else}
            <dl class="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt class="text-xs text-(--muted-foreground)">Scheduled for</dt>
                <dd>{fmtDate(review.scheduledDate)}</dd>
              </div>
              <div>
                <dt class="text-xs text-(--muted-foreground)">Review held on</dt>
                <dd>{fmtDate(review.heldDate)}</dd>
              </div>
            </dl>
          {/if}

          <div class="space-y-1">
            <label for="rv-summary" class="text-sm font-medium">Progress summary</label>
            {#if staffCanEdit}
              <Textarea
                id="rv-summary"
                class="min-h-[96px]!"
                bind:value={progressSummary}
                maxlength={10000}
                disabled={busy}
              />
            {:else}
              <p class="text-sm whitespace-pre-wrap">{review.progressSummary || '—'}</p>
            {/if}
          </div>

          <div class="space-y-2">
            <p class="text-sm font-medium">Targets for the next period</p>
            {#if staffCanEdit}
              <ul class="space-y-2">
                {#each targets as t, i (i)}
                  <li class="flex flex-wrap items-center gap-2">
                    <Input
                      class="min-w-48 flex-1"
                      placeholder="Target"
                      aria-label="Target {i + 1}"
                      maxlength={1000}
                      bind:value={t.text}
                      disabled={busy}
                    />
                    <Input
                      class="w-40"
                      type="date"
                      aria-label="Target {i + 1} due date"
                      bind:value={t.due}
                      disabled={busy}
                    />
                    <button
                      type="button"
                      class="text-(--muted-foreground) hover:text-(--foreground)"
                      aria-label="Remove target {i + 1}"
                      onclick={() => (targets = targets.filter((_, j) => j !== i))}
                    >
                      <XIcon size={16} />
                    </button>
                  </li>
                {/each}
              </ul>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onclick={addTarget}
                disabled={busy || targets.length >= APPR_REVIEW_TARGETS_MAX}
              >
                <PlusIcon size={14} class="mr-1" /> Add target
              </Button>
              <p class="text-xs text-(--muted-foreground)">
                {targets.length} of {APPR_REVIEW_TARGETS_MAX}. Empty targets are ignored.
              </p>
            {:else if review.targets.length === 0}
              <p class="text-sm text-(--muted-foreground)">No targets recorded.</p>
            {:else}
              <ul class="list-disc space-y-1 pl-5 text-sm">
                {#each review.targets as t, i (i)}
                  <li>
                    {t.text}{#if t.due}<span class="text-(--muted-foreground)"> — due {fmtDate(t.due)}</span>{/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          <div class="space-y-1">
            <label for="rv-tutor" class="text-sm font-medium">Tutor comment</label>
            {#if staffCanEdit}
              <Textarea
                id="rv-tutor"
                class="min-h-[72px]!"
                bind:value={tutorComment}
                maxlength={10000}
                disabled={busy}
              />
            {:else}
              <p class="text-sm whitespace-pre-wrap">{review.tutorComment || '—'}</p>
            {/if}
          </div>

          <div class="space-y-1">
            <label for="rv-employer" class="text-sm font-medium">Employer comment</label>
            {#if staffCanEdit}
              <Textarea
                id="rv-employer"
                class="min-h-[72px]!"
                bind:value={employerComment}
                maxlength={10000}
                disabled={busy}
              />
            {:else}
              <p class="text-sm whitespace-pre-wrap">{review.employerComment || '—'}</p>
            {/if}
          </div>

          <div class="space-y-1">
            <label for="rv-learner" class="text-sm font-medium">Apprentice comment</label>
            {#if learnerCanComment}
              <Textarea
                id="rv-learner"
                class="min-h-[72px]!"
                bind:value={learnerComment}
                maxlength={10000}
                disabled={busy}
              />
              <p class="text-xs text-(--muted-foreground)">Add your comment and save it before you sign.</p>
            {:else}
              <p class="text-sm whitespace-pre-wrap">
                {review.learnerComment ||
                  (isStaff ? 'Not added yet — the apprentice can add this once the review is in progress.' : '—')}
              </p>
            {/if}
          </div>
        </div>

        <!-- Save / status flow -->
        {#if (staffCanEdit || learnerCanComment) && !final}
          <div class="flex flex-wrap items-center gap-2 border-t pt-4">
            <Button variant="outline" onclick={save} loading={busy} disabled={busy || !dirty}>Save changes</Button>
            {#if staffCanEdit && status === 'SCHEDULED'}
              <Button onclick={startReview} loading={busy} disabled={busy}>Start review</Button>
            {/if}
            {#if staffCanEdit && status === 'DRAFT'}
              <Button onclick={askForSignatures} loading={busy} disabled={busy || !heldDate}
                >Ready for signatures</Button
              >
              {#if !heldDate}<span class="text-xs text-(--muted-foreground)"
                  >Enter the date the review was held first.</span
                >{/if}
            {/if}
            {#if staffCanEdit && awaiting}
              <Button variant="outline" onclick={backToDraft} disabled={busy}>Back to in progress</Button>
              {#if !heldDate}<span class="text-xs text-(--muted-foreground)"
                  >A held date is needed to request signatures.</span
                >{/if}
            {/if}
            {#if dirty && awaiting && staffCanEdit}
              <span class="text-xs text-amber-700">Save your changes before signing.</span>
            {/if}
          </div>
        {/if}

        <!-- Signatures -->
        {#if awaiting || status === 'COMPLETE' || anySigned}
          <section class="space-y-3 border-t pt-4" aria-label="Signatures">
            <h3 class="text-sm font-semibold">Signatures</h3>

            <div class="rounded-md border p-3">
              <p class="text-sm font-medium">Tutor</p>
              {#if review.tutorSignedAt}
                <p class="text-sm text-emerald-700 dark:text-emerald-300">
                  {signedLine(review.tutorSignedName, review.tutorSignedAt)}
                </p>
              {:else if isStaff && awaiting}
                <div class="mt-2 flex flex-wrap items-end gap-2">
                  <div class="space-y-1">
                    <label for="sig-tutor" class="text-xs text-(--muted-foreground)">Type your full name</label>
                    <Input id="sig-tutor" class="w-64" bind:value={tutorName} maxlength={200} disabled={busy} />
                  </div>
                  <Button
                    onclick={() => sign('TUTOR', tutorName)}
                    loading={busy}
                    disabled={busy || dirty || !tutorName.trim()}>Sign as tutor</Button
                  >
                </div>
              {:else}
                <p class="text-sm text-(--muted-foreground)">Waiting for the tutor.</p>
              {/if}
            </div>

            <div class="rounded-md border p-3">
              <p class="text-sm font-medium">Apprentice</p>
              {#if review.learnerSignedAt}
                <p class="text-sm text-emerald-700 dark:text-emerald-300">
                  {signedLine(review.learnerSignedName, review.learnerSignedAt)}
                </p>
              {:else if !isStaff && awaiting}
                <div class="mt-2 flex flex-wrap items-end gap-2">
                  <div class="space-y-1">
                    <label for="sig-learner" class="text-xs text-(--muted-foreground)">Type your full name</label>
                    <Input id="sig-learner" class="w-64" bind:value={learnerName} maxlength={200} disabled={busy} />
                  </div>
                  <Button
                    onclick={() => sign('LEARNER', learnerName)}
                    loading={busy}
                    disabled={busy || dirty || !learnerName.trim()}>Sign as learner</Button
                  >
                </div>
                {#if dirty}<p class="mt-1 text-xs text-amber-700">Save your comment before signing.</p>{/if}
              {:else}
                <p class="text-sm text-(--muted-foreground)">Waiting for the apprentice to sign.</p>
              {/if}
            </div>

            <div class="rounded-md border p-3">
              <p class="text-sm font-medium">Employer</p>
              {#if review.employerSignedAt}
                <p class="text-sm text-emerald-700 dark:text-emerald-300">
                  {signedLine(review.employerSignedName, review.employerSignedAt)}
                  <span class="text-xs text-(--muted-foreground)"> · recorded by staff on the employer's behalf</span>
                </p>
              {:else if isStaff && awaiting}
                <div class="mt-2 space-y-2">
                  <div class="space-y-1">
                    <label for="sig-employer" class="text-xs text-(--muted-foreground)">Employer's full name</label>
                    <Input id="sig-employer" class="w-64" bind:value={employerName} maxlength={200} disabled={busy} />
                  </div>
                  <label class="flex items-start gap-2 text-sm">
                    <Checkbox class="mt-0.5" bind:checked={employerConfirm} />
                    <span>I am recording this on the employer's behalf</span>
                  </label>
                  <Button
                    variant="outline"
                    onclick={() => sign('EMPLOYER', employerName)}
                    loading={busy}
                    disabled={busy || dirty || !employerName.trim() || !employerConfirm}
                  >
                    Record employer signature
                  </Button>
                </div>
              {:else}
                <p class="text-sm text-(--muted-foreground)">Waiting for the employer's signature.</p>
              {/if}
            </div>
          </section>
        {/if}

        {#if status === 'COMPLETE'}
          <p
            class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300"
          >
            {#if review.nextReviewDate}
              The next review has been scheduled for {fmtDate(review.nextReviewDate)}.
            {:else}
              Review complete.
            {/if}
          </p>
        {/if}

        {#if isStaff && !final}
          <div class="border-t pt-4">
            <Button variant="outline" class="text-rose-600" onclick={() => (cancelOpen = true)} disabled={busy}
              >Cancel this review</Button
            >
          </div>
        {/if}
      </div>
    {/if}
  </Sheet.Content>
</Sheet.Root>

<Dialog.Root bind:open={cancelOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Cancel this review?</Dialog.Title>
      <Dialog.Description>
        It stays in the history as cancelled and can no longer be edited or signed. You can schedule a new review
        afterwards.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer class="mt-4">
      <Button variant="outline" onclick={() => (cancelOpen = false)} disabled={busy}>Keep review</Button>
      <Button variant="destructive" onclick={cancelReview} loading={busy} disabled={busy}>Cancel review</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
