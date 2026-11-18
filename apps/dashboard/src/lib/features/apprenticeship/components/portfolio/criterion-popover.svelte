<script lang="ts">
  import type { Snippet } from 'svelte';
  import * as Dialog from '@cio/ui/base/dialog';
  import * as Tabs from '@cio/ui/base/tabs';
  import { Input } from '@cio/ui/base/input';
  import { Button } from '@cio/ui/base/button';
  import { Spinner } from '@cio/ui/base/spinner';
  import { evidenceApi, type CriterionEvidenceItem } from '../../api/evidence.svelte';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import ProgrammeTypeChip from '../shared/programme-type-chip.svelte';
  import EvidenceStatusChip from '../shared/evidence-status-chip.svelte';
  import TaskStatusChip from '../shared/task-status-chip.svelte';
  import { fmtDate } from '../shared/format';

  // "List evidence" for one criterion, as a dialog: the criterion code and text, two tiles (Evidence, Tasks) and two
  // tabs — Evidence (every piece mapped to it, each opening the evidence sheet) and Tasks (this learner's tasks that
  // target it). Used by the criteria rows, the unit page and the criteria-map cells. Re-fetches when it opens and
  // after any change.

  interface Props {
    store: PortfolioStore;
    criterionId: string;
    label: string;
    /** Criterion code and text shown in the dialog header (falls back to `label`). */
    code?: string;
    text?: string;
    /** The enrolment that owns this criterion's programme (default: the store's). */
    enrolmentId?: string;
    triggerClass?: string;
    children: Snippet;
  }
  let { store, criterionId, label, code, text, enrolmentId, triggerClass = '', children }: Props = $props();

  const PAGE_SIZE = 5;

  let open = $state(false);
  let items = $state<CriterionEvidenceItem[]>([]);
  let apiTaskCount = $state<number | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let tab = $state('evidence');
  let search = $state('');
  let pageNo = $state(1);

  $effect(() => {
    // Track open + the store version so the list stays in sync with the rest of the page.
    store.version;
    if (!open) return;
    let cancelled = false;
    loading = items.length === 0;
    evidenceApi.forCriterion(criterionId, enrolmentId ?? store.enrolmentId).then((res) => {
      if (cancelled) return;
      loading = false;
      if (res.ok) {
        items = res.data.items;
        apiTaskCount = res.data.taskCount;
        error = null;
      } else {
        error = res.error;
      }
    });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (open) {
      tab = 'evidence';
      search = '';
      pageNo = 1;
    }
  });

  const tasks = $derived(store.tasks.filter((t) => t.criteria.some((c) => c.id === criterionId)));
  // The API's count covers this learner's tasks on the criterion; the store list is the fallback (older API).
  const taskTotal = $derived(apiTaskCount ?? tasks.length);
  const viewing = $derived(enrolmentId ?? store.enrolmentId);
  // "From Diploma/Standard": evidence that lives on the other qualification of the pair.
  function fromType(item: CriterionEvidenceItem) {
    if (!item.homeEnrolmentId || item.homeEnrolmentId === viewing) return null;
    if (item.homeType) return item.homeType;
    const home = store.portfolioFor(item.homeEnrolmentId)?.programme.type;
    if (home) return home;
    const here = store.portfolioFor(viewing)?.programme.type;
    return here ? (here === 'DIPLOMA' ? 'STANDARD' : 'DIPLOMA') : null;
  }
  const filtered = $derived(
    items.filter((i) => {
      const q = search.trim().toLowerCase();
      return !q || i.title.toLowerCase().includes(q) || i.snippet.toLowerCase().includes(q);
    })
  );
  const pages = $derived(Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
  const visible = $derived(filtered.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE));

  function pick(id: string) {
    open = false;
    store.openEvidence(id);
  }
</script>

<button type="button" class={triggerClass} aria-label={label} aria-haspopup="dialog" onclick={() => (open = true)}>
  {@render children()}
