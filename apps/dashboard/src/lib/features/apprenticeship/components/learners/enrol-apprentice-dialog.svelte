<script lang="ts">
  import { untrack } from 'svelte';
  import { page as appPage } from '$app/state';
  import { currentOrg } from '$lib/utils/store/org';
  import { apprenticeshipsBase } from '../../utils/paths';
  import * as Dialog from '@cio/ui/base/dialog';
  import * as Select from '@cio/ui/base/select';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import RevealPanel from '$features/learner-management/components/reveal-panel.svelte';
  import { enrolmentsApi, type ApprenticeshipCreateBody } from '../../api/enrolments.svelte';
  import type { LearnerCheckResult } from '../../api/overview.types';
  import { fmtDate } from '../shared/format';
  import ProgrammeTypeChip from '../shared/programme-type-chip.svelte';

  // Enrol an apprentice (admin only): 1 learner, 2 programmes (Diploma + Standard / Diploma only / Standard only; the
  // Standard follows the diploma's pair), 3 tutor, hours and a summary. A new learner's temporary password is revealed
  // once. Opened pre-filled (learnerId + programmeId) from the overview's "Add the paired standard" call to action.

  interface Props {
    open: boolean;
    onCreated: (id: string) => void;
    presetLearnerId?: string;
    presetProgrammeId?: string;
  }
  let { open = $bindable(), onCreated, presetLearnerId = '', presetProgrammeId = '' }: Props = $props();

  const programmesBase = $derived(apprenticeshipsBase(appPage.url.pathname, $currentOrg.siteName));

  type Scope = 'both' | 'diploma' | 'standard';

  let step = $state<1 | 2 | 3>(1);
  let mode = $state<'existing' | 'new'>('existing');
  let learnerId = $state('');
  let learnerSearch = $state('');
  let firstName = $state('');
  let lastName = $state('');
  let email = $state('');
  let check = $state<LearnerCheckResult | null>(null);
  let scope = $state<Scope>('both');
  let touchedScope = $state(false);
  let diplomaId = $state('');
  let standardId = $state('');
  let startDate = $state('');
  let plannedEndDate = $state('');
  let sameDates = $state(true);
  let stdStart = $state('');
  let stdEnd = $state('');
  let tutorId = $state('');
  let hoursWeek = $state('');
  let otjHours = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);
  let preset = $state(false);
  let revealed = $state<{ name: string; password: string; id: string } | null>(null);
  let checkReq = 0;

  const programmes = $derived(enrolmentsApi.programmes);
  const diplomas = $derived(programmes.filter((p) => (p.type ?? 'DIPLOMA') === 'DIPLOMA'));
  const allStandards = $derived(programmes.filter((p) => p.type === 'STANDARD'));
  // A learner who already has an open diploma can only take that diploma's paired standard; otherwise every standard is
  // offered (the server still enforces the pairing).
  const standards = $derived.by(() => {
    const open = (check?.apprenticeship ?? []).filter((a) => a.type === 'DIPLOMA' && a.state === 'active');
    if (open.length === 0) return allStandards;
    const allowed = new Set(
      open.map((a) => diplomas.find((d) => d.id === a.programmeId)?.pairedProgramme?.id).filter(Boolean)
    );
    return allowed.size === 0 ? allStandards : allStandards.filter((s) => allowed.has(s.id));
  });
  const diploma = $derived(diplomas.find((p) => p.id === diplomaId));
  const pair = $derived(diploma?.pairedProgramme ?? null);
  const standard = $derived(scope === 'standard' ? standards.find((p) => p.id === standardId) : undefined);
  const needsDiploma = $derived(scope !== 'standard');
  const bothAllowed = $derived(!!pair);
  const levelLabel = (l: string | null | undefined) => (l ? `Level ${l.replace(/^level\s*/i, '')}` : '');

  const filteredLearners = $derived.by(() => {
    const q = learnerSearch.trim().toLowerCase();
    const all = enrolmentsApi.learners;
    const list = q ? all.filter((l) => `${l.name ?? ''} ${l.email ?? ''}`.toLowerCase().includes(q)) : all;
    return list.slice(0, 50);
  });
  const chosenLearner = $derived(enrolmentsApi.learners.find((l) => l.userId === learnerId));
  const learnerName = $derived(
    mode === 'existing'
      ? (chosenLearner?.name ?? chosenLearner?.email ?? 'Learner')
      : `${firstName.trim()} ${lastName.trim()}`.trim()
  );

  const dateOk = (a: string, b: string) => !!a && !!b && b >= a;
  const datesOk = $derived.by(() => {
    if (!dateOk(startDate, plannedEndDate)) return false;
    return scope === 'both' && !sameDates ? dateOk(stdStart, stdEnd) : true;
  });
  const learnerOk = $derived(
    mode === 'existing' ? !!learnerId : !!firstName.trim() && !!lastName.trim() && email.includes('@')
  );
  const programmesOk = $derived(
    scope === 'both' ? !!diploma && bothAllowed : scope === 'diploma' ? !!diploma : !!standard
  );
  const step2Ok = $derived(programmesOk && datesOk);
  const canSubmit = $derived(learnerOk && step2Ok && !!tutorId && !saving);

  // The enrolments the API will receive, in order (diploma first).
  const plan = $derived.by(() => {
    const out: { programmeId: string; title: string; type: 'DIPLOMA' | 'STANDARD'; start: string; end: string }[] = [];
    if (needsDiploma && diploma)
      out.push({
        programmeId: diploma.id,
        title: diploma.title,
        type: 'DIPLOMA',
        start: startDate,
        end: plannedEndDate
      });
    if (scope === 'both' && pair)
      out.push({
        programmeId: pair.id,
        title: pair.title,
        type: 'STANDARD',
        start: sameDates ? startDate : stdStart,
        end: sameDates ? plannedEndDate : stdEnd
      });
    if (scope === 'standard' && standard)
      out.push({
        programmeId: standard.id,
        title: standard.title,
        type: 'STANDARD',
        start: startDate,
        end: plannedEndDate
      });
    return out;
  });
  const noTutorWarnings = $derived(
    plan.filter((p) => {
      const prog = programmes.find((x) => x.id === p.programmeId);
      return prog && (prog.tutorNames?.length ?? 0) === 0;
    })
  );
  // Pre-filled from an existing apprenticeship: hours were set at the first enrolment, so they are not asked again.
  const addingToExisting = $derived(preset && !!presetLearnerId);

  function reset() {
    step = 1;
    mode = 'existing';
    learnerId = learnerSearch = firstName = lastName = email = '';
    check = null;
    scope = 'both';
    touchedScope = false;
    diplomaId = standardId = '';
    startDate = plannedEndDate = stdStart = stdEnd = '';
    sameDates = true;
    tutorId = hoursWeek = otjHours = '';
    error = null;
    revealed = null;
    preset = false;
  }

  async function runCheck(q: { learnerId?: string; email?: string }) {
    const req = ++checkReq;
    check = null;
    const res = await enrolmentsApi.learnerCheck(q);
    if (req === checkReq && res.ok) check = res.data;
  }

  function pickLearner(id: string) {
    learnerId = id;
    runCheck({ learnerId: id });
  }
  function onEmailBlur() {
    if (mode === 'new' && email.includes('@')) runCheck({ email: email.trim() });
  }
  function useExisting() {
    if (!check?.learnerId) return;
    mode = 'existing';
    pickLearner(check.learnerId);
  }

  function pickDiploma(id: string) {
    diplomaId = id;
    const d = diplomas.find((p) => p.id === id);
    // Default to Diploma + Standard when the diploma has a pair; fall back when it has none.
    if (scope === 'both' && !d?.pairedProgramme) scope = 'diploma';
    else if (scope === 'diploma' && d?.pairedProgramme && !touchedScope) scope = 'both';
  }
  function setScope(s: Scope) {
    touchedScope = true;
    scope = s;
  }

  // Apply the pre-fill once the programme and learner pickers are loaded.
  $effect(() => {
    if (!open || !enrolmentsApi.optionsLoaded || preset || !(presetLearnerId || presetProgrammeId)) return;
    untrack(() => {
      if (presetLearnerId) {
        mode = 'existing';
        pickLearner(presetLearnerId);
      }
      const p = programmes.find((x) => x.id === presetProgrammeId);
      if (p?.type === 'STANDARD') {
        scope = 'standard';
        standardId = p.id;
      } else if (p) {
        scope = p.pairedProgramme ? 'both' : 'diploma';
        diplomaId = p.id;
      }
      preset = true;
      touchedScope = true;
      if (presetLearnerId && p) step = 2;
    });
  });

  async function submit() {
    if (!canSubmit) return;
    saving = true;
    error = null;
    const body: ApprenticeshipCreateBody = {
      learner:
        mode === 'existing'
          ? { learnerId }
          : { firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim() },
      tutorId,
      contractedHoursWeek: !addingToExisting && String(hoursWeek ?? '').trim() ? Number(hoursWeek) : null,
      otjTargetMinutesOverride:
        !addingToExisting && String(otjHours ?? '').trim() ? Math.round(Number(otjHours) * 60) : null,
      enrolments: plan.map((p) => ({ programmeId: p.programmeId, startDate: p.start, plannedEndDate: p.end }))
    };
    const res = await enrolmentsApi.createApprenticeship(body);
    saving = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    // Adding the paired standard to an existing apprenticeship: land on the carrier's Overview, not the new component.
    const carrier = addingToExisting ? check?.apprenticeship.find((a) => a.type === 'DIPLOMA')?.enrolmentId : undefined;
    const created = res.data.enrolments.find((e) => e.role !== 'COMPONENT') ?? res.data.enrolments[0];
    const first = carrier ? { id: carrier } : created;
    if (res.data.temporaryPassword) {
      revealed = { name: learnerName, password: res.data.temporaryPassword, id: first?.id ?? '' };
      enrolmentsApi.loadOptions();
    } else {
      open = false;
      if (first) onCreated(first.id);
    }
  }

  function done() {
    const id = revealed?.id;
    open = false;
    if (id) onCreated(id);
  }

  // Any change to the inputs clears a previous error.
  $effect(() => {
    void [mode, learnerId, firstName, lastName, email, scope, diplomaId, standardId, startDate, plannedEndDate];
    void [sameDates, stdStart, stdEnd, tutorId, hoursWeek, otjHours, step];
    untrack(() => (error = null));
  });

  // Start fresh every time the dialog closes (Done, Cancel, overlay or escape).
  $effect(() => {
    if (!open) untrack(reset);
  });

  const tutorLabel = $derived.by(() => {
    const t = enrolmentsApi.tutors.find((x) => x.id === tutorId);
    return t ? (t.name ?? t.email ?? 'Tutor') : 'Select a tutor';
  });
  const STEPS = ['Learner', 'Programmes', 'Tutor and hours'];
  const SCOPES: [Scope, string][] = [
    ['both', 'Diploma + Standard'],
    ['diploma', 'Diploma only'],
    ['standard', 'Standard only']
  ];
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="ui:overflow-y-auto max-h-[90vh]! sm:max-w-xl">
    {#if revealed}
      <Dialog.Header><Dialog.Title>Apprentice enrolled</Dialog.Title></Dialog.Header>
      <RevealPanel name={revealed.name} password={revealed.password} />
      <Dialog.Footer class="mt-4"><Button onclick={done}>Open portfolio</Button></Dialog.Footer>
    {:else}
      <Dialog.Header>
        <Dialog.Title>Enrol apprentice</Dialog.Title>
        <Dialog.Description>Step {step} of 3 · {STEPS[step - 1]}</Dialog.Description>
      </Dialog.Header>

      <ol class="flex gap-1.5" aria-label="Progress">
        {#each STEPS as label, i (label)}
          <li
            class="h-1.5 flex-1 rounded-full {i + 1 <= step ? 'bg-(--primary)' : 'bg-(--muted)'}"
            aria-current={i + 1 === step ? 'step' : undefined}
          >
            <span class="sr-only">{label}</span>
          </li>
        {/each}
      </ol>

      <form
        class="space-y-3"
        onsubmit={(e) => {
          e.preventDefault();
          if (step === 3) submit();
        }}
      >
        {#if step === 1}
          <fieldset class="space-y-2">
            <legend class="text-sm font-medium">Learner <span class="text-red-500">*</span></legend>
            <div class="flex gap-1.5" role="group" aria-label="Learner type">
              {#each [['existing', 'Existing learner'], ['new', 'New learner']] as const as [value, label] (value)}
                <button
                  type="button"
                  aria-pressed={mode === value}
                  class="rounded-full border px-3 py-1 text-xs {mode === value
                    ? 'border-(--primary) bg-(--primary) text-(--primary-foreground)'
                    : 'hover:bg-(--muted)'}"
                  onclick={() => {
                    mode = value;
                    check = null;
                  }}
                >
                  {label}
                </button>
              {/each}
            </div>

            {#if mode === 'existing'}
              <Input
                type="search"
                placeholder="Search by name or email"
                aria-label="Search learners"
                bind:value={learnerSearch}
              />
              <ul class="max-h-40 overflow-y-auto rounded-md border" role="listbox" aria-label="Learners">
                {#each filteredLearners as l (l.userId)}
                  <li role="option" aria-selected={learnerId === l.userId}>
                    <button
                      type="button"
                      class="flex w-full flex-col px-3 py-1.5 text-left text-sm hover:bg-(--muted) {learnerId ===
                      l.userId
                        ? 'bg-(--muted)'
                        : ''}"
                      onclick={() => pickLearner(l.userId)}
                    >
                      <span class="font-medium">{l.name ?? l.email}</span>
                      {#if l.name && l.email}<span class="text-xs text-(--muted-foreground)">{l.email}</span>{/if}
                    </button>
                  </li>
                {:else}
                  <li class="text-(--muted-foreground) px-3 py-2 text-sm">No learners found.</li>
                {/each}
              </ul>
              {#if chosenLearner}<p class="text-xs">
                  Selected: <strong>{chosenLearner.name ?? chosenLearner.email}</strong>
                </p>{/if}
            {:else}
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div class="space-y-1">
                  <label for="ea-first" class="text-sm">First name</label>
                  <Input id="ea-first" bind:value={firstName} maxlength={100} />
                </div>
                <div class="space-y-1">
                  <label for="ea-last" class="text-sm">Last name</label>
                  <Input id="ea-last" bind:value={lastName} maxlength={100} />
                </div>
              </div>
              <div class="space-y-1">
                <label for="ea-email" class="text-sm">Email</label>
                <Input id="ea-email" type="email" autocomplete="off" bind:value={email} onblur={onEmailBlur} />
              </div>
            {/if}
          </fieldset>

          {#if check}
            <div class="space-y-2" aria-live="polite">
              {#if mode === 'new' && check.exists}
                <div
                  class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
                >
                  A user with this email already exists.
                  {#if check.learnerId}
                    <button type="button" class="font-medium underline" onclick={useExisting}>
                      Use Existing learner instead
                    </button>
                  {/if}
                </div>
              {/if}
              {#each check.apprenticeship as a (a.enrolmentId)}
                <div
                  class="flex flex-wrap items-center gap-1.5 rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:bg-sky-500/10 dark:text-sky-300"
                >
                  <span>Already an apprentice on</span>
                  <ProgrammeTypeChip type={a.type} />
                  <strong>{a.programmeTitle}</strong>
                  <span class="opacity-80">({a.state})</span>
                </div>
              {/each}
              {#if check.regularCourses > 0}
                <p class="rounded-md bg-(--muted) px-3 py-2 text-sm">
                  This person is also a regular course learner ({check.regularCourses}
                  course{check.regularCourses === 1 ? '' : 's'}).
                </p>
              {/if}
            </div>
          {/if}
        {:else if step === 2}
          <fieldset class="space-y-2">
            <legend class="text-sm font-medium">What is the learner enrolled on?</legend>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-3" role="group" aria-label="Enrolment type">
              {#each SCOPES as [value, label] (value)}
                <button
                  type="button"
                  disabled={value === 'both' && !!diploma && !bothAllowed}
                  aria-pressed={scope === value}
                  class="rounded-md border px-3 py-2 text-sm disabled:opacity-50 {scope === value
                    ? 'border-(--primary) bg-(--primary) text-(--primary-foreground)'
                    : 'hover:bg-(--muted)'}"
                  onclick={() => setScope(value)}
                >
                  {label}
                </button>
              {/each}
            </div>
          </fieldset>

          {#if needsDiploma}
            <div class="space-y-1">
              <span class="flex items-center gap-1.5 text-sm font-medium" id="ea-dip">
                <ProgrammeTypeChip type="DIPLOMA" /> programme <span class="text-red-500">*</span>
              </span>
              <Select.Root type="single" value={diplomaId} onValueChange={(v) => pickDiploma(v)}>
                <Select.Trigger class="ui:w-full" aria-labelledby="ea-dip">
                  <p class="truncate">{diploma?.title ?? 'Select a programme'}</p>
                </Select.Trigger>
                <Select.Content>
                  {#each diplomas as p (p.id)}
                    <Select.Item value={p.id}>{p.title}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
              {#if enrolmentsApi.optionsLoaded && diplomas.length === 0}
                <p class="text-xs text-red-500">Create an active programme first.</p>
              {/if}
            </div>
            {#if diploma}
              {#if pair}
                <p class="flex flex-wrap items-center gap-1.5 text-xs text-(--muted-foreground)">
                  {levelLabel(diploma.level)}
                  <ProgrammeTypeChip type="DIPLOMA" /> →
                  {levelLabel(pair.level)}
                  <ProgrammeTypeChip type="STANDARD" />
                  <strong>{pair.title}</strong>
                </p>
              {:else}
                <p class="flex flex-wrap items-center gap-1.5 text-xs">
                  <span
                    class="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
                    >No standard paired</span
                  >
                  <a class="underline" href="{programmesBase}/programmes/{diploma.id}">Pair it in Programmes</a>
                </p>
              {/if}
            {/if}
          {:else}
            <div class="space-y-1">
              <span class="flex items-center gap-1.5 text-sm font-medium" id="ea-std">
                <ProgrammeTypeChip type="STANDARD" /> programme <span class="text-red-500">*</span>
              </span>
              <Select.Root type="single" bind:value={standardId}>
                <Select.Trigger class="ui:w-full" aria-labelledby="ea-std">
                  <p class="truncate">{standard?.title ?? 'Select a programme'}</p>
                </Select.Trigger>
                <Select.Content>
                  {#each standards as p (p.id)}
                    <Select.Item value={p.id}>{p.title}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
              {#if enrolmentsApi.optionsLoaded && standards.length === 0}
                <p class="text-xs text-red-500">There is no active standard yet.</p>
              {/if}
            </div>
          {/if}

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="space-y-1">
              <label for="ea-start" class="text-sm font-medium">Start date <span class="text-red-500">*</span></label>
              <Input id="ea-start" type="date" bind:value={startDate} />
            </div>
            <div class="space-y-1">
              <label for="ea-end" class="text-sm font-medium"
                >Planned end date <span class="text-red-500">*</span></label
              >
              <Input id="ea-end" type="date" min={startDate || undefined} bind:value={plannedEndDate} />
            </div>
          </div>
          {#if scope === 'both'}
            <label class="flex items-center gap-2 text-sm">
              <Checkbox checked={sameDates} onCheckedChange={(v) => (sameDates = v === true)} />
              Use the same dates
            </label>
            {#if !sameDates}
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div class="space-y-1">
                  <label for="ea-sstart" class="text-sm font-medium">Standard start date</label>
                  <Input id="ea-sstart" type="date" bind:value={stdStart} />
                </div>
                <div class="space-y-1">
                  <label for="ea-send" class="text-sm font-medium">Standard planned end date</label>
                  <Input id="ea-send" type="date" min={stdStart || undefined} bind:value={stdEnd} />
                </div>
              </div>
            {/if}
          {/if}
          {#if startDate && plannedEndDate && plannedEndDate < startDate}
            <p role="alert" class="text-xs text-rose-600">The planned end date must be on or after the start date.</p>
          {/if}
        {:else}
          <div class="space-y-1">
            <label for="ea-tutor" class="text-sm font-medium">Named tutor <span class="text-red-500">*</span></label>
            <Select.Root type="single" bind:value={tutorId}>
              <Select.Trigger id="ea-tutor" class="ui:w-full">{tutorLabel}</Select.Trigger>
              <Select.Content>
                {#each enrolmentsApi.tutors as t (t.id)}
                  <Select.Item value={t.id}>{t.name ?? t.email ?? 'Tutor'}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
          {#if !addingToExisting}
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div class="space-y-1">
                <label for="ea-hw" class="text-sm font-medium">Contracted hours / week</label>
                <Input id="ea-hw" type="number" min="0.5" max="168" step="0.5" bind:value={hoursWeek} />
              </div>
              <div class="space-y-1">
                <label for="ea-otj" class="text-sm font-medium">OTJ target override (hours)</label>
                <Input id="ea-otj" type="number" min="0" step="0.5" placeholder="Optional" bind:value={otjHours} />
              </div>
            </div>
          {/if}
          {#each noTutorWarnings as w (w.programmeId)}
            <p class="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              {w.title} has no programme tutor. The named tutor reaches it anyway.
            </p>
          {/each}

          <div class="space-y-1.5 rounded-md border p-3 text-sm" aria-label="Summary">
            <p class="font-medium">{learnerName}</p>
            {#each plan as p (p.programmeId)}
              <p class="flex flex-wrap items-center gap-1.5">
                <ProgrammeTypeChip type={p.type} />
                <span>{p.title}</span>
                <span class="text-xs text-(--muted-foreground)">{fmtDate(p.start)} → {fmtDate(p.end)}</span>
              </p>
            {/each}
          </div>
        {/if}

        {#if error}
          <p
            role="alert"
            class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
          >
            {error}
          </p>
        {/if}

        <Dialog.Footer class="mt-4">
          <Button type="button" variant="outline" onclick={() => (open = false)} disabled={saving}>Cancel</Button>
          {#if step > 1}
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onclick={() => {
                error = null;
                step = (step - 1) as 1 | 2;
              }}>Back</Button
            >
          {/if}
          {#if step < 3}
            <Button
              type="button"
              disabled={step === 1 ? !learnerOk : !step2Ok}
              onclick={() => (step = (step + 1) as 2 | 3)}>Next</Button
            >
          {:else}
            <Button type="submit" loading={saving} disabled={!canSubmit}>Enrol</Button>
          {/if}
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
