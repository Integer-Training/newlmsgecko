<script lang="ts">
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import { Input } from '@cio/ui/base/input';
  import { Spinner } from '@cio/ui/base/spinner';
  import { snackbar } from '$features/ui/snackbar/store';
  import type { EnrolmentRow } from '../../api/enrolments.svelte';
  import { taskPlansApi } from '../../api/task-plans.svelte';
  import { fmtDate } from '../shared/format';

  // Pick learners (enrolments on the plan's programme) to give the plan's tasks to. Learners who already have the
  // plan are listed greyed out; assigning again only adds what is missing, and the result shows created / skipped.
  interface Props {
    open: boolean;
    planId: string;
    programmeId: string;
    /** Enrolment ids that already hold this plan. */
    assignedIds: Set<string>;
    onassigned: () => void | Promise<void>;
  }

  let { open = $bindable(), planId, programmeId, assignedIds, onassigned }: Props = $props();

  let rows = $state<EnrolmentRow[] | null>(null);
  let loadError = $state<string | null>(null);
  let search = $state('');
  let selected = $state<string[]>([]);
  let saving = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    rows = null;
    loadError = null;
    const res = await taskPlansApi.enrolmentsForProgramme(programmeId);
    if (res.ok) rows = res.data;
    else loadError = res.error;
  }

  $effect(() => {
    if (!open) return;
    selected = [];
    search = '';
    error = null;
    load();
  });

  const available = $derived((rows ?? []).filter((r) => !assignedIds.has(r.id)));
  const visible = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return available.filter((r) => !q || `${r.learner.name} ${r.learner.email ?? ''}`.toLowerCase().includes(q));
  });
  const chosen = $derived(new Set(selected));
  const allVisible = $derived(visible.length > 0 && visible.every((r) => chosen.has(r.id)));

  function toggle(id: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    selected = [...next];
  }

  function toggleAll(on: boolean) {
    const next = new Set(selected);
    for (const r of visible) {
      if (on) next.add(r.id);
      else next.delete(r.id);
    }
    selected = [...next];
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (selected.length === 0 || saving) return;
    saving = true;
    error = null;
    const res = await taskPlansApi.assign(planId, selected);
    saving = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    const { created, skipped } = res.data;
    snackbar.success(
      `${created} task${created === 1 ? '' : 's'} created` + (skipped > 0 ? `, ${skipped} already assigned` : '')
    );
    open = false;
    await onassigned();
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Assign learners</Dialog.Title>
      <Dialog.Description>
        Each chosen learner gets a copy of every task in this plan, due their start date plus the task’s months.
      </Dialog.Description>
    </Dialog.Header>

    <form onsubmit={submit} class="space-y-3">
      {#if loadError}
        <div class="flex flex-col items-center gap-3 py-6" role="alert">
          <p class="text-sm text-red-600">{loadError}</p>
          <Button type="button" variant="outline" onclick={load}>Try again</Button>
        </div>
      {:else if !rows}
        <div class="flex justify-center py-8"><Spinner /></div>
      {:else if rows.length === 0}
        <p class="py-6 text-center text-sm text-(--muted-foreground)">
          No learners are enrolled on this programme yet.
        </p>
      {:else if available.length === 0}
        <p class="py-6 text-center text-sm text-(--muted-foreground)">
          Every learner on this programme already has this plan.
        </p>
      {:else}
        <div class="flex flex-wrap items-center gap-3">
          <Input
            type="search"
            placeholder="Search learners"
            aria-label="Search learners"
            class="ui:max-w-xs"
            bind:value={search}
          />
          <label class="flex items-center gap-2 text-sm">
            <Checkbox
              checked={allVisible}
              onCheckedChange={(v) => toggleAll(v === true)}
              aria-label="Select all shown learners"
            />
            Select all
          </label>
          <span class="ml-auto text-sm text-(--muted-foreground)" aria-live="polite">{selected.length} selected</span>
        </div>
        <ul class="max-h-80 overflow-y-auto rounded-md border">
          {#each visible as r (r.id)}
            <li class="border-b last:border-b-0">
              <label class="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-(--muted)/40">
                <Checkbox checked={chosen.has(r.id)} onCheckedChange={(v) => toggle(r.id, v === true)} />
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-medium">{r.learner.name}</span>
                  {#if r.learner.email}
                    <span class="block truncate text-xs text-(--muted-foreground)">{r.learner.email}</span>
                  {/if}
                </span>
                <span class="shrink-0 text-xs text-(--muted-foreground)">
                  {r.startDate ? `Starts ${fmtDate(r.startDate)}` : 'No start date'}
                </span>
              </label>
            </li>
          {:else}
            <li class="p-3 text-sm text-(--muted-foreground)">No learners match.</li>
          {/each}
        </ul>
        {#if assignedIds.size > 0}
          <p class="text-xs text-(--muted-foreground)">
            {assignedIds.size} learner{assignedIds.size === 1 ? '' : 's'} already assigned are not listed. Learners without
            a start date get tasks with no due date until one is set.
          </p>
        {/if}
      {/if}

      {#if error}
        <p
          role="alert"
          class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
        >
          {error}
        </p>
      {/if}

      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (open = false)} disabled={saving}>Cancel</Button>
        <Button type="submit" disabled={selected.length === 0 || saving} loading={saving}>
          Assign {selected.length > 0 ? `${selected.length} learner${selected.length === 1 ? '' : 's'}` : ''}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
