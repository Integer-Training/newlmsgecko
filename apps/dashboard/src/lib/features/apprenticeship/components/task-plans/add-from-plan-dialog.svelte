<script lang="ts">
  import { untrack } from 'svelte';
  import * as Dialog from '@cio/ui/base/dialog';
  import * as Select from '@cio/ui/base/select';
  import { Button } from '@cio/ui/base/button';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import { Input } from '@cio/ui/base/input';
  import { Spinner } from '@cio/ui/base/spinner';
  import { todayIso } from '@cio/utils/functions/apprenticeship-progress';
  import { snackbar } from '$features/ui/snackbar/store';
  import { tasksApi, type PlanItemsPlan } from '../../api/tasks.svelte';
  import { assignWarnings } from '../../api/task-plans.svelte';
  import { fmtDate } from '../shared/format';

  // Staff: give this one learner chosen tasks from a task plan of their programme (the plan page itself is
  // admin-only). Tasks the learner already holds are not offered. Opened from the portfolio Tasks tab.
  interface Props {
    open: boolean;
    enrolmentId: string;
    /** The learner's start date: tasks are due start + the task's months (none without a start date). */
    startDate: string | null;
    /** Called after tasks were created, or after a failed attempt, so the tab reloads from the server. */
    onadded: () => void | Promise<void>;
  }

  let { open = $bindable(), enrolmentId, startDate, onadded }: Props = $props();

  let plans = $state<PlanItemsPlan[] | null>(null);
  let loadError = $state<string | null>(null);
  let planId = $state('');
  let checked = $state<string[]>([]);
  let dueDate = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);
  let loadSeq = 0;

  async function load(quiet = false) {
    const mine = ++loadSeq;
    loadError = null;
    if (!quiet) plans = null;
    const res = await tasksApi.planItems(enrolmentId);
    if (mine !== loadSeq) return;
    if (!res.ok) {
      loadError = res.error;
      return;
    }
    plans = res.data;
    // Keep the chosen plan if it is still offered; otherwise pick the only plan (or none). Drop ticks that vanished.
    if (!res.data.some((p) => p.id === planId)) planId = res.data.length === 1 ? res.data[0].id : '';
    const offered = new Set(
      (res.data.find((p) => p.id === planId)?.items ?? []).filter((i) => !i.held).map((i) => i.id)
    );
    checked = checked.filter((id) => offered.has(id));
  }

  $effect(() => {
    if (!open) return;
    untrack(() => {
      planId = '';
      checked = [];
      dueDate = '';
      error = null;
      saving = false;
      load();
    });
  });

  const plan = $derived(plans?.find((p) => p.id === planId) ?? null);
  const available = $derived([...(plan?.items ?? [])].filter((i) => !i.held));
  const heldCount = $derived((plan?.items ?? []).filter((i) => i.held).length);
  const allChecked = $derived(available.length > 0 && available.every((i) => checked.includes(i.id)));
  const dueOverride = $derived(dueDate.trim() || null);
  const dueFor = (item: PlanItemsPlan['items'][number]) => dueOverride ?? item.dueDate;
  const overdueCount = $derived(
    available.filter((i) => {
      if (!checked.includes(i.id)) return false;
      const due = dueFor(i);
      return !!due && due < todayIso();
    }).length
  );
  // The server refuses a batch due date before the learner's start date; say so up front and keep Submit off.
  const dueProblem = $derived(
    dueOverride && startDate && dueOverride < startDate.slice(0, 10)
      ? `That due date is before this learner’s start date (${fmtDate(startDate)}). Choose a later date.`
      : null
  );
  const planLabel = $derived(plan?.title ?? 'Choose a plan');

  function pickPlan(id: string) {
    planId = id;
    checked = [];
  }

  function toggle(id: string, on: boolean) {
    const next = new Set(checked);
    if (on) next.add(id);
    else next.delete(id);
    checked = [...next];
  }

  function toggleAll(on: boolean) {
    checked = on ? available.map((i) => i.id) : [];
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (!plan || checked.length === 0 || saving || dueProblem) return;
    saving = true;
    error = null;
    const res = await tasksApi.fromPlan(enrolmentId, {
      planId: plan.id,
      itemIds: checked,
      dueDate: dueOverride
    });
    saving = false;
    if (!res.ok) {
      // 404 (task or plan gone), 409 / 400 (plan archived or outside its dates): show it and what is true now.
      snackbar.error(res.error);
      error = res.error;
      await load(true);
      await onadded();
      return;
    }
    const { created, pastDue, undated, overrideInPast } = res.data;
    const message =
      created === 0
        ? 'The learner already had those tasks'
        : `Added ${created} task${created === 1 ? '' : 's'} from “${plan.title}”`;
    const warning = assignWarnings({ pastDue, undated, overrideInPast });
    if (warning) snackbar.info(`${message}. ${warning}`);
    else snackbar.success(message);
    open = false;
    await onadded();
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Add tasks from a plan</Dialog.Title>
      <Dialog.Description>
        Give this learner tasks from a task plan of their programme. Tasks they already have are not listed.
      </Dialog.Description>
    </Dialog.Header>

    <form onsubmit={submit} class="space-y-4">
      {#if loadError}
        <div class="flex flex-col items-center gap-3 py-6" role="alert">
          <p class="text-sm text-red-600">{loadError}</p>
          <Button type="button" variant="outline" onclick={() => load()}>Try again</Button>
        </div>
      {:else if !plans}
        <div class="flex justify-center py-8"><Spinner /></div>
      {:else if plans.length === 0}
        <p class="py-6 text-center text-sm text-(--muted-foreground)">
          There are no active task plans for this programme right now. An admin can create or restore one under
          Apprenticeships › Task plans.
        </p>
      {:else}
        <div class="space-y-1">
          <span class="text-sm font-medium" id="afp-plan-label">Task plan</span>
          <Select.Root type="single" value={planId} onValueChange={pickPlan}>
            <Select.Trigger class="ui:w-full" aria-labelledby="afp-plan-label">
              <p class="truncate">{planLabel}</p>
            </Select.Trigger>
            <Select.Content>
              {#each plans as p (p.id)}
                <Select.Item value={p.id}>{p.title}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>

        {#if plan}
          {#if available.length === 0}
            <p class="rounded-md border border-dashed p-4 text-center text-sm text-(--muted-foreground)">
              This learner already has every task in this plan.
            </p>
          {:else}
            <div class="space-y-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <label class="flex items-center gap-2 text-sm font-medium">
                  <Checkbox
                    checked={allChecked}
                    onCheckedChange={(v) => toggleAll(v === true)}
                    aria-label="Select all tasks"
                  />
                  Tasks to add
                </label>
                <span class="text-xs text-(--muted-foreground)" aria-live="polite">
                  {checked.length} selected{heldCount > 0 ? ` · ${heldCount} already assigned` : ''}
                </span>
              </div>
              <ul class="max-h-64 overflow-y-auto rounded-md border">
                {#each available as item (item.id)}
                  {@const due = dueFor(item)}
                  <li class="border-b last:border-b-0">
                    <label class="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-(--muted)/40">
                      <Checkbox
                        checked={checked.includes(item.id)}
                        onCheckedChange={(v) => toggle(item.id, v === true)}
                      />
                      <span class="min-w-0 flex-1 truncate">{item.title}</span>
                      <span
                        class="shrink-0 text-xs {due && due < todayIso()
                          ? 'text-amber-700 dark:text-amber-300'
                          : 'text-(--muted-foreground)'}"
                      >
                        {due ? `Due ${fmtDate(due)}` : 'No due date'}
                      </span>
                    </label>
                  </li>
                {/each}
              </ul>
              {#if !startDate && !dueOverride}
                <p class="text-xs text-(--muted-foreground)">
                  This learner has no start date, so these tasks get no due date unless you set one below.
                </p>
              {/if}
            </div>

            <div class="space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <label for="afp-due" class="text-sm font-medium">Due date (optional)</label>
                <Input
                  id="afp-due"
                  type="date"
                  class="ui:w-44"
                  bind:value={dueDate}
                  aria-describedby="afp-due-hint"
                  aria-invalid={!!dueProblem}
                />
                {#if dueDate}
                  <Button type="button" variant="ghost" size="sm" onclick={() => (dueDate = '')}>Clear</Button>
                {/if}
              </div>
              <p id="afp-due-hint" class="text-xs text-(--muted-foreground)">
                Leave empty to use the learner’s start date plus each task’s months. A date set here is kept, even if
                the task is edited later or the start date changes.
              </p>
              {#if dueProblem}
                <p id="afp-due-error" role="alert" class="text-xs text-rose-700 dark:text-rose-300">{dueProblem}</p>
              {:else if overdueCount > 0}
                <p role="status" class="text-xs text-amber-700 dark:text-amber-300">
                  {overdueCount} of the chosen task{overdueCount === 1 ? '' : 's'} would be overdue as soon as
                  {overdueCount === 1 ? 'it is' : 'they are'} created.
                </p>
              {/if}
            </div>
          {/if}
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
        <Button type="submit" disabled={!plan || checked.length === 0 || saving || !!dueProblem} loading={saving}>
          Add {checked.length > 0 ? `${checked.length} task${checked.length === 1 ? '' : 's'}` : 'tasks'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
