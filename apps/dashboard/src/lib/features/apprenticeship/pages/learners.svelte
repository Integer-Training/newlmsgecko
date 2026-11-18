<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page as appPage } from '$app/state';
  import * as Page from '@cio/ui/base/page';
  import * as Select from '@cio/ui/base/select';
  import * as Table from '@cio/ui/base/table';
  import { Button } from '@cio/ui/base/button';
  import { Skeleton } from '@cio/ui/base/skeleton';
  import { Search } from '@cio/ui/custom/search';
  import { Empty } from '@cio/ui/custom/empty';
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import {
    APPR_PROGRESS_STATUSES,
    type ApprProgrammeType,
    type ApprProgressStatus
  } from '@cio/utils/constants/apprenticeship';
  import { currentOrg, isOrgAdmin } from '$lib/utils/store/org';
  import { apprenticeshipsBase } from '../utils/paths';
  import { enrolmentsApi, type EnrolmentRow } from '../api/enrolments.svelte';
  import EnrolApprenticeDialog from '../components/learners/enrol-apprentice-dialog.svelte';
  import ProgrammeTypeChip from '../components/shared/programme-type-chip.svelte';
  import ProgressBar from '../components/shared/progress-bar.svelte';
  import StatusChip from '../components/shared/status-chip.svelte';
  import StageChip from '../components/shared/stage-chip.svelte';
  import TutorCell from '../components/shared/tutor-cell.svelte';
  import { fmtDate, fmtMinutes, fmtPct, STATUS_LABEL } from '../components/shared/format';

  // Gecko Apprenticeships — the learners table. One row per enrolment: qualification progress against where the
  // learner should be, off-the-job hours, RAG status, tutor and how much is waiting to be marked. Filters and the
  // per-status counts come from the API; paging is server-side. Shared by the admin area and the tutor caseload
  // (Phase B): the API scopes a tutor to their allocated learners; Add learner + the tutor filter are admin-only.

  const PAGE_SIZE = 25;

  // Query params (the Summary tiles link here): ?type=DIPLOMA|STANDARD|BOTH &status=... &programmeId=... &onboarding=incomplete
  const q0 = appPage.url.searchParams;
  const typeParam = q0.get('type');
  const statusParam = q0.get('status');
  let programmeId = $state(q0.get('programmeId') ?? '');
  // BOTH = linked pairs (diploma + standard), filtered server-side.
  let typeFilter = $state<ApprProgrammeType | 'BOTH' | ''>(
    typeParam === 'DIPLOMA' || typeParam === 'STANDARD' || typeParam === 'BOTH' ? typeParam : ''
  );
  let tutorId = $state('');
  let status = $state<ApprProgressStatus | ''>(
    (APPR_PROGRESS_STATUSES as readonly string[]).includes(statusParam ?? '') ? (statusParam as ApprProgressStatus) : ''
  );

  // Optional columns, remembered per browser.
  const COLUMNS = [
    ['dates', 'Dates'],
    ['onboarding', 'Onboarding'],
    ['glh', 'GLH'],
    ['stage', 'Stage'],
    ['overdue', 'Overdue']
  ] as const;
  type ColKey = (typeof COLUMNS)[number][0];
  const COLS_KEY = 'gecko-appr-learner-columns';
  let extraCols = $state<ColKey[]>([]);
  let colsOpen = $state(false);
  try {
    const saved = JSON.parse(localStorage.getItem(COLS_KEY) ?? '[]');
    if (Array.isArray(saved)) extraCols = COLUMNS.map(([k]) => k).filter((k) => saved.includes(k));
  } catch {
    /* storage unavailable: defaults */
  }
  function toggleCol(k: ColKey) {
    extraCols = extraCols.includes(k) ? extraCols.filter((c) => c !== k) : [...extraCols, k];
    try {
      localStorage.setItem(COLS_KEY, JSON.stringify(extraCols));
    } catch {
      /* ignore */
    }
  }
  const has = (k: ColKey) => extraCols.includes(k);
  let noTutor = $state(false);
  // ?onboarding=incomplete (the Summary card) opens the list already filtered.
  let onboardingIncomplete = $state(q0.get('onboarding') === 'incomplete');
  let searchValue = $state('');
  let debouncedSearch = $state('');
  let page = $state(1);
  // ?enrol=1 (workspace button) opens the wizard; &learner=<id>&programme=<id> pre-fills it ("Add the paired standard").
  let addOpen = $state(appPage.url.searchParams.get('enrol') === '1');
  let presetLearner = $state(appPage.url.searchParams.get('learner') ?? '');
  let presetProgramme = $state(appPage.url.searchParams.get('programme') ?? '');
  let created = false;

  // The header button links to ?enrol=1 even when already on this page: react to the query, not just mount.
  $effect(() => {
    const sp = appPage.url.searchParams;
    if (sp.get('enrol') !== '1') return;
    untrack(() => {
      created = false;
      presetLearner = sp.get('learner') ?? '';
      presetProgramme = sp.get('programme') ?? '';
      addOpen = true;
    });
  });
  // Closing the dialog drops the query so the same link works again.
  $effect(() => {
    if (addOpen || created) return;
    const url = untrack(() => new URL(appPage.url));
    if (!url.searchParams.has('enrol')) return;
    ['enrol', 'learner', 'programme'].forEach((k) => url.searchParams.delete(k));
    void goto(url.pathname + url.search, { replaceState: true, noScroll: true, keepFocus: true });
  });
  let retry = $state(0);

  const base = $derived(apprenticeshipsBase(appPage.url.pathname, $currentOrg.siteName));
  const list = $derived(enrolmentsApi.list);
  const rows = $derived(list?.items ?? []);
  const totalPages = $derived(list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1);
  const totalShown = $derived(list?.total ?? 0);
  const hasFilters = $derived(
    !!programmeId || !!typeFilter || !!tutorId || !!status || !!debouncedSearch || noTutor || onboardingIncomplete
  );

  // The admin flag is unknown (null) on a hard load: load the pickers once it is known, not before.
  // (currentOrg starts as an empty placeholder, so wait for a real org + role; reload if it later resolves to admin.)
  let optionsLoadedFor: boolean | null = null;
  $effect(() => {
    const org = $currentOrg;
    const admin = $isOrgAdmin;
    if (!org?.id || admin === null || admin === undefined) return;
    if (optionsLoadedFor === admin || optionsLoadedFor === true) return;
    optionsLoadedFor = admin;
    untrack(() => enrolmentsApi.loadOptions(admin === true));
  });

  // Debounce typing so the table doesn't refetch per keystroke.
  $effect(() => {
    const v = searchValue;
    const t = setTimeout(() => (debouncedSearch = v), 300);
    return () => clearTimeout(t);
  });

  // Any filter change goes back to page 1 and refetches; so does paging.
  let lastKey = '';
  $effect(() => {
    const key = JSON.stringify([
      programmeId,
      typeFilter,
      tutorId,
      status,
      debouncedSearch,
      noTutor,
      onboardingIncomplete
    ]);
    let p = page;
    if (key !== lastKey) {
      if (lastKey !== '' && p !== 1) {
        p = 1;
        untrack(() => (page = 1));
      }
      lastKey = key;
    }
    retry;
    const filters = {
      programmeId: programmeId || undefined,
      type: typeFilter || undefined,
      tutorId: tutorId || undefined,
      status: status || undefined,
      search: debouncedSearch || undefined,
      noTutor: noTutor || undefined,
      onboarding: onboardingIncomplete ? ('incomplete' as const) : undefined,
      page: p,
      pageSize: PAGE_SIZE
    };
    untrack(() => enrolmentsApi.load(filters));
  });

  function reset() {
    programmeId = '';
    typeFilter = '';
    tutorId = '';
    status = '';
    noTutor = false;
    onboardingIncomplete = false;
    searchValue = '';
    debouncedSearch = '';
  }

  function open(id: string) {
    goto(`${base}/learners/${id}`);
  }
  // Enter / Space on a focused row opens it; ignore keys aimed at the row's own links and buttons.
  function rowKey(e: KeyboardEvent, id: string) {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open(id);
    }
  }
  const rowFocus =
    'cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--primary)';
  const chipBase = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';
  const pillOn = 'border-(--primary) bg-(--primary) text-(--primary-foreground)';
  const pillBase =
    'min-h-8 rounded-full border px-3 py-1 text-sm focus-visible:ring-2 focus-visible:ring-(--ring) focus-visible:outline-none';

  const programmeLabel = $derived(
    programmeId ? (enrolmentsApi.programmes.find((p) => p.id === programmeId)?.title ?? 'Programme') : 'All programmes'
  );
  const diplomaOptions = $derived(
    enrolmentsApi.programmes.filter(
      (p) => (p.type ?? 'DIPLOMA') === 'DIPLOMA' && (!typeFilter || typeFilter === 'DIPLOMA' || typeFilter === 'BOTH')
    )
  );
  const standardOptions = $derived(
    enrolmentsApi.programmes.filter(
      (p) => p.type === 'STANDARD' && (!typeFilter || typeFilter === 'STANDARD' || typeFilter === 'BOTH')
    )
  );
  // A diploma-only apprentice gets the amber chip; the tooltip says whether a Standard could be added.
  function pairAvailable(id: string) {
    return !!enrolmentsApi.programmes.find((p) => p.id === id)?.pairedProgramme;
  }
  const tutorLabel = $derived.by(() => {
    if (!tutorId) return 'All tutors';
    const t = enrolmentsApi.tutors.find((x) => x.id === tutorId);
    return t?.name ?? t?.email ?? 'Tutor';
  });
