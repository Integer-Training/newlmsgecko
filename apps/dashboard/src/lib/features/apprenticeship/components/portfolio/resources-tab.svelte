<script lang="ts">
  import { onMount } from 'svelte';
  import * as Table from '@cio/ui/base/table';
  import { Button } from '@cio/ui/base/button';
  import { Skeleton } from '@cio/ui/base/skeleton';
  import { Empty } from '@cio/ui/custom/empty';
  import {
    resourcesAdminApi,
    type EnrolmentResources,
    type LearnerResourceItem,
    type ResourceLearnerStatus
  } from '../../api/resources-admin.svelte';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import KindChip from '../resources/staff/kind-chip.svelte';
  import ProgrammeTypeChip from '../shared/programme-type-chip.svelte';
  import { fmtDate } from '../shared/format';

  // Resources tab (staff view of a learner): every resource of the learner's programme(s) — the pair shows both —
  // grouped programme → General / unit, with the learner's status, last download, version and a link to the evidence
  // they submitted from a workbook. A withdrawn half is flagged (the learner themselves cannot see it).
  interface Props {
    store: PortfolioStore;
  }
  let { store }: Props = $props();

  let data = $state<EnrolmentResources | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let seq = 0;

  async function load() {
    const mine = ++seq;
    loading = true;
    error = null;
    const res = await resourcesAdminApi.forEnrolment(store.enrolmentId);
    if (mine !== seq) return;
    loading = false;
    if (res.ok) data = res.data;
    else error = res.error;
  }

  onMount(load);

  const STATUS: Record<ResourceLearnerStatus, { label: string; cls: string }> = {
    NOT_STARTED: { label: 'Not started', cls: 'bg-(--muted) text-(--muted-foreground)' },
    VIEWED: { label: 'Viewed', cls: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300' },
    DOWNLOADED: {
      label: 'Downloaded',
      cls: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-300'
    },
    SUBMITTED: { label: 'Submitted', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300' },
    REFERRED: { label: 'Referred', cls: 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300' },
    ACCEPTED: { label: 'Accepted', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300' }
  };

  interface UnitGroup {
    key: string;
    label: string;
    items: LearnerResourceItem[];
  }
  interface ProgrammeGroup {
    enrolmentId: string;
    title: string;
    type: string;
    withdrawn: boolean;
    units: UnitGroup[];
    count: number;
  }

  // Group programme → General first, then units in the order their resources arrive (already sorted by the API).
  const groups = $derived.by<ProgrammeGroup[]>(() => {
    if (!data) return [];
    return data.programmes
      .map((p) => {
        const mine = data!.resources.filter((r) => r.enrolmentId === p.enrolmentId);
        const byUnit = new Map<string, UnitGroup>();
        for (const r of mine) {
          const key = r.unitId ?? 'general';
          if (!byUnit.has(key)) {
            byUnit.set(key, {
              key,
              label: r.unitId ? `${r.unitCode ? r.unitCode + ' · ' : ''}${r.unitTitle ?? 'Unit'}` : 'General',
              items: []
            });
          }
          byUnit.get(key)!.items.push(r);
        }
        const units = [...byUnit.values()].sort((a, b) => (a.key === 'general' ? -1 : b.key === 'general' ? 1 : 0));
        return { ...p, units, count: mine.length };
      })
      .filter((g) => g.count > 0 || g.withdrawn);
  });
</script>

{#if loading}
  <div class="space-y-2" role="status" aria-label="Loading resources">
    <Skeleton class="h-8 w-64" />
    <Skeleton class="h-40 w-full" />
  </div>
{:else if error}
  <div class="rounded-lg border border-rose-200 p-6 text-center">
    <p role="alert" class="text-sm text-rose-600">{error}</p>
    <Button variant="outline" size="sm" class="mt-3" onclick={load}>Try again</Button>
  </div>
{:else if groups.length === 0}
  <Empty
    title="No resources yet"
    description="Learning resources and workbooks added to this programme will appear here with the learner's progress."
  />
{:else}
  <div class="space-y-6">
    {#each groups as g (g.enrolmentId)}
      <section class="space-y-3" aria-label="Resources for {g.title}">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="text-sm font-semibold">{g.title}</h3>
          <ProgrammeTypeChip type={g.type} />
          {#if g.withdrawn}
            <span
              class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
            >
              Withdrawn — the learner cannot see these
            </span>
          {/if}
        </div>

        {#each g.units as u (u.key)}
          <div class="rounded-md border">
            <p class="border-b bg-(--muted)/40 px-3 py-1.5 text-xs font-medium">{u.label}</p>
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Resource</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head class="hidden md:table-cell">Last downloaded</Table.Head>
                  <Table.Head class="hidden sm:table-cell">Version</Table.Head>
                  <Table.Head class="text-right">Evidence</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each u.items as r (r.id)}
                  <Table.Row>
                    <Table.Cell class="whitespace-normal!">
                      <span class="block font-medium break-words">{r.title}</span>
                      <span class="mt-1 flex flex-wrap items-center gap-1.5">
                        <KindChip kind={r.kind} />
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <span
                        class="inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap {STATUS[
                          r.status
                        ]?.cls ?? ''}"
                      >
                        {STATUS[r.status]?.label ?? r.status}
                      </span>
                    </Table.Cell>
                    <Table.Cell class="hidden text-sm md:table-cell">
                      {r.kind === 'WORKBOOK' ? fmtDate(r.activity?.lastDownloadedAt) : '—'}
                    </Table.Cell>
                    <Table.Cell class="hidden text-sm sm:table-cell">
                      v{r.version}
                      {#if r.updatedSinceDownload}
                        <span
                          class="ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
                          title="Downloaded v{r.activity?.lastVersion ?? '?'}; the file has been replaced since"
                        >
                          old version
                        </span>
                      {/if}
                    </Table.Cell>
                    <Table.Cell class="text-right">
                      {#if r.latestEvidenceId}
                        <Button size="sm" variant="outline" onclick={() => store.openEvidence(r.latestEvidenceId!)}>
                          View<span class="sr-only"> evidence for {r.title}</span>
                        </Button>
                      {:else}
                        <span class="text-(--muted-foreground)">—</span>
                      {/if}
                    </Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
          </div>
        {:else}
          <p class="text-sm text-(--muted-foreground)">No resources in this programme.</p>
        {/each}
      </section>
    {/each}
  </div>
{/if}
