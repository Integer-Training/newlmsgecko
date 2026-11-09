<script lang="ts">
  import { onMount } from 'svelte';
  import * as Table from '@cio/ui/base/table';
  import { Button } from '@cio/ui/base/button';
  import { Empty } from '@cio/ui/custom/empty';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import { isOrgTeamMember } from '$lib/utils/store/org';
  import { evidenceApi } from '../../api/evidence.svelte';
  import type { TaskItem } from '../../api/tasks.svelte';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import TaskDialog from '../tasks/task-dialog.svelte';
  import TaskPanel from '../tasks/task-panel.svelte';
  import TaskStatusChip from '../shared/task-status-chip.svelte';
  import { fmtDate } from '../shared/format';

  // Tasks tab (admin, tutor and the apprentice): the learner's tasks grouped Overdue / Due soon / Planned /
  // Submitted / Referred / Complete. Status and "overdue" are the API's; only the "due soon" grouping looks at today's
  // date. A row opens the task panel; staff can add an individual task here.

  interface Props {
    store: PortfolioStore;
  }
  let { store }: Props = $props();

  const isStaff = $derived($isOrgTeamMember === true);
  const DUE_SOON_DAYS = 14;

  let selectedId = $state<string | null>(null);
  let panelOpen = $state(false);
  let dialogOpen = $state(false);
  let editing = $state<TaskItem | null>(null);

  onMount(() => {
    evidenceApi.loadTypes();
  });

  const selected = $derived(store.tasks.find((t) => t.id === selectedId) ?? null);

  const today = new Date();
  const soonLimit = new Date(today.getFullYear(), today.getMonth(), today.getDate() + DUE_SOON_DAYS).toLocaleDateString(
    'en-CA'
  );

  const groups = $derived.by(() => {
    const open = (t: TaskItem) => t.status !== 'COMPLETE';
    const overdue = store.tasks.filter((t) => t.overdue && open(t));
    const rest = store.tasks.filter((t) => !(t.overdue && open(t)));
    const soon = rest.filter((t) => t.status === 'PLANNED' && t.dueDate && t.dueDate <= soonLimit);
    const soonIds = new Set(soon.map((t) => t.id));
    return [
      { key: 'overdue', label: 'Overdue', items: overdue },
      { key: 'soon', label: 'Due soon', items: soon },
      { key: 'planned', label: 'Planned', items: rest.filter((t) => t.status === 'PLANNED' && !soonIds.has(t.id)) },
      { key: 'submitted', label: 'Submitted', items: rest.filter((t) => t.status === 'SUBMITTED') },
      { key: 'referred', label: 'Referred', items: rest.filter((t) => t.status === 'REFERRED') },
      { key: 'complete', label: 'Complete', items: rest.filter((t) => t.status === 'COMPLETE') }
    ].filter((g) => g.items.length > 0);
  });

  function openTask(t: TaskItem) {
    selectedId = t.id;
    panelOpen = true;
  }

  function newTask() {
    editing = null;
    dialogOpen = true;
  }

  function editTask(t: TaskItem) {
    editing = t;
    dialogOpen = true;
  }
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <p class="text-sm text-(--muted-foreground)" aria-live="polite">
      {store.tasks.length} task{store.tasks.length === 1 ? '' : 's'}
      {#if store.overdueTaskCount > 0}
        · <strong class="text-rose-600">{store.overdueTaskCount} overdue</strong>
      {/if}
    </p>
    {#if isStaff}
      <Button size="sm" onclick={newTask}><PlusIcon size={14} class="mr-1" /> New individual task</Button>
    {/if}
  </div>

  {#if store.tasksError}
    <div class="rounded-lg border border-rose-200 p-4 text-center">
      <p role="alert" class="text-sm text-rose-600">{store.tasksError}</p>
      <Button variant="outline" size="sm" class="mt-3" onclick={() => store.refresh()}>Try again</Button>
    </div>
  {:else if store.tasks.length === 0}
    <Empty
      title="No tasks yet"
      description={isStaff
        ? 'Assign a task plan from Apprenticeships › Task plans, or add an individual task for this learner.'
        : 'Tasks set by your tutor will appear here.'}
    />
  {:else}
    {#each groups as g (g.key)}
      <section aria-labelledby="tasks-{g.key}">
        <h3 id="tasks-{g.key}" class="mb-2 text-sm font-semibold {g.key === 'overdue' ? 'text-rose-600' : ''}">
          {g.label} <span class="font-normal text-(--muted-foreground)">({g.items.length})</span>
        </h3>
        <div class="overflow-x-auto rounded-lg border">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Task</Table.Head>
                <Table.Head>Due</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head class="text-right">Evidence</Table.Head>
                <Table.Head>Plan</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each g.items as t (t.id)}
                <Table.Row class="cursor-pointer" onclick={() => openTask(t)}>
                  <Table.Cell class="max-w-72 truncate font-medium">
                    <button
                      type="button"
                      class="text-left hover:underline"
                      onclick={(e) => {
                        e.stopPropagation();
                        openTask(t);
                      }}
                    >
                      {t.title}
                    </button>
                  </Table.Cell>
                  <Table.Cell class="whitespace-nowrap">
                    {#if t.dueDate}
                      {fmtDate(t.dueDate)}
                    {:else}
                      <span class="text-xs text-(--muted-foreground)"
                        >{isStaff ? 'No due date — learner start date not set' : 'No due date yet'}</span
                      >
                    {/if}
                  </Table.Cell>
                  <Table.Cell
                    ><TaskStatusChip status={t.status} overdue={t.overdue && t.status !== 'COMPLETE'} /></Table.Cell
                  >
                  <Table.Cell class="text-right">{t.evidence.length}</Table.Cell>
                  <Table.Cell class="text-sm">{t.fromPlan ? (t.planTitle ?? 'Plan task') : 'Individual'}</Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </div>
      </section>
    {/each}
  {/if}
</div>

<TaskPanel bind:open={panelOpen} task={selected} {store} onEdit={editTask} />
{#if isStaff}
  <TaskDialog bind:open={dialogOpen} {store} task={editing} />
{/if}
