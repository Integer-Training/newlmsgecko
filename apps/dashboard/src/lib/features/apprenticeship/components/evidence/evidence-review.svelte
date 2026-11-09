<script lang="ts">
  import { Button } from '@cio/ui/base/button';
  import { Textarea } from '@cio/ui/base/textarea';
  import * as Table from '@cio/ui/base/table';
  import FileIcon from '@lucide/svelte/icons/file';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import { APPR_NOTE_MAX } from '@cio/utils/constants/apprenticeship';
  import { snackbar } from '$features/ui/snackbar/store';
  import { evidenceApi, type EvidenceDetail, type PickerQualification } from '../../api/evidence.svelte';
  import CriteriaPicker from './criteria-picker.svelte';
  import EvidenceNotes from './evidence-notes.svelte';
  import EvidenceStatusChip from '../shared/evidence-status-chip.svelte';
  import { fmtBytes, fmtDate, fmtMinutes } from '../shared/format';

  // View / review one piece of evidence. When the viewer can review, the criteria become an editable selection (the
  // tutor confirms or edits the learner's proposal) and Accept / Refer send it with an optional note.

  interface Props {
    detail: EvidenceDetail;
    tree: PickerQualification[];
    metIds?: Set<string> | null;
    learnerName?: string | null;
    onEdit: () => void;
    /** After a review or a note: the parent refetches counts / queue. `closed` = the review decision was made. */
    onChanged: (opts: { reviewed: boolean }) => void;
    onNoteAdded: (note: EvidenceDetail['notes'][number]) => void;
  }
  let { detail, tree, metIds = null, learnerName = null, onEdit, onChanged, onNoteAdded }: Props = $props();

  const ev = $derived(detail.evidence);
  const mappedIds = $derived(detail.criteria.flatMap((q) => q.units.flatMap((u) => u.criteria.map((c) => c.id))));

  // svelte-ignore state_referenced_locally
  let selected = $state<string[]>([...mappedIds]);
  let note = $state('');
  let busy = $state<'ACCEPT' | 'REFER' | null>(null);
  let error = $state<string | null>(null);

  async function decide(decision: 'ACCEPT' | 'REFER') {
    if (busy) return;
    busy = decision;
    error = null;
    const res = await evidenceApi.review(ev.id, {
      decision,
      criterionIds: selected,
      ...(note.trim() ? { note: { body: note.trim(), kind: 'GENERAL' as const } } : {})
    });
    busy = null;
    if (!res.ok) {
      error = res.error;
      return;
    }
    snackbar.success(decision === 'ACCEPT' ? 'Evidence accepted' : 'Evidence referred back');
    note = '';
    onChanged({ reviewed: true });
  }
</script>

<div class="space-y-5 px-4 pb-6">
  <div class="flex flex-wrap items-center gap-2">
    <EvidenceStatusChip status={ev.status} />
    {#if detail.permissions.canEdit}
      <Button variant="outline" size="sm" class="ml-auto" onclick={onEdit}>
        <PencilIcon size={14} class="mr-1" /> Edit
      </Button>
    {/if}
  </div>

  <Table.Root>
    <Table.Body>
      {#if learnerName}
        <Table.Row><Table.Head class="w-36">Learner</Table.Head><Table.Cell>{learnerName}</Table.Cell></Table.Row>
      {/if}
      <Table.Row><Table.Head class="w-36">Type</Table.Head><Table.Cell>{ev.typeLabel}</Table.Cell></Table.Row>
      <Table.Row>
        <Table.Head>Time</Table.Head>
        <Table.Cell>
          {fmtMinutes(ev.minutes)}
          {#if ev.includeOtj}<span class="text-(--muted-foreground)"> · counts towards off-the-job hours</span>{/if}
        </Table.Cell>
      </Table.Row>
      <Table.Row><Table.Head>Added</Table.Head><Table.Cell>{fmtDate(ev.createdAt)}</Table.Cell></Table.Row>
      <Table.Row>
        <Table.Head>Details</Table.Head>
        <Table.Cell class="whitespace-pre-wrap">{ev.details || '—'}</Table.Cell>
      </Table.Row>
    </Table.Body>
  </Table.Root>

  <section class="space-y-1.5" aria-label="Files">
    <h3 class="text-sm font-semibold">Files</h3>
    {#if ev.files.length === 0}
      <p class="text-sm text-(--muted-foreground)">No files attached.</p>
    {:else}
      <ul class="space-y-1">
        {#each ev.files as f (f.key)}
          <li>
            <button
              type="button"
              class="ui:text-primary inline-flex items-center gap-1.5 text-sm hover:underline"
              onclick={() => evidenceApi.openFile(ev.id, f.key)}
            >
              <FileIcon size={14} />
              {f.name}
              <span class="text-xs text-(--muted-foreground)">{fmtBytes(f.size)}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="space-y-2" aria-label="Criteria">
    <h3 class="text-sm font-semibold">
      Criteria {#if detail.permissions.canReview}<span class="font-normal text-(--muted-foreground)"
          >· confirm or edit the learner's selection</span
        >{/if}
    </h3>
    {#if detail.permissions.canReview}
      <CriteriaPicker {tree} bind:selected {metIds} idPrefix="rev-crit" disabled={busy !== null} />
    {:else if detail.criteria.length === 0}
      <p class="text-sm text-(--muted-foreground)">No criteria mapped.</p>
    {:else}
      {#each detail.criteria as q (q.id)}
        {#each q.units as u (u.id)}
          <div class="rounded-md border p-2.5">
            <p class="text-sm font-medium">{u.code ? `${u.code} · ` : ''}{u.title}</p>
            <ul class="mt-1 space-y-0.5 text-sm">
              {#each u.criteria as c (c.id)}
                <li>
                  <span class="font-medium">{c.code}</span> <span class="text-(--muted-foreground)">{c.text}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      {/each}
    {/if}
  </section>

  {#if detail.permissions.canReview}
    <section class="space-y-2" aria-label="Review">
      <label for="review-note" class="text-sm font-semibold">Note to the learner (optional)</label>
      <Textarea id="review-note" class="min-h-[72px]!" maxlength={APPR_NOTE_MAX} bind:value={note} />
      {#if error}
        <p
          role="alert"
          class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
        >
          {error}
        </p>
      {/if}
      <div class="flex justify-end gap-2">
        <Button variant="outline" loading={busy === 'REFER'} disabled={busy !== null} onclick={() => decide('REFER')}>
          Refer
        </Button>
        <Button
          loading={busy === 'ACCEPT'}
          disabled={busy !== null || selected.length === 0}
          onclick={() => decide('ACCEPT')}
        >
          Accept
        </Button>
      </div>
      {#if selected.length === 0}
        <p class="text-right text-xs text-(--muted-foreground)">Select at least one criterion to accept.</p>
      {/if}
    </section>
  {/if}

  <EvidenceNotes evidenceId={ev.id} notes={detail.notes} onAdded={onNoteAdded} />
</div>
