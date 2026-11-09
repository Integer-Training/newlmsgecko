<script lang="ts">
  import { untrack } from 'svelte';
  import * as Dialog from '@cio/ui/base/dialog';
  import * as Select from '@cio/ui/base/select';
  import { Button } from '@cio/ui/base/button';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import { Input } from '@cio/ui/base/input';
  import { Empty } from '@cio/ui/custom/empty';
  import { APPR_EPA_RESULTS, APPR_EPA_RESULT_LABELS, type ApprEpaResult } from '@cio/utils/constants/apprenticeship';
  import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
  import CircleIcon from '@lucide/svelte/icons/circle';
  import { isOrgAdmin, isOrgTeamMember } from '$lib/utils/store/org';
  import { snackbar } from '$features/ui/snackbar/store';
  import { gatewayApi, type GatewayItem } from '../../api/gateway.svelte';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import StageChip from '../shared/stage-chip.svelte';
  import { fmtDate, fmtMinutes } from '../shared/format';

  // Gateway tab: the programme's checklist for this learner (automatic items are live and explained; manual items are
  // ticked by staff), the Ready banner, Confirm gateway (locks the checklist), then the end-point assessment (booked
  // date, result and its date). Admin can reopen the gateway (until a result exists) and clear a result. The apprentice
  // sees everything read-only. "Ready" and the stage are the API's.

  interface Props {
    store: PortfolioStore;
  }
  let { store }: Props = $props();

  const isStaff = $derived($isOrgTeamMember === true);
  const isAdmin = $derived($isOrgAdmin === true);
  const gw = $derived(store.data?.gateway ?? null);
  const locked = $derived(gw?.locked ?? false);

  // Why an automatic item is (not) done, from the portfolio the page already holds.
  const unitStats = $derived.by(() => {
    const units = (store.data?.qualifications ?? []).flatMap((q) => q.units);
    return { total: units.length, complete: units.filter((u) => u.status === 'COMPLETE').length };
  });
  function why(item: GatewayItem): string | null {
    if (item.kind === 'AUTO_UNITS') return `${unitStats.complete} of ${unitStats.total} units complete`;
    if (item.kind === 'AUTO_OTJ') {
      const o = store.data?.summary.otj;
      return o?.targetMinutes
        ? `OTJ ${fmtMinutes(o.minutes)} of ${fmtMinutes(o.targetMinutes)}`
        : 'No off-the-job target set yet';
    }
    return null;
  }

  // ── Manual items ──
  let notes = $state<Record<string, string>>({});
  let busyKey = $state<string | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    const items = gw?.items ?? [];
    untrack(() => {
      notes = Object.fromEntries(items.map((i) => [i.key, i.note ?? '']));
    });
  });

  async function setItem(item: GatewayItem, done: boolean) {
    busyKey = item.key;
    error = null;
    const res = await gatewayApi.setItem(store.enrolmentId, item.key, { done, note: notes[item.key]?.trim() || null });
    busyKey = null;
    if (!res.ok) {
      error = res.error;
      await store.refresh();
      return;
    }
    await store.refresh();
  }

  // ── Confirm / reopen ──
  let confirmOpen = $state(false);
  let reopenOpen = $state(false);
  let working = $state(false);
  let dialogError = $state<string | null>(null);

  async function confirmGateway() {
    working = true;
    dialogError = null;
    const res = await gatewayApi.confirm(store.enrolmentId);
    working = false;
    if (!res.ok) {
      dialogError = res.error;
      return;
    }
    confirmOpen = false;
    snackbar.success('Gateway confirmed');
    await store.refresh();
  }

  async function reopenGateway() {
    working = true;
    dialogError = null;
    const res = await gatewayApi.reopen(store.enrolmentId);
    working = false;
    if (!res.ok) {
      dialogError = res.error;
      return;
    }
    reopenOpen = false;
    snackbar.success('Gateway reopened');
    await store.refresh();
  }

  // ── EPA ──
  let booked = $state('');
  let result = $state<string>('');
  let resultDate = $state('');
  let epaBusy = $state(false);
  let epaError = $state<string | null>(null);

  $effect(() => {
    const g = gw;
    untrack(() => {
      booked = g?.epaBookedDate ?? '';
      result = g?.epaResult ?? '';
      resultDate = g?.epaResultDate ?? '';
    });
  });

  async function saveEpa(body: Parameters<typeof gatewayApi.updateEpa>[1], okMessage: string) {
    epaBusy = true;
    epaError = null;
    const res = await gatewayApi.updateEpa(store.enrolmentId, body);
    epaBusy = false;
    if (!res.ok) {
      epaError = res.error;
      return;
    }
    snackbar.success(okMessage);
    await store.refresh();
  }

  const saveBooked = () => saveEpa({ epaBookedDate: booked || null }, 'EPA booking saved');
  const saveResult = () =>
    saveEpa({ epaResult: result as ApprEpaResult, epaResultDate: resultDate }, 'EPA result saved');
  const clearResult = () => saveEpa({ epaResult: null }, 'EPA result cleared');

  const resultLabel = (r: string) => APPR_EPA_RESULT_LABELS[r as ApprEpaResult] ?? r;
  const canEditResult = $derived(isStaff && locked);
