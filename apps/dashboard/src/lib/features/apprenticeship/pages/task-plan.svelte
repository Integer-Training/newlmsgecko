<script lang="ts">
  import { page } from '$app/state';
  import * as Page from '@cio/ui/base/page';
  import { Button } from '@cio/ui/base/button';
  import { Spinner } from '@cio/ui/base/spinner';
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
  import { currentOrg } from '$lib/utils/store/org';
  import { evidenceApi, type PickerQualification } from '../api/evidence.svelte';
  import { taskPlansApi, type TaskPlan, type TaskPlanDetail } from '../api/task-plans.svelte';
  import PlanHeader from '../components/task-plans/plan-header.svelte';
  import PlanTasks from '../components/task-plans/plan-tasks.svelte';
  import PlanLearners from '../components/task-plans/plan-learners.svelte';

  // One task plan: details, its tasks, and the learners it is assigned to. Everything reloads from the server after
  // each change so counts and order stay server-true.
  const planId = $derived(page.params.planId ?? '');

  let detail = $state<TaskPlanDetail | null>(null);
  let tree = $state<PickerQualification[]>([]);
  let programmeTitle = $state('');
  let loadError = $state<string | null>(null);
  // Monotonic id so a slow earlier response cannot overwrite a newer one.
  let req = 0;

  async function load(id: string) {
    const mine = ++req;
    loadError = null;
    const res = await taskPlansApi.detail(id);
    if (mine !== req) return;
    if (!res.ok) {
      loadError = res.error;
      return;
    }
    // Programme structure for the criteria picker, once per plan.
    if (!detail || detail.plan.programmeId !== res.data.plan.programmeId) {
      const prog = await evidenceApi.programmeTree(res.data.plan.programmeId);
      if (mine !== req) return;
      if (prog.ok) {
        tree = prog.data.qualifications;
        programmeTitle = (prog.data as { title?: string }).title ?? '';
      }
    }
    detail = res.data;
  }

  $effect(() => {
    const id = planId;
    if (!id) return;
    detail = null;
    load(id);
  });

  const current = $derived(detail && detail.plan.id === planId ? detail : null);

  function onsaved(plan: TaskPlan) {
    if (detail) detail = { ...detail, plan: { ...detail.plan, ...plan } };
  }
</script>

<svelte:head><title>{current?.plan.title ?? 'Task plan'} — Gecko Apprenticeships</title></svelte:head>

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      <Page.Title>{current?.plan.title ?? 'Task plan'}</Page.Title>
      <Page.Subtitle>{programmeTitle ? `${programmeTitle} · ` : ''}{$currentOrg.name}</Page.Subtitle>
    </Page.HeaderContent>
    <Page.Action>
      <Button variant="outline" href="/org/{$currentOrg.siteName}/apprenticeships/task-plans">
        <ArrowLeftIcon class="size-4" /> All task plans
      </Button>
    </Page.Action>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      {#if loadError && !current}
        <div class="flex flex-col items-center gap-3 py-16" role="alert">
          <p class="text-sm text-red-600">{loadError}</p>
          <Button variant="outline" onclick={() => load(planId)}>Try again</Button>
        </div>
      {:else if !current}
        <div class="flex justify-center py-16"><Spinner /></div>
      {:else}
        <div class="flex flex-col gap-4">
          <PlanHeader plan={current.plan} {programmeTitle} {onsaved} />
          <PlanTasks planId={current.plan.id} items={current.items} {tree} onchanged={() => load(planId)} />
          <PlanLearners
            plan={current.plan}
            taskCount={current.items.length}
            assignees={current.assignees}
            onchanged={() => load(planId)}
          />
        </div>
      {/if}
    {/snippet}
  </Page.Body>
</Page.Root>
