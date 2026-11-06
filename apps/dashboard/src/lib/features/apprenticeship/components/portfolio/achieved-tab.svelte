<script lang="ts">
  import { Empty } from '@cio/ui/custom/empty';
  import AwardIcon from '@lucide/svelte/icons/award';
  import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';
  import { fmtDate } from '../shared/format';

  // Achieved tab: units the API marks COMPLETE, with the date the enrolment was completed where we have one, and the
  // qualification itself once every unit is done.

  interface Props {
    store: PortfolioStore;
  }
  let { store }: Props = $props();

  const quals = $derived(
    (store.data?.qualifications ?? []).map((q) => ({
      ...q,
      done: q.units.filter((u) => u.status === 'COMPLETE'),
      all: q.units.length > 0 && q.units.every((u) => u.status === 'COMPLETE')
    }))
  );
  const anyDone = $derived(quals.some((q) => q.done.length > 0));
</script>

{#if !anyDone}
  <Empty title="Nothing achieved yet" description="Units appear here once every criterion in them is met." />
{:else}
  <div class="space-y-5">
    {#each quals.filter((q) => q.done.length > 0) as q (q.id)}
      <section aria-label={q.title} class="space-y-2">
        <h3 class="flex items-center gap-2 font-semibold">
          {q.title}
          {#if q.all}
            <span
              class="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800 dark:bg-sky-500/20 dark:text-sky-300"
            >
              <AwardIcon size={12} /> Qualification achieved{store.data?.enrolment.achievedAt
                ? ` · ${fmtDate(store.data.enrolment.achievedAt)}`
                : ''}
            </span>
          {/if}
        </h3>
        <ul class="divide-y rounded-lg border">
          {#each q.done as u (u.id)}
            <li class="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span class="flex min-w-0 items-center gap-2">
                <CircleCheckIcon size={16} class="shrink-0 text-emerald-600" />
                <span class="truncate">{u.code ? `${u.code} · ` : ''}{u.title}</span>
              </span>
              <span class="text-muted-foreground whitespace-nowrap">Target {fmtDate(u.targetDate)}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  </div>
{/if}
