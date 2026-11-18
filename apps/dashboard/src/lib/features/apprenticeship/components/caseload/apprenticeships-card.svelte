<script lang="ts">
  import { onMount } from 'svelte';
  import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap';
  import { apprSummaryApi, type ApprSummary } from '../../api/summary.svelte';
  import { otjApi } from '../../api/otj.svelte';

  // Tutor dashboard card — what is waiting across the apprenticeships the tutor touches. Numbers come straight from
  // GET /apprenticeship/summary and the OTJ log queue. Hidden for tutors with no apprenticeship learners.
  const BASE = '/caseload/apprenticeships';

  let summary = $state<ApprSummary | null>(null);
  let otjWaiting = $state<number | null>(null);

  onMount(() => {
    apprSummaryApi.get().then((res) => {
      if (res.ok) summary = res.data;
    });
    otjApi.queue('SUBMITTED').then((res) => {
      if (res.ok) otjWaiting = res.data.length;
    });
  });

  const tiles = $derived([
    { label: 'To mark', value: summary?.toMark ?? 0, href: `${BASE}/to-mark`, warn: true },
    { label: 'OTJ logs waiting', value: otjWaiting ?? 0, href: `${BASE}/to-mark`, warn: true },
    { label: 'Overdue reviews', value: summary?.reviews.overdueTotal ?? 0, href: `${BASE}/summary`, warn: true },
    { label: 'Gateway ready', value: summary?.gateway.ready ?? 0, href: `${BASE}/summary`, warn: false }
  ]);
</script>

{#if summary && summary.learners.total > 0}
  <section class="bg-card mb-6 rounded-xl border p-4" aria-labelledby="appr-card-title">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 id="appr-card-title" class="flex items-center gap-2 text-lg font-semibold tracking-tight">
        <GraduationCapIcon size={18} class="text-teal-600 dark:text-teal-400" /> Apprenticeships
      </h2>
      <a href={BASE} class="text-sm text-teal-700 hover:underline dark:text-teal-300">Open workspace</a>
    </div>
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {#each tiles as t (t.label)}
        <a href={t.href} class="hover:bg-muted/40 rounded-lg border p-3 transition-colors">
          <p
            class="text-2xl font-semibold {t.value > 0 && t.warn
              ? 'text-amber-600 dark:text-amber-400'
              : t.value > 0
                ? 'text-emerald-600 dark:text-emerald-400'
                : ''}"
          >
            {t.value}
          </p>
          <p class="text-muted-foreground text-xs">{t.label}</p>
        </a>
      {/each}
    </div>
  </section>
{/if}
