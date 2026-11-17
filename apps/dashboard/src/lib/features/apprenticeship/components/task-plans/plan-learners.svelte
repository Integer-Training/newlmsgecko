<script lang="ts">
  import { Button } from '@cio/ui/base/button';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import { Search } from '@cio/ui/custom/search';
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import UserMinusIcon from '@lucide/svelte/icons/user-minus';
  import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import XIcon from '@lucide/svelte/icons/x';
  import { currentOrg } from '$lib/utils/store/org';
  import { snackbar } from '$features/ui/snackbar/store';
  import { todayIso } from '@cio/utils/functions/apprenticeship-progress';
  import {
    PLAN_BATCH_SIZE,
    taskPlansApi,
    type TaskPlan,
    type TaskPlanAssignee,
    type TaskPlanItem
  } from '../../api/task-plans.svelte';
  import TutorCell from '../shared/tutor-cell.svelte';
  import TaskStatusChip from '../shared/task-status-chip.svelte';
  import { fmtDate } from '../shared/format';
  import ConfirmDeleteDialog from '../programme/confirm-delete-dialog.svelte';
  import AssignDialog from './assign-dialog.svelte';

  // Learners holding this plan: assign more, push plan edits to their not-yet-started tasks, or unassign (tasks that
  // are already answered are kept). Each learner shows "Whole plan" or "k of n tasks"; expand a row to see every
  // task's status, and remove a single task that has not been started.
  interface Props {
    plan: TaskPlan;
    assignees: TaskPlanAssignee[];
    /** The plan's tasks (titles for the expanded rows). */
    items: TaskPlanItem[];
    onchanged: () => void | Promise<void>;
  }

  let { plan, assignees, items, onchanged }: Props = $props();

  let search = $state('');
  let selected = $state<string[]>([]);
  let assignOpen = $state(false);
  let unassignOpen = $state(false);
  let unassigning = $state(false);
  let syncing = $state(false);
  let expanded = $state<string[]>([]);
  let removing = $state<{ assignee: TaskPlanAssignee; item: TaskPlanItem } | null>(null);
  let removeOpen = $state(false);
  let removeBusy = $state(false);

  const outsideWindow = $derived.by(() => {
    const t = todayIso();
    return (!!plan.validFrom && t < plan.validFrom) || (!!plan.validTo && t > plan.validTo);
  });
  const blockReason = $derived(
    plan.status !== 'ACTIVE'
      ? 'This plan is archived. Restore it to assign more learners.'
      : outsideWindow
        ? `This plan can only be assigned between ${plan.validFrom ? fmtDate(plan.validFrom) : 'any time'} and ${plan.validTo ? fmtDate(plan.validTo) : 'any time'}. Change the dates above to assign today.`
        : items.length === 0
          ? 'Add at least one task before assigning this plan.'
          : null
  );

  const assignedIds = $derived(new Set(assignees.map((a) => a.enrolmentId)));
  const visible = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return q ? assignees.filter((a) => a.learnerName.toLowerCase().includes(q)) : assignees;
  });
  const chosen = $derived(new Set(selected));
  const allVisible = $derived(visible.length > 0 && visible.every((a) => chosen.has(a.enrolmentId)));
  const base = $derived(`/org/${$currentOrg.siteName}/apprenticeships/learners`);

  const planItems = $derived([...items].sort((a, b) => a.sequence - b.sequence));
  const itemTotal = $derived(items.length);

  function toggleExpanded(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = [...next];
  }

  // Drop selections for learners no longer listed.
  $effect(() => {
    const ids = assignedIds;
    if (selected.some((id) => !ids.has(id))) selected = selected.filter((id) => ids.has(id));
  });

  function toggle(id: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    selected = [...next];
  }

  function toggleAll(on: boolean) {
    const next = new Set(selected);
    for (const a of visible) {
      if (on) next.add(a.enrolmentId);
      else next.delete(a.enrolmentId);
    }
    selected = [...next];
  }

  async function sync() {
    syncing = true;
    const res = await taskPlansApi.sync(plan.id);
    syncing = false;
    if (!res.ok) {
      snackbar.error(res.error);
      return;
    }
    const { updated, manualDueKept } = res.data;
    const headline =
      updated === 0 ? 'Assigned learners are already up to date' : `Updated ${updated} task${updated === 1 ? '' : 's'}`;
    const manual =
      manualDueKept > 0
        ? ` · kept the hand-set due date on ${manualDueKept} task${manualDueKept === 1 ? '' : 's'}`
        : '';
    snackbar.success(headline + manual);
    await onchanged();
  }

  async function confirmUnassign() {
    unassigning = true;
    let removed = 0;
    let kept = 0;
    let failure: string | null = null;
    // The API takes up to PLAN_BATCH_SIZE learners per call; stop at the first error and say what was done before it.
    for (let from = 0; from < selected.length; from += PLAN_BATCH_SIZE) {
      const res = await taskPlansApi.unassign(plan.id, selected.slice(from, from + PLAN_BATCH_SIZE));
      if (!res.ok) {
        failure = res.error;
        break;
      }
      removed += res.data.removed;
      kept += res.data.kept;
    }
    unassigning = false;
    if (failure) {
      const done = removed > 0 ? ` ${removed} task${removed === 1 ? ' was' : 's were'} removed before this.` : '';
      snackbar.error(`${failure}${done}`);
      unassignOpen = false;
      await onchanged();
      return;
    }
    snackbar.success(
      `Removed ${removed} task${removed === 1 ? '' : 's'}` + (kept > 0 ? `, kept ${kept} already started` : '')
    );
    unassignOpen = false;
    selected = [];
    await onchanged();
  }

  function askRemove(assignee: TaskPlanAssignee, item: TaskPlanItem) {
    removing = { assignee, item };
    removeOpen = true;
  }

  async function confirmRemove() {
    if (!removing) return;
    const { assignee, item } = removing;
    removeBusy = true;
    const res = await taskPlansApi.unassign(plan.id, [assignee.enrolmentId], [item.id]);
    removeBusy = false;
    removeOpen = false;
    if (!res.ok) {
      snackbar.error(res.error);
    } else if (res.data.removed > 0) {
      snackbar.success(`Removed “${item.title}” from ${assignee.learnerName}`);
    } else {
      snackbar.error(`“${item.title}” was kept: ${assignee.learnerName} has already started it.`);
    }
    await onchanged();
  }
