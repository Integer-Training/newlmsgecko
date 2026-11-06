<script lang="ts">
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import CriterionPopover from './criterion-popover.svelte';

  // Criteria map: rows = units, cells = criteria codes. Grey = not started, amber = evidence submitted and waiting,
  // green = met. Clicking a cell lists the evidence mapped to it (same popover as the Units tab).

  interface Props {
    store: PortfolioStore;
  }
  let { store }: Props = $props();

  const CELL = {
    met: 'bg-emerald-100 text-emerald-900 border-emerald-300 dark:bg-emerald-500/20 dark:text-emerald-200 dark:border-emerald-500/40',
    pending:
      'bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-500/20 dark:text-amber-200 dark:border-amber-500/40',
    none: 'bg-muted text-muted-foreground border-transparent'
  };
</script>

<div class="space-y-6">
  <ul class="text-muted-foreground flex flex-wrap gap-3 text-xs" aria-label="Legend">
    <li class="flex items-center gap-1.5"><span class="size-3 rounded border {CELL.none}"></span> Not started</li>
    <li class="flex items-center gap-1.5">
      <span class="size-3 rounded border {CELL.pending}"></span> Pending (submitted)
    </li>
    <li class="flex items-center gap-1.5"><span class="size-3 rounded border {CELL.met}"></span> Met</li>
  </ul>

  {#each store.data?.qualifications ?? [] as qual (qual.id)}
    <section aria-label={qual.title}>
      <h3 class="mb-2 font-semibold">{qual.title}</h3>
      <div class="divide-y rounded-lg border">
        {#each qual.units as unit (unit.id)}
          <div class="grid grid-cols-1 gap-2 px-3 py-2 md:grid-cols-[16rem_1fr]">
            <p class="truncate text-sm font-medium" title={unit.title}>
              {unit.code ? `${unit.code} · ` : ''}{unit.title}
            </p>
            <div class="flex flex-wrap gap-1.5">
              {#each unit.criteria as c (c.id)}
                {@const kind = c.met ? 'met' : c.pendingCount > 0 ? 'pending' : 'none'}
                <CriterionPopover
                  {store}
                  criterionId={c.id}
                  label="{c.code}: {c.met ? 'met' : c.pendingCount > 0 ? 'pending' : 'not started'}"
                  triggerClass="min-w-10 rounded border px-2 py-1 text-xs font-medium transition-colors hover:ring-2 hover:ring-primary/40 {CELL[
                    kind
                  ]}"
                >
                  {c.code}
                </CriterionPopover>
              {/each}
              {#if unit.criteria.length === 0}<span class="text-muted-foreground text-xs">No criteria</span>{/if}
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/each}
</div>
