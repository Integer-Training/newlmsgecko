<script lang="ts">
  import { Button } from '@cio/ui/base/button';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import { Search } from '@cio/ui/custom/search';
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import UserMinusIcon from '@lucide/svelte/icons/user-minus';
  import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
  import { currentOrg } from '$lib/utils/store/org';
  import { snackbar } from '$features/ui/snackbar/store';
  import { taskPlansApi, type TaskPlan, type TaskPlanAssignee } from '../../api/task-plans.svelte';
  import { fmtDate } from '../shared/format';
  import ConfirmDeleteDialog from '../programme/confirm-delete-dialog.svelte';
  import AssignDialog from './assign-dialog.svelte';

  // Learners holding this plan: assign more, push plan edits to their not-yet-started tasks, or unassign (tasks that
  // are already answered are kept).
  interface Props {
    plan: TaskPlan;
    taskCount: number;
    assignees: TaskPlanAssignee[];
    onchanged: () => void | Promise<void>;
  }

  let { plan, taskCount, assignees, onchanged }: Props = $props();

  let search = $state('');
  let selected = $state<string[]>([]);
  let assignOpen = $state(false);
  let unassignOpen = $state(false);
  let unassigning = $state(false);
  let syncing = $state(false);

  const todayIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const outsideWindow = $derived.by(() => {
    const t = todayIso();
    return (!!plan.validFrom && t < plan.validFrom) || (!!plan.validTo && t > plan.validTo);
  });
  const blockReason = $derived(
    plan.status !== 'ACTIVE'
      ? 'This plan is archived. Restore it to assign more learners.'
      : outsideWindow
        ? `This plan can only be assigned between ${plan.validFrom ? fmtDate(plan.validFrom) : 'any time'} and ${plan.validTo ? fmtDate(plan.validTo) : 'any time'}. Change the dates above to assign today.`
        : taskCount === 0
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
    snackbar.success(
      res.data.updated === 0
        ? 'Assigned learners are already up to date'
        : `Updated ${res.data.updated} task${res.data.updated === 1 ? '' : 's'}`
    );
    await onchanged();
  }

  async function confirmUnassign() {
    unassigning = true;
    const res = await taskPlansApi.unassign(plan.id, selected);
    unassigning = false;
    if (!res.ok) {
      snackbar.error(res.error);
      return;
    }
    snackbar.success(`Removed ${res.data.removed} task${res.data.removed === 1 ? '' : 's'}`);
    unassignOpen = false;
    selected = [];
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
        <UserPlusIcon class="size-4" /> Assign learners
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
        <li class="flex items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0">
          <Checkbox
            checked={chosen.has(a.enrolmentId)}
            onCheckedChange={(v) => toggle(a.enrolmentId, v === true)}
            aria-label="Select {a.learnerName}"
          />
          <a href="{base}/{a.enrolmentId}" class="min-w-0 flex-1 truncate font-medium hover:underline">
            {a.learnerName}
          </a>
          <span class="hidden shrink-0 text-xs text-(--muted-foreground) sm:inline">
            {a.startDate ? `Started ${fmtDate(a.startDate)}` : 'No start date'}
          </span>
          <span class="shrink-0 text-xs tabular-nums">{a.completeCount}/{a.taskCount} complete</span>
        </li>
      {:else}
        <li class="p-3 text-sm text-(--muted-foreground)">No learners match.</li>
      {/each}
    </ul>
  {/if}
</section>

<AssignDialog
  bind:open={assignOpen}
  planId={plan.id}
  programmeId={plan.programmeId}
  {assignedIds}
  onassigned={onchanged}
/>

<ConfirmDeleteDialog
  bind:open={unassignOpen}
  title="Unassign {selected.length} learner{selected.length === 1 ? '' : 's'}?"
  description="Tasks from this plan that these learners have not started are removed. Tasks already answered are kept."
  confirmLabel="Unassign"
  busy={unassigning}
  onconfirm={confirmUnassign}
/>
