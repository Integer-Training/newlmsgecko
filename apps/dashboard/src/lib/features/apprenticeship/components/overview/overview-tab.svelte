<script lang="ts">
  import { Button } from '@cio/ui/base/button';
  import { isOrgAdmin } from '$lib/utils/store/org';
  import WithdrawDialog from '../learners/withdraw-dialog.svelte';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import { fmtPct } from '../shared/format';
  import StatusChip from '../shared/status-chip.svelte';
  import StatusBreakdown from './status-breakdown.svelte';
  import QualificationCard from './qualification-card.svelte';
  import AchievedPanel from './achieved-panel.svelte';
  import AddPairCta from './add-pair-cta.svelte';

  // The portfolio's default tab: the three status breakdowns, one card per qualification of the apprenticeship and the
  // achieved panel (plus "Add the paired standard" for an admin when the diploma has a Standard it is not enrolled on).
  interface Props {
    store: PortfolioStore;
    mode: 'staff' | 'learner';
    qualHref: (qualEnrolmentId: string) => string;
    unitHref: (qualEnrolmentId: string, unitId: string) => string;
    /** Admin only: open the dates dialog for one qualification. */
    onEditDates?: (qualEnrolmentId: string) => void;
  }
  let { store, mode, qualHref, unitHref, onEditDates }: Props = $props();

  const o = $derived(store.overview);
  const admin = $derived(mode === 'staff' && $isOrgAdmin === true);
  let withdrawOpen = $state(false);
  let target = $state<{ id: string; title: string; paired: string | null }>({ id: '', title: '', paired: null });
  function startWithdraw(enrolmentId: string) {
    const cards = o?.cards ?? [];
    const c = cards.find((x) => x.enrolmentId === enrolmentId);
    // Only a linked pair offers the THIS / BOTH choice; once the other side is withdrawn there is nothing to choose.
    const other = cards.length > 1 ? cards.find((x) => x.enrolmentId !== enrolmentId && !x.withdrawnAt) : undefined;
    target = { id: enrolmentId, title: c?.title ?? 'this qualification', paired: other?.title ?? null };
    withdrawOpen = true;
  }
</script>

{#if o}
  <div class="space-y-4">
    {#if o.cards.length > 1}
      <p class="flex items-center gap-2 text-sm">
        <span class="font-medium">Overall</span>
        <strong>{fmtPct(o.overall.actualPct)}</strong>
        <StatusChip status={o.overall.status} />
      </p>
    {/if}
    <StatusBreakdown breakdown={o.breakdown} />
    {#each o.cards as card (card.enrolmentId)}
      <QualificationCard
        {card}
        {mode}
        href={qualHref(card.enrolmentId)}
        unitHref={(unitId) => unitHref(card.enrolmentId, unitId)}
        onEditDates={onEditDates ? () => onEditDates(card.enrolmentId) : undefined}
        onWithdraw={admin ? () => startWithdraw(card.enrolmentId) : undefined}
        onReinstate={admin ? () => store.reinstate(card.enrolmentId) : undefined}
      />
    {/each}
    {#if o.cards.length === 1 && o.cards[0].type === 'DIPLOMA'}
      <section class="rounded-lg border border-dashed p-4" aria-label="Paired standard">
        <p class="text-sm font-medium">No standard assigned</p>
        <p class="text-sm text-(--muted-foreground)">This diploma is tracked on its own.</p>
      </section>
    {/if}
    {#if o.canAddPair && mode === 'staff'}
      <AddPairCta canAddPair={o.canAddPair} learnerId={o.learner.id} />
    {/if}
    <AchievedPanel cards={o.cards} />
  </div>
  {#if admin}
    <WithdrawDialog
      bind:open={withdrawOpen}
      enrolmentId={target.id}
      title={target.title}
      pairedTitle={target.paired}
      onDone={() => store.load()}
    />
  {/if}
{:else if store.overviewError}
  <div class="rounded-lg border border-rose-200 p-6 text-center">
    <p role="alert" class="text-sm text-rose-600">{store.overviewError}</p>
    <Button variant="outline" size="sm" class="mt-3" onclick={() => store.load()}>Try again</Button>
  </div>
{:else}
  <p class="text-sm text-(--muted-foreground)" role="status">Loading overview…</p>
{/if}
