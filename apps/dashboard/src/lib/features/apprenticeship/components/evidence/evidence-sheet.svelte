<script lang="ts">
  import { untrack } from 'svelte';
  import * as Sheet from '@cio/ui/base/sheet';
  import { Spinner } from '@cio/ui/base/spinner';
  import { Button } from '@cio/ui/base/button';
  import { evidenceApi, type EvidenceDetail, type PickerQualification } from '../../api/evidence.svelte';
  import EvidenceForm from './evidence-form.svelte';
  import EvidenceReview from './evidence-review.svelte';

  // The evidence side-sheet, reused by the portfolio (add / view / edit) and the marking queue (review). It loads the
  // detail itself; the criteria tree comes from the caller (the portfolio payload) or, when absent (the queue), from
  // the programme tree of the evidence being opened.

  interface Props {
    open: boolean;
    mode: 'add' | 'view';
    evidenceId: string | null;
    /** Needed to add / attach files; null in the marking queue (the loaded detail then supplies it). */
    enrolmentId: string | null;
    tree?: PickerQualification[] | null;
    metIds?: Set<string> | null;
    preCriteria?: string[];
    learnerName?: string | null;
    /** Called after any save / review so the parent can refresh its counts and lists. */
    onChanged: (opts: { reviewed: boolean }) => void;
    /** Close the sheet once a review decision is made (the marking queue). */
    closeOnReview?: boolean;
  }
  let {
    open = $bindable(false),
    mode,
    evidenceId,
    enrolmentId,
    tree = null,
    metIds = null,
    preCriteria = [],
    learnerName = null,
    onChanged,
    closeOnReview = false
  }: Props = $props();

  let detail = $state<EvidenceDetail | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(false);
  let editing = $state(false);
  let fetched = $state<PickerQualification[] | null>(null);
  let nonce = $state(0);
  let reqId = 0;

  const effectiveTree = $derived(tree ?? fetched ?? []);
  const isAdd = $derived(mode === 'add' && !evidenceId);
  // To mark has no portfolio, so fall back to the enrolment the API returns with the evidence (file uploads need it).
  const formEnrolmentId = $derived(enrolmentId ?? detail?.enrolmentId ?? null);

  async function loadDetail() {
    if (!evidenceId) return;
    const id = ++reqId;
    loading = detail?.evidence.id !== evidenceId;
    const res = await evidenceApi.detail(evidenceId);
    if (id !== reqId) return;
    loading = false;
    if (res.ok) {
      detail = res.data;
      loadError = null;
      nonce += 1;
      if (!tree && !fetched) {
        const t = await evidenceApi.programmeTree(res.data.evidence.programmeId);
        if (id === reqId && t.ok) fetched = t.data.qualifications;
      }
    } else {
      loadError = res.error;
    }
  }

  // (Re)load whenever the sheet opens on a piece; reset the edit state each time.
  $effect(() => {
    const id = evidenceId;
    if (open && id) {
      untrack(() => {
        editing = false;
        loadError = null;
        loadDetail();
      });
    } else if (!open) {
      untrack(() => {
        detail = null;
        editing = false;
      });
    }
  });

  function saved() {
    editing = false;
    onChanged({ reviewed: false });
    if (isAdd) open = false;
    else loadDetail();
  }

  function changed(opts: { reviewed: boolean }) {
    onChanged(opts);
    if (opts.reviewed && closeOnReview) open = false;
    else loadDetail();
  }

  const title = $derived(isAdd ? 'Add evidence' : editing ? 'Edit evidence' : (detail?.evidence.title ?? 'Evidence'));
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="right" class="ui:w-full ui:overflow-y-auto sm:max-w-2xl!">
    <Sheet.Header>
      <Sheet.Title>{title}</Sheet.Title>
      <Sheet.Description>
        {#if isAdd}
          Add a piece of evidence and map it to criteria.
        {:else if learnerName}
          {learnerName}
        {:else}
          Evidence details
        {/if}
      </Sheet.Description>
    </Sheet.Header>

    {#if open}
      {#if isAdd}
        {#key open}
          <EvidenceForm
            {enrolmentId}
            tree={effectiveTree}
            {metIds}
            {preCriteria}
            onSaved={saved}
            onCancel={() => (open = false)}
          />
        {/key}
      {:else if loading}
        <div class="flex justify-center py-12" role="status" aria-label="Loading evidence"><Spinner /></div>
      {:else if loadError}
        <div class="px-4 py-6">
          <p role="alert" class="text-sm text-rose-600">{loadError}</p>
          <Button variant="outline" size="sm" class="mt-3" onclick={loadDetail}>Try again</Button>
        </div>
      {:else if detail}
        {#key `${detail.evidence.id}-${nonce}-${editing}`}
          {#if editing}
            <EvidenceForm
              initial={detail}
              enrolmentId={formEnrolmentId}
              tree={effectiveTree}
              {metIds}
              onSaved={saved}
              onCancel={() => (editing = false)}
            />
          {:else}
            <EvidenceReview
              {detail}
              tree={effectiveTree}
              {metIds}
              {learnerName}
              onEdit={() => (editing = true)}
              onChanged={changed}
              onNoteAdded={(n) => {
                if (detail) detail = { ...detail, notes: [...detail.notes, n] };
              }}
            />
          {/if}
        {/key}
      {/if}
    {/if}
  </Sheet.Content>
</Sheet.Root>