</button>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>{code ?? label}</Dialog.Title>
      <Dialog.Description>{text ?? ''}</Dialog.Description>
    </Dialog.Header>

    <dl class="grid grid-cols-2 gap-3">
      <div class="rounded-lg border p-3">
        <dt class="text-xs text-(--muted-foreground)">Evidence</dt>
        <dd class="text-xl font-semibold">{items.length}</dd>
      </div>
      <div class="rounded-lg border p-3">
        <dt class="text-xs text-(--muted-foreground)">Tasks</dt>
        <dd class="text-xl font-semibold">{taskTotal}</dd>
      </div>
    </dl>

    <Tabs.Root bind:value={tab}>
      <Tabs.List>
        <Tabs.Trigger value="evidence">Evidence</Tabs.Trigger>
        <Tabs.Trigger value="tasks">Tasks ({taskTotal})</Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="evidence" class="mt-3 space-y-2">
        {#if loading}
          <div class="flex justify-center py-6" role="status" aria-label="Loading evidence"><Spinner /></div>
        {:else if error}
          <p role="alert" class="text-sm text-rose-600">{error}</p>
        {:else if items.length === 0}
          <p class="py-4 text-sm text-(--muted-foreground)">No evidence mapped to this criterion yet.</p>
        {:else}
          <Input
            type="search"
            placeholder="Search evidence"
            aria-label="Search evidence"
            bind:value={search}
            oninput={() => (pageNo = 1)}
          />
          <div class="overflow-x-auto rounded-lg border">
            <table class="w-full text-sm">
              <thead class="bg-(--muted)/50 text-left text-xs text-(--muted-foreground)">
                <tr>
                  <th class="px-3 py-2 font-medium">Title</th>
                  <th class="px-3 py-2 font-medium">Details</th>
                  <th class="px-3 py-2 font-medium">Status</th>
                  <th class="px-3 py-2 font-medium">Files</th>
                  <th class="px-3 py-2"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody class="divide-y">
                {#each visible as item (item.id)}
                  <tr>
                    <td class="px-3 py-2 font-medium">
                      {item.title}
                      {#if fromType(item)}
                        {@const ft = fromType(item)}
                        <span class="ml-1 inline-flex items-center gap-1 text-xs font-normal text-(--muted-foreground)"
                          >From <ProgrammeTypeChip type={ft!} /></span
                        >
                      {/if}
                      <span class="block text-xs font-normal text-(--muted-foreground)">{fmtDate(item.createdAt)}</span>
                    </td>
                    <td class="max-w-56 px-3 py-2 text-(--muted-foreground)">
                      <span class="line-clamp-2">{item.snippet || 'No details'}</span>
                    </td>
                    <td class="px-3 py-2"><EvidenceStatusChip status={item.status} /></td>
                    <td class="px-3 py-2">{item.fileCount}</td>
                    <td class="px-3 py-2 text-right">
                      <Button variant="outline" size="sm" onclick={() => pick(item.id)}>View</Button>
                    </td>
                  </tr>
                {:else}
                  <tr><td colspan="5" class="px-3 py-4 text-center text-(--muted-foreground)">No matches.</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if pages > 1}
            <div class="flex items-center justify-between text-sm">
              <span class="text-(--muted-foreground)">Page {pageNo} of {pages}</span>
              <span class="flex gap-2">
                <Button variant="outline" size="sm" disabled={pageNo <= 1} onclick={() => (pageNo -= 1)}
                  >Previous</Button
                >
                <Button variant="outline" size="sm" disabled={pageNo >= pages} onclick={() => (pageNo += 1)}
                  >Next</Button
                >
              </span>
            </div>
          {/if}
        {/if}
      </Tabs.Content>

      <Tabs.Content value="tasks" class="mt-3">
        {#if tasks.length === 0}
          <p class="py-4 text-sm text-(--muted-foreground)">No tasks target this criterion.</p>
        {:else}
          <ul class="divide-y rounded-lg border">
            {#each tasks as t (t.id)}
              <li class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span class="min-w-0">
                  <span class="font-medium">{t.title}</span>
                  <span class="block text-xs text-(--muted-foreground)">Due {fmtDate(t.dueDate)}</span>
                </span>
                <TaskStatusChip status={t.status} overdue={t.overdue} />
              </li>
            {/each}
          </ul>
        {/if}
      </Tabs.Content>
    </Tabs.Root>
  </Dialog.Content>
</Dialog.Root>
