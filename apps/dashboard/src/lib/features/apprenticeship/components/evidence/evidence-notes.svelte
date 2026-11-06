<script lang="ts">
  import { Button } from '@cio/ui/base/button';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import { Textarea } from '@cio/ui/base/textarea';
  import { APPR_NOTE_MAX } from '@cio/utils/constants/apprenticeship';
  import { evidenceApi, type EvidenceNote } from '../../api/evidence.svelte';
  import { fmtDate } from '../shared/format';

  // Notes timeline for one piece of evidence: All / Audit / General filter plus an add-note box. AUDIT notes are the
  // system trail (status changes); staff can also write one by hand.

  interface Props {
    evidenceId: string;
    notes: EvidenceNote[];
    onAdded: (note: EvidenceNote) => void;
  }
  let { evidenceId, notes, onAdded }: Props = $props();

  let filter = $state<'ALL' | 'AUDIT' | 'GENERAL'>('ALL');
  let body = $state('');
  let audit = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);

  const shown = $derived(filter === 'ALL' ? notes : notes.filter((n) => n.kind === filter));

  async function add() {
    if (!body.trim() || saving) return;
    saving = true;
    error = null;
    const res = await evidenceApi.addNote(evidenceId, { body: body.trim(), kind: audit ? 'AUDIT' : 'GENERAL' });
    saving = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    body = '';
    audit = false;
    onAdded(res.data);
  }
</script>

<section class="space-y-3" aria-label="Notes">
  <div class="flex items-center justify-between">
    <h3 class="text-sm font-semibold">Notes</h3>
    <div class="flex gap-1" role="group" aria-label="Filter notes">
      {#each ['ALL', 'AUDIT', 'GENERAL'] as const as f (f)}
        <button
          type="button"
          aria-pressed={filter === f}
          class="rounded-full border px-2.5 py-0.5 text-xs {filter === f
            ? 'bg-primary text-primary-foreground border-primary'
            : 'hover:bg-muted'}"
          onclick={() => (filter = f)}
        >
          {f === 'ALL' ? 'All' : f === 'AUDIT' ? 'Audit' : 'General'}
        </button>
      {/each}
    </div>
  </div>

  {#if shown.length === 0}
    <p class="text-muted-foreground text-sm">No notes yet.</p>
  {:else}
    <ol class="space-y-2">
      {#each shown as n (n.id)}
        <li class="rounded-md border p-2.5 text-sm {n.kind === 'AUDIT' ? 'bg-muted/40' : ''}">
          <div class="text-muted-foreground mb-1 flex flex-wrap items-center gap-2 text-xs">
            <span class="font-medium">{n.authorName ?? 'System'}</span>
            <span>{fmtDate(n.createdAt)}</span>
            <span class="bg-muted rounded px-1.5 py-0.5">{n.kind === 'AUDIT' ? 'Audit' : 'General'}</span>
          </div>
          <p class="whitespace-pre-wrap">{n.body}</p>
        </li>
      {/each}
    </ol>
  {/if}

  <div class="space-y-1.5">
    <label for="note-body-{evidenceId}" class="sr-only">Add a note</label>
    <Textarea
      id="note-body-{evidenceId}"
      class="ui:min-h-[64px]"
      placeholder="Add a note…"
      maxlength={APPR_NOTE_MAX}
      bind:value={body}
    />
    <div class="flex items-center justify-between gap-2">
      <label class="flex items-center gap-2 text-sm">
        <Checkbox bind:checked={audit} />
        Audit note
      </label>
      <Button type="button" size="sm" loading={saving} disabled={!body.trim() || saving} onclick={add}>Add note</Button>
    </div>
    {#if error}<p role="alert" class="text-sm text-rose-600">{error}</p>{/if}
  </div>
</section>
