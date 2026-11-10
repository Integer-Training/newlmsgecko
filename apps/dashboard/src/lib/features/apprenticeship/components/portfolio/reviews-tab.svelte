<script lang="ts">
  import * as Table from '@cio/ui/base/table';
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Empty } from '@cio/ui/custom/empty';
  import CalendarPlusIcon from '@lucide/svelte/icons/calendar-plus';
  import { isOrgTeamMember } from '$lib/utils/store/org';
  import { snackbar } from '$features/ui/snackbar/store';
  import { reviewsApi, type ReviewItem } from '../../api/reviews.svelte';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import ReviewPanel from '../reviews/review-panel.svelte';
  import ReviewStatusChip from '../shared/review-status-chip.svelte';
  import { fmtDate } from '../shared/format';

  // Reviews tab (admin, tutor and the apprentice): the next review up front, then the full history. Staff can
  // schedule a review; a row (or the card) opens the review in a side sheet.

  interface Props {
    store: PortfolioStore;
  }
  let { store }: Props = $props();

  const isStaff = $derived($isOrgTeamMember === true);
  const isOpen = (r: ReviewItem) => r.status !== 'COMPLETE' && r.status !== 'CANCELLED';

  let selectedId = $state<string | null>(null);
  let panelOpen = $state(false);
  let scheduleOpen = $state(false);
  let scheduleDate = $state('');
  let scheduling = $state(false);
  let scheduleError = $state<string | null>(null);

  const selected = $derived(store.reviews.find((r) => r.id === selectedId) ?? null);
  const next = $derived(
    [...store.reviews].filter(isOpen).sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))[0] ?? null
  );
  const history = $derived(
    [...store.reviews].sort((a, b) => (b.heldDate ?? b.scheduledDate).localeCompare(a.heldDate ?? a.scheduledDate))
  );

  function open(r: ReviewItem) {
    selectedId = r.id;
    panelOpen = true;
  }

  function openSchedule() {
    scheduleDate = '';
    scheduleError = null;
    scheduleOpen = true;
  }

  async function schedule() {
    if (!scheduleDate) return;
    scheduling = true;
    scheduleError = null;
    const res = await reviewsApi.schedule(store.enrolmentId, scheduleDate);
    scheduling = false;
    if (!res.ok) {
      scheduleError = res.error;
      return;
    }
    scheduleOpen = false;
    snackbar.success('Review scheduled');
    await store.refresh();
  }

  // Who signed and when, one short line per party that has signed ("Tutor: Tina T · 3 Nov").
  const shortDate = (iso: string | null) => {
    if (!iso) return '';
    const dt = new Date(iso);
    return Number.isNaN(dt.getTime()) ? '' : dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };
  const signers = (r: ReviewItem) =>
    [
      { role: 'Tutor', name: r.tutorSignedName, at: r.tutorSignedAt },
      { role: 'Learner', name: r.learnerSignedName, at: r.learnerSignedAt },
      { role: 'Employer', name: r.employerSignedName, at: r.employerSignedAt }
    ].filter((s) => s.name || s.at);

  const signedCount = (r: ReviewItem) =>
    [r.signatures.tutor, r.signatures.learner, r.signatures.employer].filter(Boolean).length;
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="text-sm font-semibold">Progress reviews</h3>
    {#if isStaff}
      <Button size="sm" onclick={openSchedule}><CalendarPlusIcon size={14} class="mr-1" /> Schedule review</Button>
    {/if}
  </div>

  {#if store.reviewsError}
    <div class="rounded-lg border border-rose-200 p-4 text-center">
      <p role="alert" class="text-sm text-rose-600">{store.reviewsError}</p>
      <Button variant="outline" size="sm" class="mt-3" onclick={() => store.refresh()}>Try again</Button>
    </div>
  {:else if store.reviews.length === 0}
    <Empty
      title="No reviews yet"
      description={isStaff
        ? 'Reviews are scheduled automatically from the learner’s start date. You can also schedule one now.'
        : 'Your tutor will schedule your progress reviews.'}
    />
  {:else}
    <section class="rounded-lg border bg-(--card) p-4" aria-label="Next review">
      <p class="text-xs text-(--muted-foreground)">Next review</p>
      {#if next}
        <div class="mt-1 flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-3">
            <span class="text-lg font-semibold">{fmtDate(next.scheduledDate)}</span>
            <ReviewStatusChip status={next.status} overdue={next.overdue} />
          </div>
          <Button size="sm" onclick={() => open(next)}>
            {isStaff
              ? next.status === 'SCHEDULED'
                ? 'Open review'
                : 'Continue review'
              : next.status === 'AWAITING_SIGNATURES'
                ? 'Review and sign'
                : 'View'}
          </Button>
        </div>
        {#if next.status === 'AWAITING_SIGNATURES'}
          <p class="mt-1 text-sm text-(--muted-foreground)">{signedCount(next)} of 3 signatures recorded.</p>
        {/if}
      {:else}
        <p class="mt-1 text-sm text-(--muted-foreground)">
          No review is currently scheduled.{isStaff ? ' Schedule one above.' : ''}
        </p>
      {/if}
    </section>

    <div class="overflow-x-auto rounded-lg border">
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Scheduled</Table.Head>
            <Table.Head>Held</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head>Signatures</Table.Head>
            <Table.Head>Next review</Table.Head>
            <Table.Head>Targets</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each history as r (r.id)}
            <Table.Row class="cursor-pointer" onclick={() => open(r)}>
              <Table.Cell class="font-medium whitespace-nowrap">
                <button
                  type="button"
                  class="text-left hover:underline"
                  onclick={(e) => {
                    e.stopPropagation();
                    open(r);
                  }}
                >
                  {fmtDate(r.scheduledDate)}
                </button>
              </Table.Cell>
              <Table.Cell class="whitespace-nowrap">{fmtDate(r.heldDate)}</Table.Cell>
              <Table.Cell><ReviewStatusChip status={r.status} overdue={r.overdue} /></Table.Cell>
              <Table.Cell class="text-xs">
                {#if r.status === 'CANCELLED' || signers(r).length === 0}
                  <span class="text-(--muted-foreground)">—</span>
                {:else}
                  {#each signers(r) as s (s.role)}
                    <p class="whitespace-nowrap">
                      {s.role}: {s.name ?? '—'}{s.at ? ` · ${shortDate(s.at)}` : ''}
                    </p>
                  {/each}
                {/if}
              </Table.Cell>
              <Table.Cell class="whitespace-nowrap">{fmtDate(r.nextReviewDate)}</Table.Cell>
              <Table.Cell>{r.targets.length || '—'}</Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  {/if}
</div>

<ReviewPanel bind:open={panelOpen} review={selected} {store} />

{#if isStaff}
  <Dialog.Root bind:open={scheduleOpen}>
    <Dialog.Content class="sm:max-w-sm">
      <Dialog.Header>
        <Dialog.Title>Schedule a review</Dialog.Title>
        <Dialog.Description>Choose the date of the next progress review for this learner.</Dialog.Description>
      </Dialog.Header>
      <form
        class="space-y-3"
        onsubmit={(e) => {
          e.preventDefault();
          schedule();
        }}
      >
        <div class="space-y-1">
          <label for="rv-new-date" class="text-sm font-medium">Review date</label>
          <Input id="rv-new-date" type="date" bind:value={scheduleDate} required />
        </div>
        {#if scheduleError}
          <p
            role="alert"
            class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
          >
            {scheduleError}
          </p>
        {/if}
        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={() => (scheduleOpen = false)} disabled={scheduling}
            >Cancel</Button
          >
          <Button type="submit" loading={scheduling} disabled={scheduling || !scheduleDate}>Schedule</Button>
        </Dialog.Footer>
      </form>
    </Dialog.Content>
  </Dialog.Root>
{/if}
