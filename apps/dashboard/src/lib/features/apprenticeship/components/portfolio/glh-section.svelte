<script lang="ts">
  import * as Table from '@cio/ui/base/table';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Empty } from '@cio/ui/custom/empty';
  import { APPR_GLH_LOG_MAX_MINUTES } from '@cio/utils/constants/apprenticeship';
  import TrashIcon from '@lucide/svelte/icons/trash-2';
  import { isOrgTeamMember } from '$lib/utils/store/org';
  import { snackbar } from '$features/ui/snackbar/store';
  import { gatewayApi } from '../../api/gateway.svelte';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import ProgressBar from '../shared/progress-bar.svelte';
  import { fmtDate, fmtMinutes } from '../shared/format';

  // Guided learning hours: target (sum of unit GLH), done (completed units + staff logs) and expected to date, then
  // the staff-logged entries. Staff add / delete entries; the apprentice reads only. Nothing is worked out here.

  interface Props {
    store: PortfolioStore;
  }
  let { store }: Props = $props();

  const isStaff = $derived($isOrgTeamMember === true);
  const glh = $derived(store.data?.summary.glh);
  const target = $derived(glh?.targetMinutes ?? null);

  let hours = $state('0');
  let mins = $state('0');
  let logDate = $state(new Date().toLocaleDateString('en-CA'));
  let note = $state('');
  let saving = $state(false);
  let removing = $state<string | null>(null);
  let error = $state<string | null>(null);

  const minutes = $derived(
    Math.max(0, Math.floor(Number(hours) || 0)) * 60 + Math.max(0, Math.floor(Number(mins) || 0))
  );
  const canAdd = $derived(minutes >= 1 && minutes <= APPR_GLH_LOG_MAX_MINUTES && !!logDate && !saving);

  async function add() {
    if (!canAdd) return;
    saving = true;
    error = null;
    const res = await gatewayApi.addGlh(store.enrolmentId, { minutes, logDate, note: note.trim() || null });
    saving = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    snackbar.success('GLH logged');
    hours = '0';
    mins = '0';
    note = '';
    await store.refresh();
  }

  async function remove(id: string) {
    removing = id;
    error = null;
    const res = await gatewayApi.removeGlh(store.enrolmentId, id);
    removing = null;
    if (!res.ok) {
      error = res.error;
      return;
    }
    snackbar.success('GLH entry removed');
    await store.refresh();
  }
</script>

<section class="space-y-4" aria-label="Guided learning hours">
  <h3 class="font-semibold">Guided learning hours (GLH)</h3>

  {#if !glh || target === null}
    <p class="rounded-lg border p-3 text-sm text-(--muted-foreground)">
      No GLH set for this programme.
      {#if glh && glh.doneMinutes > 0}{fmtMinutes(glh.doneMinutes)} logged so far.{/if}
    </p>
  {:else}
    <dl class="grid grid-cols-2 gap-3 md:grid-cols-3">
      <div class="rounded-lg border p-3">
        <dt class="text-xs text-(--muted-foreground)">Target</dt>
        <dd class="text-lg font-semibold">{fmtMinutes(target)}</dd>
      </div>
      <div class="rounded-lg border p-3">
        <dt class="text-xs text-(--muted-foreground)">Done</dt>
        <dd class="text-lg font-semibold">{fmtMinutes(glh.doneMinutes)}</dd>
        <p class="text-xs text-(--muted-foreground)">Completed units plus logged hours</p>
      </div>
      <div class="rounded-lg border p-3">
        <dt class="text-xs text-(--muted-foreground)">Expected to date</dt>
        <dd class="text-lg font-semibold">{fmtMinutes(glh.expectedMinutes)}</dd>
      </div>
    </dl>
    <ProgressBar
      actual={target ? Math.floor((glh.doneMinutes / target) * 100) : null}
      expected={target && glh.expectedMinutes !== null ? Math.round((glh.expectedMinutes / target) * 100) : null}
      label="Guided learning hours"
    />
  {/if}

  {#if isStaff}
    <form
      class="flex flex-wrap items-end gap-2 rounded-lg border p-3"
      onsubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <div class="space-y-1">
        <label for="glh-hours" class="text-xs text-(--muted-foreground)">Hours</label>
        <Input id="glh-hours" class="w-20" type="number" min="0" max="24" bind:value={hours} />
      </div>
      <div class="space-y-1">
        <label for="glh-mins" class="text-xs text-(--muted-foreground)">Minutes</label>
        <Input id="glh-mins" class="w-20" type="number" min="0" max="59" bind:value={mins} />
      </div>
      <div class="space-y-1">
        <label for="glh-date" class="text-xs text-(--muted-foreground)">Date</label>
        <Input id="glh-date" class="w-40" type="date" bind:value={logDate} />
      </div>
      <div class="min-w-48 flex-1 space-y-1">
        <label for="glh-note" class="text-xs text-(--muted-foreground)">Note (optional)</label>
        <Input id="glh-note" bind:value={note} maxlength={500} />
      </div>
      <Button type="submit" size="sm" loading={saving} disabled={!canAdd}>Log GLH</Button>
    </form>
  {/if}
  {#if error}
    <p
      role="alert"
      class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
    >
      {error}
    </p>
  {/if}

  {#if store.glhError}
    <p role="alert" class="text-sm text-rose-600">{store.glhError}</p>
  {:else if store.glhLogs.length === 0}
    <Empty title="No logged GLH" description="Hours logged by staff appear here." />
  {:else}
    <div class="overflow-x-auto rounded-lg border">
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Date</Table.Head>
            <Table.Head class="text-right">Time</Table.Head>
            <Table.Head>Note</Table.Head>
            <Table.Head>Logged by</Table.Head>
            {#if isStaff}<Table.Head><span class="sr-only">Actions</span></Table.Head>{/if}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each store.glhLogs as l (l.id)}
            <Table.Row>
              <Table.Cell class="whitespace-nowrap">{fmtDate(l.logDate)}</Table.Cell>
              <Table.Cell class="text-right">{fmtMinutes(l.minutes)}</Table.Cell>
              <Table.Cell>{l.note || '—'}</Table.Cell>
              <Table.Cell>{l.createdByName ?? '—'}</Table.Cell>
              {#if isStaff}
                <Table.Cell class="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Delete GLH entry of {fmtMinutes(l.minutes)} on {fmtDate(l.logDate)}"
                    loading={removing === l.id}
                    disabled={removing !== null}
                    onclick={() => remove(l.id)}
                  >
                    <TrashIcon size={14} />
                  </Button>
                </Table.Cell>
              {/if}
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  {/if}
</section>