</script>

<svelte:head>
  <title>Apprenticeship learners — {$currentOrg.name}</title>
</svelte:head>

{#snippet learnerCell(r: EnrolmentRow)}
  <div class="min-w-0">
    <p class="font-medium">{r.learner.name}</p>
    {#if r.learner.email}
      <p class="text-xs break-all text-(--muted-foreground)">{r.learner.email}</p>
    {/if}
  </div>
{/snippet}

{#snippet programmeCell(r: EnrolmentRow)}
  <div class="space-y-1 text-sm">
    <p class="flex flex-wrap items-center gap-1.5">
      {#if r.programmeType}<ProgrammeTypeChip type={r.programmeType} />{/if}
      <span>{r.programmeTitle}</span>
    </p>
    {#if r.linked}
      <p class="flex flex-wrap items-center gap-1.5">
        <ProgrammeTypeChip type={r.linked.type} />
        <span>{r.linked.programmeTitle}</span>
      </p>
    {:else if r.programmeType === 'DIPLOMA'}
      <p>
        <span
          class="{chipBase} bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
          title={pairAvailable(r.programmeId)
            ? 'On the diploma only. Its paired standard can be added.'
            : 'On the diploma only. This programme has no paired standard.'}>No standard</span
        >
      </p>
    {/if}
  </div>
{/snippet}

{#snippet progressCell(r: EnrolmentRow)}
  {#if r.linked}
    <div class="space-y-1.5">
      <div class="flex items-center gap-2">
        {#if r.programmeType}<ProgrammeTypeChip type={r.programmeType} />{/if}
        <div class="min-w-0 flex-1">
          <ProgressBar
            actual={r.actualPct}
            expected={r.expectedPct}
            label="{r.learner.name} {r.programmeTitle} progress"
          />
        </div>
        <span class="w-9 text-right text-xs">{fmtPct(r.actualPct)}</span>
      </div>
      <div class="flex items-center gap-2">
        <ProgrammeTypeChip type={r.linked.type} />
        <div class="min-w-0 flex-1">
          <ProgressBar
            actual={r.linked.actualPct}
            expected={r.linked.expectedPct}
            label="{r.learner.name} {r.linked.programmeTitle} progress"
          />
        </div>
        <span class="w-9 text-right text-xs">{fmtPct(r.linked.actualPct)}</span>
      </div>
    </div>
    <p class="mt-1 text-xs text-(--muted-foreground)">Overall {fmtPct(r.overall?.actualPct ?? null)}</p>
  {:else}
    <ProgressBar actual={r.actualPct} expected={r.expectedPct} label="{r.learner.name} qualification progress" />
    <p class="mt-1 text-xs text-(--muted-foreground)">
      {fmtPct(r.actualPct)}{r.expectedPct !== null ? ` · expected ${r.expectedPct}%` : ' · expected —'}
    </p>
  {/if}
{/snippet}

{#snippet otjCell(r: EnrolmentRow)}
  <ProgressBar
    actual={r.otj.targetMinutes ? Math.floor((r.otj.minutes / r.otj.targetMinutes) * 100) : null}
    expected={r.otj.targetMinutes && r.otj.expectedMinutes !== null
      ? Math.round((r.otj.expectedMinutes / r.otj.targetMinutes) * 100)
      : null}
    label="{r.learner.name} off-the-job hours"
  />
  <p class="mt-1 text-xs text-(--muted-foreground)">
    {fmtMinutes(r.otj.minutes)} of {fmtMinutes(r.otj.targetMinutes)}
  </p>
{/snippet}

{#snippet toMarkCell(r: EnrolmentRow)}
  {#if r.toMark > 0}
    <span
      class="inline-flex min-w-6 items-center justify-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
      aria-label="{r.toMark} to mark">{r.toMark}</span
    >
  {:else}
    <span class="text-(--muted-foreground)">0</span>
  {/if}
{/snippet}

{#snippet extraCell(r: EnrolmentRow, k: ColKey)}
  {#if k === 'dates'}
    <span class="text-xs whitespace-nowrap">{fmtDate(r.startDate)} → {fmtDate(r.plannedEndDate)}</span>
  {:else if k === 'onboarding'}
    {#if !r.onboarding || r.onboarding.required === 0}
      <span class="text-(--muted-foreground)">—</span>
    {:else if r.onboarding.approved >= r.onboarding.required}
      <span
        class="{chipBase} bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300"
        aria-label="Onboarding complete">✓ Complete</span
      >
    {:else}
      <span
        class="{chipBase} bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
        aria-label="Onboarding {r.onboarding.approved} of {r.onboarding.required} approved"
        >Onboarding {r.onboarding.approved}/{r.onboarding.required}</span
      >
    {/if}
  {:else if k === 'glh'}
    {#if r.glh}
      <span class="text-xs">{fmtMinutes(r.glh.doneMinutes)} of {fmtMinutes(r.glh.targetMinutes)}</span>
    {:else}
      <span class="text-(--muted-foreground)">—</span>
    {/if}
  {:else if k === 'stage'}
    <StageChip stage={r.stage} label={r.stageLabel} />
  {:else if k === 'overdue'}
    {#if (r.overdueTaskCount ?? 0) > 0 || r.reviewOverdue}
      <div class="flex flex-wrap gap-1">
        {#if (r.overdueTaskCount ?? 0) > 0}
          <span class="{chipBase} bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300"
            >Overdue tasks {r.overdueTaskCount}</span
          >
        {/if}
        {#if r.reviewOverdue}
          <span class="{chipBase} bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300">Review overdue</span
          >
        {/if}
      </div>
    {:else}
      <span class="text-(--muted-foreground)">None</span>
    {/if}
  {/if}
{/snippet}

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      <Page.Title>Apprenticeship learners</Page.Title>
      <Page.Subtitle>Progress, off-the-job hours and marking · {$currentOrg.name}</Page.Subtitle>
    </Page.HeaderContent>
    <Page.Action>
      <Button variant="outline" href="{base}/to-mark">To mark</Button>
      {#if $isOrgAdmin}
        <Button onclick={() => (addOpen = true)}>
          <UserPlusIcon size={16} class="mr-1" /> Enrol apprentice
        </Button>
      {/if}
    </Page.Action>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      <!-- Status quick chips with the API's counts -->
      <div class="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        <button
          type="button"
          aria-pressed={status === ''}
          class="{pillBase} {status === '' ? pillOn : 'hover:bg-(--muted)'}"
          onclick={() => (status = '')}
        >
          All
        </button>
        {#each APPR_PROGRESS_STATUSES as s (s)}
          <button
            type="button"
            aria-pressed={status === s}
            class="{pillBase} {status === s ? pillOn : 'hover:bg-(--muted)'}"
            onclick={() => (status = status === s ? '' : s)}
          >
            {STATUS_LABEL(s)}
            <span class="ml-1 opacity-70">{list?.statusCounts?.[s] ?? 0}</span>
          </button>
        {/each}
      </div>

      <div class="mb-4 flex flex-wrap items-end gap-3">
        <div class="flex flex-col gap-1">
          <span class="text-xs text-(--muted-foreground)">Type</span>
          <div class="flex gap-1" role="group" aria-label="Filter by programme type">
            {#each [['', 'All'], ['DIPLOMA', 'Diploma'], ['STANDARD', 'Standard'], ['BOTH', 'Both']] as const as [value, label] (value)}
              <button
                type="button"
                aria-pressed={typeFilter === value}
                class="{pillBase} {typeFilter === value ? pillOn : 'hover:bg-(--muted)'}"
                onclick={() => {
                  typeFilter = value;
                  programmeId = '';
                }}
              >
                {label}
              </button>
            {/each}
          </div>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-xs text-(--muted-foreground)" id="lf-prog">Programme</span>
          <Select.Root type="single" bind:value={programmeId}>
            <Select.Trigger class="min-w-[200px]" aria-labelledby="lf-prog"
              ><p class="truncate">{programmeLabel}</p></Select.Trigger
            >
            <Select.Content>
              <Select.Item value="">All programmes</Select.Item>
              {#if diplomaOptions.length}
                <Select.Group>
                  <Select.Label>Diplomas</Select.Label>
                  {#each diplomaOptions as p (p.id)}
                    <Select.Item value={p.id}>{p.title}</Select.Item>
                  {/each}
                </Select.Group>
              {/if}
              {#if standardOptions.length}
                <Select.Group>
                  <Select.Label>Standards</Select.Label>
                  {#each standardOptions as p (p.id)}
                    <Select.Item value={p.id}>{p.title}</Select.Item>
                  {/each}
                </Select.Group>
              {/if}
            </Select.Content>
          </Select.Root>
        </div>
        {#if $isOrgAdmin}
          <div class="flex flex-col gap-1">
            <span class="text-xs text-(--muted-foreground)" id="lf-tutor">Tutor</span>
            <Select.Root type="single" bind:value={tutorId}>
              <Select.Trigger class="min-w-[180px]" aria-labelledby="lf-tutor"
                ><p class="truncate">{tutorLabel}</p></Select.Trigger
              >
              <Select.Content>
                <Select.Item value="">All tutors</Select.Item>
                {#each enrolmentsApi.tutors as t (t.id)}
                  <Select.Item value={t.id}>{t.name ?? t.email ?? 'Tutor'}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
        {/if}
        <div class="flex flex-col gap-1">
          <span class="text-xs text-(--muted-foreground)">Search</span>
          <Search placeholder="Learner name or email" class="ui:max-w-[260px]" bind:value={searchValue} />
        </div>
        <div class="flex gap-2" role="group" aria-label="Quick filters">
          <button
            type="button"
            aria-pressed={noTutor}
            class="{pillBase} {noTutor ? pillOn : 'hover:bg-(--muted)'}"
            onclick={() => (noTutor = !noTutor)}
          >
            No tutor
          </button>
          <button
            type="button"
            aria-pressed={onboardingIncomplete}
            class="{pillBase} {onboardingIncomplete ? pillOn : 'hover:bg-(--muted)'}"
            onclick={() => (onboardingIncomplete = !onboardingIncomplete)}
          >
            Onboarding incomplete
          </button>
        </div>
        {#if hasFilters}
          <Button variant="ghost" onclick={reset}>Reset filters</Button>
        {/if}
        <div class="relative ml-auto">
          <Button
            variant="outline"
            size="sm"
            aria-expanded={colsOpen}
            aria-controls="lf-cols"
            onclick={() => (colsOpen = !colsOpen)}
          >
            Columns{extraCols.length ? ` (+${extraCols.length})` : ''}
          </Button>
          {#if colsOpen}
            <div
              id="lf-cols"
              role="group"
              aria-label="Optional columns"
              class="absolute right-0 z-20 mt-1 w-48 space-y-1 rounded-md border p-2 shadow-md"
              style="background-color: var(--background)"
            >
              {#each COLUMNS as [k, label] (k)}
                <label class="flex min-h-9 cursor-pointer items-center gap-2 rounded px-2 text-sm hover:bg-(--muted)">
                  <input type="checkbox" checked={has(k)} onchange={() => toggleCol(k)} />
                  {label}
                </label>
              {/each}
            </div>
          {/if}
        </div>
      </div>

      {#if enrolmentsApi.listError && !list}
        <div class="rounded-lg border border-rose-200 p-6 text-center">
          <p role="alert" class="text-sm text-rose-600">{enrolmentsApi.listError}</p>
          <Button variant="outline" size="sm" class="mt-3" onclick={() => (retry += 1)}>Try again</Button>
        </div>
      {:else if !list}
        <div class="space-y-2" role="status" aria-label="Loading learners">
          {#each Array(6) as _, i (i)}<Skeleton class="h-14 w-full" />{/each}
        </div>
      {:else if rows.length === 0}
        <Empty
          title={hasFilters ? 'No learners match' : 'No apprentices yet'}
          description={hasFilters
            ? 'Try different filters.'
            : $isOrgAdmin
              ? 'Add a learner to start tracking their portfolio.'
              : 'Apprentices allocated to you will appear here.'}
        />
      {:else}
        <!-- Mobile: stacked cards -->
        <ul
          class="space-y-3 md:hidden {enrolmentsApi.isLoading ? 'opacity-70' : ''}"
          aria-busy={enrolmentsApi.isLoading}
        >
          {#each rows as r (r.id)}
            <li>
              <div
                class="space-y-3 rounded-lg border p-4 {rowFocus}"
                role="link"
                tabindex="0"
                aria-label="Open {r.learner.name}"
                onclick={() => open(r.id)}
                onkeydown={(e) => rowKey(e, r.id)}
              >
                <div class="flex items-start justify-between gap-2">
                  {@render learnerCell(r)}
                  <StatusChip status={r.status} />
                </div>
                {@render programmeCell(r)}
                {@render progressCell(r)}
                {@render otjCell(r)}
                <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span class="text-(--muted-foreground)">Tutor</span>
                  <TutorCell tutors={r.tutors} />
                </div>
                <div class="flex items-center justify-between text-sm">
                  <span class="text-(--muted-foreground)">To mark</span>
                  {@render toMarkCell(r)}
                </div>
                {#each COLUMNS.filter(([k]) => has(k)) as [k, label] (k)}
                  <div class="flex items-start justify-between gap-2 text-sm">
                    <span class="text-(--muted-foreground)">{label}</span>
                    <span class="text-right">{@render extraCell(r, k)}</span>
                  </div>
                {/each}
              </div>
            </li>
          {/each}
        </ul>

        <!-- Desktop: table -->
        <div
          class="hidden overflow-x-auto rounded-lg border md:block {enrolmentsApi.isLoading ? 'opacity-70' : ''}"
          aria-busy={enrolmentsApi.isLoading}
        >
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Learner</Table.Head>
                <Table.Head class="min-w-48">Programme</Table.Head>
                <Table.Head class="min-w-56">Progress</Table.Head>
                <Table.Head class="min-w-44">Off-the-job</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Tutor</Table.Head>
                <Table.Head class="text-right">To mark</Table.Head>
                {#each COLUMNS.filter(([k]) => has(k)) as [k, label] (k)}
                  <Table.Head>{label}</Table.Head>
                {/each}
                <Table.Head><span class="sr-only">Actions</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each rows as r (r.id)}
                <Table.Row
                  class={rowFocus}
                  tabindex={0}
                  aria-label="Open {r.learner.name}"
                  onclick={() => open(r.id)}
                  onkeydown={(e: KeyboardEvent) => rowKey(e, r.id)}
                >
                  <Table.Cell>{@render learnerCell(r)}</Table.Cell>
                  <Table.Cell>{@render programmeCell(r)}</Table.Cell>
                  <Table.Cell>{@render progressCell(r)}</Table.Cell>
                  <Table.Cell>{@render otjCell(r)}</Table.Cell>
                  <Table.Cell><StatusChip status={r.status} /></Table.Cell>
                  <Table.Cell><TutorCell tutors={r.tutors} /></Table.Cell>
                  <Table.Cell class="text-right">{@render toMarkCell(r)}</Table.Cell>
                  {#each COLUMNS.filter(([k]) => has(k)) as [k] (k)}
                    <Table.Cell>{@render extraCell(r, k)}</Table.Cell>
                  {/each}
                  <Table.Cell>
                    <Button
                      variant="outline"
                      size="sm"
                      href="{base}/learners/{r.id}"
                      aria-label="View {r.learner.name}"
                      onclick={(e: MouseEvent) => e.stopPropagation()}
                    >
                      View
                    </Button>
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </div>

        <div class="mt-3 flex items-center justify-between text-sm">
          <span class="text-(--muted-foreground)"
            >{totalShown} learner{totalShown === 1 ? '' : 's'}{typeFilter === 'BOTH' ? ' on both' : ''}</span
          >
          {#if totalPages > 1}
            <div class="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onclick={() => (page -= 1)}>Previous</Button>
              <span aria-live="polite">Page {page} of {totalPages}</span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onclick={() => (page += 1)}>Next</Button
              >
            </div>
          {/if}
        </div>
      {/if}
    {/snippet}
  </Page.Body>
</Page.Root>

{#if $isOrgAdmin}
  <EnrolApprenticeDialog
    bind:open={addOpen}
    presetLearnerId={presetLearner}
    presetProgrammeId={presetProgramme}
    onCreated={(id) => {
      created = true;
      retry += 1;
      goto(`${base}/learners/${id}`);
    }}
  />
{/if}
