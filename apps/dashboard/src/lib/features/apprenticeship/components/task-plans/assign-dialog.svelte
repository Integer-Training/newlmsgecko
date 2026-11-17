<script lang="ts">
  import { untrack } from 'svelte';
  import * as Dialog from '@cio/ui/base/dialog';
  import * as RadioGroup from '@cio/ui/base/radio-group';
  import * as Select from '@cio/ui/base/select';
  import { Button } from '@cio/ui/base/button';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import { Input } from '@cio/ui/base/input';
  import { Spinner } from '@cio/ui/base/spinner';
  import { taskDueDate, todayIso } from '@cio/utils/functions/apprenticeship-progress';
  import { snackbar } from '$features/ui/snackbar/store';
  import type { EnrolmentRow, TutorsInput } from '../../api/enrolments.svelte';
  import {
    PLAN_BATCH_SIZE,
    assignWarnings,
    dueBeforeStartProblem,
    taskPlansApi,
    type TaskPlanDetail,
    type TaskPlanItem
  } from '../../api/task-plans.svelte';
  import { fmtDate } from '../shared/format';

  // The one place plan tasks are given to learners: either the whole plan or selected tasks, to any number of
  // learners picked with filters. The data (plan, tasks, who holds what, the programme's learners) is loaded fresh
  // each time the dialog opens, so what the footer promises is what the server will do. The server skips anything a
  // learner already holds, so a repeat is harmless.
  interface Props {
    open: boolean;
    planId: string;
    /** Tasks to tick when opened from a task row; empty / omitted = the whole plan. */
    preselectItemIds?: string[];
    /** Called after the server changed anything (and after a failed attempt, so the page reloads from the server). */
    onassigned: () => void | Promise<void>;
  }

  let { open = $bindable(), planId, preselectItemIds = [], onassigned }: Props = $props();

  const NONE = '__none';

  let detail = $state<TaskPlanDetail | null>(null);
  let rows = $state<EnrolmentRow[] | null>(null);
  let loadError = $state<string | null>(null);

  let mode = $state<'WHOLE' | 'ITEMS'>('WHOLE');
  let checkedItems = $state<string[]>([]);
  let search = $state('');
  let tutorFilter = $state('');
  let monthFilter = $state('');
  let onlyMissing = $state(true);
  let selected = $state<string[]>([]);
  let dueDate = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);
  // Monotonic id so a slow earlier load cannot overwrite a newer one.
  let loadSeq = 0;

  async function load(quiet = false) {
    const mine = ++loadSeq;
    loadError = null;
    if (!quiet) {
      detail = null;
      rows = null;
    }
    const detailRes = await taskPlansApi.detail(planId);
    if (mine !== loadSeq) return;
    if (!detailRes.ok) {
      loadError = detailRes.error;
      return;
    }
    const rowsRes = await taskPlansApi.enrolmentsForProgramme(detailRes.data.plan.programmeId);
    if (mine !== loadSeq) return;
    if (!rowsRes.ok) {
      loadError = rowsRes.error;
      return;
    }
    detail = detailRes.data;
    rows = rowsRes.data;
    // Forget ticks for tasks / learners that no longer exist.
    const itemIds = new Set(detailRes.data.items.map((i) => i.id));
    const rowIds = new Set(rowsRes.data.map((r) => r.id));
    checkedItems = checkedItems.filter((id) => itemIds.has(id));
    selected = selected.filter((id) => rowIds.has(id));
  }

  // Fresh state each time the dialog opens.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      const pre = preselectItemIds ?? [];
      mode = pre.length > 0 ? 'ITEMS' : 'WHOLE';
      checkedItems = [...pre];
      search = '';
      tutorFilter = '';
      monthFilter = '';
      onlyMissing = true;
      selected = [];
      dueDate = '';
      error = null;
      saving = false;
      load();
    });
  });

  const items = $derived<TaskPlanItem[]>([...(detail?.items ?? [])].sort((a, b) => a.sequence - b.sequence));
  // What this assignment is about.
  const targets = $derived(mode === 'WHOLE' ? items : items.filter((i) => checkedItems.includes(i.id)));

  // Who holds what: enrolment id → set of plan task ids they already have.
  const held = $derived.by(() => {
    const map = new Map<string, Set<string>>();
    for (const a of detail?.assignees ?? []) map.set(a.enrolmentId, new Set(a.items.map((i) => i.itemId)));
    return map;
  });
  const missingFor = (enrolmentId: string) => {
    const has = held.get(enrolmentId);
    return has ? targets.filter((i) => !has.has(i.id)) : targets;
  };

  const blockReason = $derived.by(() => {
    if (!detail) return null;
    const plan = detail.plan;
    const t = todayIso();
    if (plan.status !== 'ACTIVE') return 'This plan is archived. Restore it to assign tasks.';
    if ((plan.validFrom && t < plan.validFrom) || (plan.validTo && t > plan.validTo)) {
      return `This plan can only be assigned between ${plan.validFrom ? fmtDate(plan.validFrom) : 'any time'} and ${plan.validTo ? fmtDate(plan.validTo) : 'any time'}.`;
    }
    if (detail.items.length === 0) return 'Add at least one task before assigning this plan.';
    return null;
  });

  // ── Filters ──
  const tutorEntries = (tutors: TutorsInput) =>
    ((tutors ?? []) as (string | { id?: string; name: string | null })[])
      .map((t) => (typeof t === 'string' ? { id: t, name: t } : { id: t?.id ?? '', name: t?.name ?? '' }))
      .filter((t) => t.id && t.name);

  const tutorOptions = $derived.by(() => {
    const byId = new Map<string, string>();
    for (const r of rows ?? []) for (const t of tutorEntries(r.tutors)) byId.set(t.id, t.name);
    return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  });
  const monthOptions = $derived.by(() => {
    const months = new Set<string>();
    for (const r of rows ?? []) if (r.startDate) months.add(r.startDate.slice(0, 7));
    return [...months].sort().map((value) => ({
      value,
      label: new Date(`${value}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    }));
  });
  const tutorLabel = $derived(
    tutorFilter === ''
      ? 'All tutors'
      : tutorFilter === NONE
        ? 'No tutor'
        : (tutorOptions.find((t) => t.id === tutorFilter)?.name ?? 'All tutors')
  );
  const monthLabel = $derived(
    monthFilter === ''
      ? 'Any start month'
      : monthFilter === NONE
        ? 'No start date'
        : (monthOptions.find((m) => m.value === monthFilter)?.label ?? 'Any start month')
  );

  const visible = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return (rows ?? []).filter((r) => {
      if (q && !`${r.learner.name} ${r.learner.email ?? ''}`.toLowerCase().includes(q)) return false;
      if (tutorFilter === NONE) {
        if (tutorEntries(r.tutors).length > 0) return false;
      } else if (tutorFilter && !tutorEntries(r.tutors).some((t) => t.id === tutorFilter)) return false;
      if (monthFilter === NONE) {
        if (r.startDate) return false;
      } else if (monthFilter && r.startDate?.slice(0, 7) !== monthFilter) return false;
      if (onlyMissing && targets.length > 0 && missingFor(r.id).length === 0) return false;
      return true;
    });
  });
  const chosen = $derived(new Set(selected));
  const allVisible = $derived(visible.length > 0 && visible.every((r) => chosen.has(r.id)));
  const hiddenSelected = $derived(selected.filter((id) => !visible.some((r) => r.id === id)).length);

  // ── Live summary (client-side; the server result is the truth and is shown after saving) ──
  const dueOverride = $derived(dueDate.trim() || null);
  const summary = $derived.by(() => {
    const today = todayIso();
    let created = 0;
    let alreadyHave = 0;
    let learners = 0;
    let overdue = 0;
    let noStart = 0;
    const toCreate: string[] = [];
    // Only learners who would actually receive a NEW task: the server checks a batch due date against exactly these.
    const recipients: { name: string; startDate: string | null }[] = [];
    for (const r of rows ?? []) {
      if (!chosen.has(r.id)) continue;
      const missing = missingFor(r.id);
      alreadyHave += targets.length - missing.length;
      if (missing.length === 0) continue;
      toCreate.push(r.id);
      recipients.push({ name: r.learner.name, startDate: r.startDate });
      learners += 1;
      created += missing.length;
      if (!dueOverride && !r.startDate) noStart += 1;
      for (const item of missing) {
        const due = dueOverride ?? taskDueDate(r.startDate, item.monthOffset);
        if (due && due < today) overdue += 1;
      }
    }
    return { created, alreadyHave, learners, overdue, noStart, toCreate, recipients };
  });

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const summaryText = $derived.by(() => {
    if (targets.length === 0) return 'Choose at least one task to assign.';
    if (selected.length === 0) return 'Choose the learners who should get these tasks.';
    if (summary.created === 0) return 'Nothing to create: every chosen learner already has these tasks.';
    return `Creates ${plural(summary.created, 'task')} for ${plural(summary.learners, 'learner')}`;
  });
  const summaryNotes = $derived.by(() => {
    const notes: string[] = [];
    if (summary.alreadyHave > 0) notes.push(`${summary.alreadyHave} already have them`);
    if (summary.overdue > 0) notes.push(`${summary.overdue} would be overdue today`);
    if (summary.noStart > 0) {
      notes.push(`${plural(summary.noStart, 'learner')} without a start date will get no due date`);
    }
    return notes;
  });
  const dueIsPast = $derived(!!dueOverride && dueOverride < todayIso());
  // The server refuses the WHOLE batch when the date is before any receiving learner's start; catching it here means
  // nothing is sent (so no chunk can be created before a later one fails).
  const dueProblem = $derived(dueBeforeStartProblem(dueOverride, summary.recipients));

  const canSubmit = $derived(
    !!detail && !blockReason && !saving && targets.length > 0 && summary.created > 0 && !dueProblem
  );

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

  function toggleItem(id: string, on: boolean) {
    const next = new Set(checkedItems);
    if (on) next.add(id);
    else next.delete(id);
    checkedItems = [...next];
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (!canSubmit) return;
    // Every chunk is covered by the check above (dueProblem looks at ALL learners who would receive a task).
    saving = true;
    error = null;
    const enrolmentIds = summary.toCreate;
    const itemIds = mode === 'ITEMS' ? targets.map((i) => i.id) : undefined;
    let created = 0;
    let skipped = 0;
    let learners = 0;
    let pastDue = 0;
    let undated = 0;
    let overrideInPast = false;
    let failure: string | null = null;
    // The API takes up to PLAN_BATCH_SIZE learners per call.
    for (let start = 0; start < enrolmentIds.length; start += PLAN_BATCH_SIZE) {
      const res = await taskPlansApi.assign(planId, {
        enrolmentIds: enrolmentIds.slice(start, start + PLAN_BATCH_SIZE),
        itemIds,
        dueDate: dueOverride
      });
      if (!res.ok) {
        failure = res.error;
        break;
      }
      created += res.data.created;
      skipped += res.data.skipped;
      learners += res.data.learners;
      pastDue += res.data.pastDue;
      undated += res.data.undated;
      overrideInPast = overrideInPast || res.data.overrideInPast;
    }
    saving = false;

    if (failure) {
      // 404 (a task was deleted meanwhile), 409 / 400 (plan archived or outside its dates, ...): say what the
      // server said, then show what is true now.
      const done =
        created > 0 ? ` ${plural(created, 'task')} for ${plural(learners, 'learner')} were created before this.` : '';
      snackbar.error(`${failure}${done}`);
      error = failure;
      await load(true);
      await onassigned();
      return;
    }

    const message =
      `${plural(created, 'task')} created for ${plural(learners, 'learner')}` +
      (skipped > 0 ? `, ${skipped} already assigned` : '');
    const warning = assignWarnings({ pastDue, undated, overrideInPast });
    if (warning) snackbar.info(`${message}. ${warning}`);
    else snackbar.success(message);
    open = false;
    await onassigned();
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Assign tasks</Dialog.Title>
      <Dialog.Description>
        Give this plan’s tasks to learners. Each task is due the learner’s start date plus its months, unless you set a
        due date for this batch below. Tasks a learner already has are never duplicated.
      </Dialog.Description>
    </Dialog.Header>

    <form onsubmit={submit} class="space-y-4">
      {#if loadError}
        <div class="flex flex-col items-center gap-3 py-6" role="alert">
          <p class="text-sm text-red-600">{loadError}</p>
          <Button type="button" variant="outline" onclick={() => load()}>Try again</Button>
        </div>
      {:else if !detail || !rows}
        <div class="flex justify-center py-8"><Spinner /></div>
      {:else}
        {#if blockReason}
          <p
            role="status"
            class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
          >
            {blockReason}
          </p>
        {/if}

        <!-- What -->
        <fieldset class="space-y-2">
          <legend class="text-sm font-medium">What to assign</legend>
          <RadioGroup.Root bind:value={mode} class="flex flex-wrap gap-x-6 gap-y-2">
            <label class="flex items-center gap-2 text-sm">
              <RadioGroup.Item value="WHOLE" id="ad-mode-whole" /> Whole plan ({plural(items.length, 'task')})
            </label>
            <label class="flex items-center gap-2 text-sm">
              <RadioGroup.Item value="ITEMS" id="ad-mode-items" /> Selected tasks
            </label>
          </RadioGroup.Root>
          {#if mode === 'ITEMS'}
            <ul class="max-h-40 overflow-y-auto rounded-md border">
              {#each items as item (item.id)}
                <li class="border-b last:border-b-0">
                  <label class="flex cursor-pointer items-center gap-3 px-3 py-1.5 text-sm hover:bg-(--muted)/40">
                    <Checkbox
                      checked={checkedItems.includes(item.id)}
                      onCheckedChange={(v) => toggleItem(item.id, v === true)}
                    />
                    <span class="min-w-0 flex-1 truncate">{item.title}</span>
                    <span class="shrink-0 text-xs text-(--muted-foreground)">
                      {item.monthOffset === 0 ? 'At start' : `Start + ${plural(item.monthOffset, 'month')}`}
                    </span>
                  </label>
                </li>
              {/each}
            </ul>
          {/if}
        </fieldset>

        <!-- Who -->
        {#if rows.length === 0}
          <p class="py-4 text-center text-sm text-(--muted-foreground)">
            No learners are enrolled on this programme yet.
          </p>
        {:else}
          <div class="space-y-2">
            <p class="text-sm font-medium">Who gets them</p>
            <div class="flex flex-wrap items-center gap-2">
              <Input
                type="search"
                placeholder="Search learners"
                aria-label="Search learners"
                class="ui:max-w-52"
                bind:value={search}
              />
              <Select.Root type="single" bind:value={tutorFilter}>
                <Select.Trigger class="ui:w-44" aria-label="Filter by tutor">
                  <p class="truncate">{tutorLabel}</p>
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="">All tutors</Select.Item>
                  <Select.Item value={NONE}>No tutor</Select.Item>
                  {#each tutorOptions as t (t.id)}
                    <Select.Item value={t.id}>{t.name}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
              <Select.Root type="single" bind:value={monthFilter}>
                <Select.Trigger class="ui:w-44" aria-label="Filter by start month">
                  <p class="truncate">{monthLabel}</p>
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="">Any start month</Select.Item>
                  <Select.Item value={NONE}>No start date</Select.Item>
                  {#each monthOptions as m (m.value)}
                    <Select.Item value={m.value}>{m.label}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
            </div>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label class="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={allVisible}
                  onCheckedChange={(v) => toggleAll(v === true)}
                  aria-label="Select all shown learners"
                />
                Select all shown ({visible.length})
              </label>
              <label class="flex items-center gap-2 text-sm">
                <Checkbox checked={onlyMissing} onCheckedChange={(v) => (onlyMissing = v === true)} />
                Only learners missing these tasks
              </label>
              <span class="ml-auto text-sm text-(--muted-foreground)" aria-live="polite">
                {selected.length} selected{hiddenSelected > 0 ? ` (${hiddenSelected} not shown)` : ''}
              </span>
            </div>
            <ul class="max-h-64 overflow-y-auto rounded-md border">
              {#each visible as r (r.id)}
                {@const missing = missingFor(r.id).length}
                <li class="border-b last:border-b-0">
                  <label class="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-(--muted)/40">
                    <Checkbox checked={chosen.has(r.id)} onCheckedChange={(v) => toggle(r.id, v === true)} />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate font-medium">{r.learner.name}</span>
                      {#if r.learner.email}
                        <span class="block truncate text-xs text-(--muted-foreground)">{r.learner.email}</span>
                      {/if}
                    </span>
                    {#if targets.length > 0}
                      <span class="shrink-0 text-xs text-(--muted-foreground)">
                        {missing === 0 ? 'Has all of these' : `Has ${targets.length - missing} of ${targets.length}`}
                      </span>
                    {/if}
                    <span class="shrink-0 text-xs text-(--muted-foreground)">
                      {r.startDate ? `Starts ${fmtDate(r.startDate)}` : 'No start date'}
                    </span>
                  </label>
                </li>
              {:else}
                <li class="p-3 text-sm text-(--muted-foreground)">
                  {onlyMissing && targets.length > 0
                    ? 'No learners to show. Everyone matching the other filters already has these tasks — untick “Only learners missing these tasks” to see them.'
                    : 'No learners match.'}
                </li>
              {/each}
            </ul>
          </div>

          <!-- Optional batch due date -->
          <div class="space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <label for="ad-due" class="text-sm font-medium">Due date for this batch (optional)</label>
              <Input
                id="ad-due"
                type="date"
                class="ui:w-44"
                bind:value={dueDate}
                aria-describedby="ad-due-hint"
                aria-invalid={!!dueProblem}
              />
              {#if dueDate}
                <Button type="button" variant="ghost" size="sm" onclick={() => (dueDate = '')}>Clear</Button>
              {/if}
            </div>
            <p id="ad-due-hint" class="text-xs text-(--muted-foreground)">
              Leave empty to use each learner’s start date plus the task’s months. A date set here applies only to the
              tasks created now and is kept, even if the task is edited later or the learner’s start date changes.
              Learners without a start date also get this date.
            </p>
            {#if dueProblem}
              <p id="ad-due-error" role="alert" class="text-xs text-rose-700 dark:text-rose-300">{dueProblem}</p>
            {:else if dueIsPast}
              <p role="status" class="text-xs text-amber-700 dark:text-amber-300">
                This date has already passed, so these tasks will be overdue as soon as they are created.
              </p>
            {/if}
          </div>

          <!-- Live summary -->
          <div class="rounded-md border bg-(--muted)/40 px-3 py-2 text-sm" aria-live="polite">
            <p class="font-medium">{summaryText}</p>
            {#if summaryNotes.length > 0 && selected.length > 0 && targets.length > 0}
              <p class="mt-0.5 text-xs text-(--muted-foreground)">
                {#each summaryNotes as note, i (note)}
                  {#if i > 0}
                    ·
                  {/if}
                  <span class={note.includes('overdue') ? 'font-medium text-amber-700 dark:text-amber-300' : ''}
                    >{note}</span
                  >
                {/each}
              </p>
            {/if}
          </div>
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
        <Button type="submit" disabled={!canSubmit} loading={saving}>
          {summary.created > 0 ? `Assign ${plural(summary.created, 'task')}` : 'Assign'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