</script>

{#if !gw}
  <Empty title="Gateway not available" description="The gateway checklist could not be loaded for this learner." />
{:else}
  <div class="space-y-5">
    <div class="flex flex-wrap items-center gap-2">
      <h3 class="font-semibold">Gateway</h3>
      <StageChip stage={gw.stage} label={gw.stageLabel} />
    </div>

    {#if locked}
      <p
        class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300"
      >
        Gateway confirmed on {fmtDate(gw.gatewayPassedAt)}. The checklist is locked.
      </p>
    {:else if gw.ready}
      <div
        class="flex flex-wrap items-center justify-between gap-2 rounded-md bg-violet-50 px-3 py-2 text-sm text-violet-800 dark:bg-violet-500/10 dark:text-violet-300"
      >
        <span>Ready for gateway — every checklist item is complete.</span>
        {#if isStaff}
          <Button
            size="sm"
            onclick={() => {
              dialogError = null;
              confirmOpen = true;
            }}>Confirm gateway</Button
          >
        {/if}
      </div>
    {:else}
      <p class="text-sm text-(--muted-foreground)">
        {gw.items.filter((i) => i.done).length} of {gw.items.length} items complete. The learner is ready for gateway when
        every item is done.
      </p>
    {/if}

    {#if error}
      <p
        role="alert"
        class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
      >
        {error}
      </p>
    {/if}

    <ul class="divide-y rounded-lg border" aria-label="Gateway checklist">
      {#each gw.items as item (item.key)}
        <li class="flex flex-wrap items-start gap-3 px-4 py-3">
          {#if item.kind === 'MANUAL' && isStaff}
            <Checkbox
              class="mt-0.5"
              checked={item.done}
              disabled={locked || busyKey !== null}
              aria-label="{item.label} — {item.done ? 'done' : 'not done'}"
              onCheckedChange={(v) => setItem(item, v === true)}
            />
          {:else if item.done}
            <CircleCheckIcon size={18} class="mt-0.5 text-emerald-600" aria-label="Done" />
          {:else}
            <CircleIcon size={18} class="mt-0.5 text-(--muted-foreground)" aria-label="Not done" />
          {/if}
          <div class="min-w-0 flex-1 space-y-1">
            <p class="text-sm font-medium">
              {item.label}
              {#if item.kind !== 'MANUAL'}
                <span class="ml-1 text-xs font-normal text-(--muted-foreground)">automatic</span>
              {/if}
            </p>
            {#if why(item)}
              <p class="text-xs text-(--muted-foreground)">{why(item)}</p>
            {/if}
            {#if item.kind === 'MANUAL'}
              {#if isStaff}
                <div class="flex flex-wrap items-center gap-2">
                  <Input
                    class="max-w-sm"
                    placeholder="Note (optional)"
                    aria-label="Note for {item.label}"
                    maxlength={500}
                    bind:value={notes[item.key]}
                    disabled={locked}
                  />
                  {#if !locked && item.done && (notes[item.key] ?? '').trim() !== (item.note ?? '')}
                    <Button
                      size="sm"
                      variant="outline"
                      loading={busyKey === item.key}
                      disabled={busyKey !== null}
                      onclick={() => setItem(item, true)}>Save note</Button
                    >
                  {/if}
                </div>
              {:else if item.note}
                <p class="text-sm">{item.note}</p>
              {/if}
              {#if item.done && item.at}
                <p class="text-xs text-(--muted-foreground)">Ticked {fmtDate(item.at)}</p>
              {/if}
            {/if}
          </div>
        </li>
      {/each}
    </ul>

    {#if locked && isAdmin && !gw.epaResult}
      <div>
        <Button
          variant="outline"
          size="sm"
          onclick={() => {
            dialogError = null;
            reopenOpen = true;
          }}>Reopen gateway</Button
        >
      </div>
    {/if}

    <!-- End-point assessment -->
    <section class="space-y-3 border-t pt-4" aria-label="End-point assessment">
      <h3 class="font-semibold">End-point assessment</h3>
      {#if !locked}
        <p class="text-sm text-(--muted-foreground)">
          The end-point assessment is booked and recorded once the gateway has been confirmed.
        </p>
      {:else}
        {#if epaError}
          <p
            role="alert"
            class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
          >
            {epaError}
          </p>
        {/if}
        <div class="grid gap-4 md:grid-cols-2">
          <div class="space-y-2 rounded-lg border p-3">
            <p class="text-sm font-medium">Booked date</p>
            {#if canEditResult}
              <div class="flex flex-wrap items-end gap-2">
                <Input type="date" class="w-44" aria-label="EPA booked date" bind:value={booked} disabled={epaBusy} />
                <Button
                  size="sm"
                  variant="outline"
                  onclick={saveBooked}
                  loading={epaBusy}
                  disabled={epaBusy || booked === (gw.epaBookedDate ?? '')}>Save</Button
                >
              </div>
            {:else}
              <p class="text-sm">{gw.epaBookedDate ? fmtDate(gw.epaBookedDate) : 'Not booked yet'}</p>
            {/if}
          </div>

          <div class="space-y-2 rounded-lg border p-3">
            <p class="text-sm font-medium" id="epa-result-label">Result</p>
            {#if canEditResult}
              <div class="flex flex-wrap items-end gap-2">
                <Select.Root type="single" bind:value={result}>
                  <Select.Trigger class="w-40" aria-labelledby="epa-result-label">
                    {result ? resultLabel(result) : 'No result'}
                  </Select.Trigger>
                  <Select.Content>
                    {#if !gw.epaResult}<Select.Item value="">No result</Select.Item>{/if}
                    {#each APPR_EPA_RESULTS as r (r)}
                      <Select.Item value={r}>{APPR_EPA_RESULT_LABELS[r]}</Select.Item>
                    {/each}
                  </Select.Content>
                </Select.Root>
                <Input
                  type="date"
                  class="w-44"
                  aria-label="EPA result date"
                  bind:value={resultDate}
                  disabled={epaBusy || !result}
                />
                <Button
                  size="sm"
                  onclick={saveResult}
                  loading={epaBusy}
                  disabled={epaBusy ||
                    !result ||
                    !resultDate ||
                    (result === (gw.epaResult ?? '') && resultDate === (gw.epaResultDate ?? ''))}>Save result</Button
                >
                {#if gw.epaResult && isAdmin}
                  <Button size="sm" variant="outline" onclick={clearResult} disabled={epaBusy}>Clear result</Button>
                {/if}
              </div>
              {#if result && !resultDate}
                <p class="text-xs text-(--muted-foreground)">A result needs the date it was received.</p>
              {/if}
            {:else}
              <p class="text-sm">
                {#if gw.epaResult}
                  {resultLabel(gw.epaResult)}{gw.epaResultDate ? ` · ${fmtDate(gw.epaResultDate)}` : ''}
                {:else}
                  No result yet
                {/if}
              </p>
            {/if}
          </div>
        </div>
      {/if}
    </section>
  </div>
{/if}

{#if isStaff}
  <Dialog.Root bind:open={confirmOpen}>
    <Dialog.Content class="sm:max-w-md">
      <Dialog.Header>
        <Dialog.Title>Confirm gateway?</Dialog.Title>
        <Dialog.Description>
          {store.data?.learner.name} will move to end-point assessment. The checklist is locked, and the apprentice will
          no longer be able to add or change evidence.
        </Dialog.Description>
      </Dialog.Header>
      {#if dialogError}
        <p
          role="alert"
          class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
        >
          {dialogError}
        </p>
      {/if}
      <Dialog.Footer class="mt-4">
        <Button variant="outline" onclick={() => (confirmOpen = false)} disabled={working}>Cancel</Button>
        <Button onclick={confirmGateway} loading={working} disabled={working}>Confirm gateway</Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>

  <Dialog.Root bind:open={reopenOpen}>
    <Dialog.Content class="sm:max-w-md">
      <Dialog.Header>
        <Dialog.Title>Reopen gateway?</Dialog.Title>
        <Dialog.Description>
          The checklist is unlocked again and the apprentice can add evidence. Ticks are kept. This is not possible once
          an EPA result has been recorded.
        </Dialog.Description>
      </Dialog.Header>
      {#if dialogError}
        <p
          role="alert"
          class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
        >
          {dialogError}
        </p>
      {/if}
      <Dialog.Footer class="mt-4">
        <Button variant="outline" onclick={() => (reopenOpen = false)} disabled={working}>Cancel</Button>
        <Button variant="destructive" onclick={reopenGateway} loading={working} disabled={working}>Reopen</Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}