</script>

<section class="flex flex-col gap-3 rounded-xl border bg-(--card) p-4" aria-labelledby="tp-learners-h">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h2 id="tp-learners-h" class="text-lg font-semibold tracking-tight">
      Assigned learners <span class="text-sm font-normal text-(--muted-foreground)">({assignees.length})</span>
    </h2>
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onclick={sync} loading={syncing} disabled={assignees.length === 0}>
        <RefreshCwIcon class="size-4" /> Update assigned learners
      </Button>
      <Button size="sm" onclick={() => (assignOpen = true)} disabled={!!blockReason}>
        <UserPlusIcon class="size-4" /> Assign tasks
      </Button>
    </div>
  </div>

  {#if blockReason}
    <p
      role="status"
      class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
    >
      {blockReason}
    </p>
  {/if}
  <p class="text-xs text-(--muted-foreground)">
    “Update assigned learners” copies later edits to the plan’s tasks onto learners’ tasks they have not started yet.
    Due dates set for a batch or changed by hand are left as they are.
  </p>

  {#if assignees.length === 0}
    <p class="rounded-md border border-dashed p-6 text-center text-sm text-(--muted-foreground)">
      No learners have this plan yet.
    </p>
  {:else}
    <div class="flex flex-wrap items-center gap-3">
      <Search placeholder="Search learners" bind:value={search} />
      <label class="flex items-center gap-2 text-sm">
        <Checkbox
          checked={allVisible}
          onCheckedChange={(v) => toggleAll(v === true)}
          aria-label="Select all shown learners"
        />
        Select all
      </label>
      <Button
        variant="outline"
        size="sm"
        class="ml-auto"
        disabled={selected.length === 0}
        onclick={() => (unassignOpen = true)}
      >
        <UserMinusIcon class="size-4" /> Unassign{selected.length > 0 ? ` (${selected.length})` : ''}
      </Button>
    </div>

    <ul class="rounded-md border">
      {#each visible as a (a.enrolmentId)}
        {@const isOpen = expanded.includes(a.enrolmentId)}
        <li class="border-b text-sm last:border-b-0">
          <div class="flex items-center gap-3 px-3 py-2">
            <Checkbox
              checked={chosen.has(a.enrolmentId)}
              onCheckedChange={(v) => toggle(a.enrolmentId, v === true)}
              aria-label="Select {a.learnerName}"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-expanded={isOpen}
              aria-label="{isOpen ? 'Hide' : 'Show'} tasks for {a.learnerName}"
              onclick={() => toggleExpanded(a.enrolmentId)}
            >
              {#if isOpen}<ChevronDownIcon class="size-4" />{:else}<ChevronRightIcon class="size-4" />{/if}
            </Button>
            <a href="{base}/{a.enrolmentId}" class="min-w-0 flex-1 truncate font-medium hover:underline">
              {a.learnerName}
            </a>
            <span
              class="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap {a.wholePlan
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300'
                : 'bg-(--muted) text-(--muted-foreground)'}"
            >
              {a.wholePlan ? 'Whole plan' : `${a.heldCount} of ${itemTotal} task${itemTotal === 1 ? '' : 's'}`}
            </span>
            <span class="hidden shrink-0 text-xs text-(--muted-foreground) sm:inline">
              {a.startDate ? `Started ${fmtDate(a.startDate)}` : 'No start date'}
            </span>
            <span class="hidden shrink-0 sm:inline"><TutorCell tutors={a.tutors} /></span>
            {#if a.overdueCount > 0}
              <span
                class="inline-flex shrink-0 items-center rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-rose-800 dark:bg-rose-500/20 dark:text-rose-300"
                >{a.overdueCount} overdue</span
              >
            {/if}
            <span class="shrink-0 text-xs tabular-nums">{a.completeCount}/{a.taskCount} complete</span>
          </div>
          {#if isOpen}
            <ul class="mr-3 mb-3 ml-12 space-y-1 rounded-md bg-(--muted)/30 p-2">
              {#each planItems as item (item.id)}
                {@const cell = a.items.find((c) => c.itemId === item.id)}
                <li class="flex flex-wrap items-center gap-2 text-xs">
                  <span class="min-w-0 flex-1 truncate">{item.title}</span>
                  {#if cell}
                    <TaskStatusChip status={cell.status} />
                    <span class="w-28 shrink-0 text-(--muted-foreground)">
                      {cell.dueDate
                        ? `Due ${fmtDate(cell.dueDate)}${cell.dueManual ? ' (set by hand)' : ''}`
                        : 'No due date'}
                    </span>
                    {#if cell.status === 'PLANNED'}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Remove {item.title} from {a.learnerName}"
                        onclick={() => askRemove(a, item)}
                      >
                        <XIcon class="size-3.5" />
                      </Button>
                    {:else}
                      <span class="size-8 shrink-0"></span>
                    {/if}
                  {:else}
                    <span class="text-(--muted-foreground)">Not assigned</span>
                  {/if}
                </li>
              {:else}
                <li class="text-xs text-(--muted-foreground)">Loading tasks…</li>
              {/each}
            </ul>
          {/if}
        </li>
      {:else}
        <li class="p-3 text-sm text-(--muted-foreground)">No learners match.</li>
      {/each}
    </ul>
  {/if}
</section>

<AssignDialog bind:open={assignOpen} planId={plan.id} onassigned={onchanged} />

<ConfirmDeleteDialog
  bind:open={removeOpen}
  title="Remove this task?"
  description="“{removing?.item.title ?? ''}” is removed from {removing?.assignee.learnerName ??
    'the learner'}. Only tasks they have not started can be removed."
  confirmLabel="Remove task"
  busy={removeBusy}
  onconfirm={confirmRemove}
/>

<ConfirmDeleteDialog
  bind:open={unassignOpen}
  title="Unassign {selected.length} learner{selected.length === 1 ? '' : 's'}?"
  description="The whole plan is unassigned: every task from it that these learners have not started is removed. Tasks they have already started or answered are kept."
  confirmLabel="Unassign"
  busy={unassigning}
  onconfirm={confirmUnassign}
/>
