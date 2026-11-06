<script lang="ts">
  import { untrack } from 'svelte';
  import * as Dialog from '@cio/ui/base/dialog';
  import * as Select from '@cio/ui/base/select';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import RevealPanel from '$features/learner-management/components/reveal-panel.svelte';
  import { enrolmentsApi, type EnrolmentCreateBody } from '../../api/enrolments.svelte';

  // Enrol a learner on a programme: pick the programme, an existing learner OR a new one, the tutor, the dates and
  // the contracted hours. A new learner's temporary password is revealed once, exactly like the learner dialog.

  interface Props {
    open: boolean;
    onCreated: (id: string) => void;
  }
  let { open = $bindable(), onCreated }: Props = $props();

  let programmeId = $state('');
  let mode = $state<'existing' | 'new'>('existing');
  let learnerId = $state('');
  let learnerSearch = $state('');
  let firstName = $state('');
  let lastName = $state('');
  let email = $state('');
  let tutorId = $state('');
  let startDate = $state('');
  let plannedEndDate = $state('');
  let hoursWeek = $state('');
  let otjHours = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);
  let revealed = $state<{ name: string; password: string; id: string } | null>(null);

  const filteredLearners = $derived.by(() => {
    const q = learnerSearch.trim().toLowerCase();
    const all = enrolmentsApi.learners;
    const list = q ? all.filter((l) => `${l.name ?? ''} ${l.email ?? ''}`.toLowerCase().includes(q)) : all;
    return list.slice(0, 50);
  });
  const chosenLearner = $derived(enrolmentsApi.learners.find((l) => l.userId === learnerId));

  const datesOk = $derived(!!startDate && !!plannedEndDate && plannedEndDate >= startDate);
  const learnerOk = $derived(
    mode === 'existing' ? !!learnerId : !!firstName.trim() && !!lastName.trim() && email.includes('@')
  );
  const canSubmit = $derived(!!programmeId && !!tutorId && datesOk && learnerOk && !saving);

  function reset() {
    programmeId = tutorId = learnerId = learnerSearch = firstName = lastName = email = '';
    startDate = plannedEndDate = hoursWeek = otjHours = '';
    mode = 'existing';
    error = null;
    revealed = null;
  }

  async function submit() {
    if (!canSubmit) return;
    saving = true;
    error = null;
    const body: EnrolmentCreateBody = {
      programmeId,
      learner:
        mode === 'existing'
          ? { learnerId }
          : { firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim() },
      tutorId,
      startDate,
      plannedEndDate,
      contractedHoursWeek: hoursWeek.trim() ? Number(hoursWeek) : null,
      otjTargetMinutesOverride: otjHours.trim() ? Math.round(Number(otjHours) * 60) : null
    };
    const res = await enrolmentsApi.create(body);
    saving = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    if (res.data.temporaryPassword) {
      revealed = {
        name: `${firstName.trim()} ${lastName.trim()}`.trim(),
        password: res.data.temporaryPassword,
        id: res.data.id
      };
      enrolmentsApi.loadOptions();
    } else {
      open = false;
      onCreated(res.data.id);
    }
  }

  function done() {
    const id = revealed?.id;
    open = false;
    if (id) onCreated(id);
  }

  // Start fresh every time the dialog closes (Done, Cancel, overlay or escape).
  $effect(() => {
    if (!open) untrack(reset);
  });

  const programmeLabel = $derived(
    enrolmentsApi.programmes.find((p) => p.id === programmeId)?.title ?? 'Select a programme'
  );
  const tutorLabel = $derived.by(() => {
    const t = enrolmentsApi.tutors.find((x) => x.id === tutorId);
    return t ? (t.name ?? t.email ?? 'Tutor') : 'Select a tutor';
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="ui:max-h-[90vh] ui:overflow-y-auto sm:max-w-xl">
    {#if revealed}
      <Dialog.Header><Dialog.Title>Learner enrolled</Dialog.Title></Dialog.Header>
      <RevealPanel name={revealed.name} password={revealed.password} />
      <Dialog.Footer class="mt-4"><Button onclick={done}>Open portfolio</Button></Dialog.Footer>
    {:else}
      <Dialog.Header>
        <Dialog.Title>Add learner</Dialog.Title>
        <Dialog.Description>Enrol a learner on an apprenticeship programme.</Dialog.Description>
      </Dialog.Header>

      <form
        class="space-y-3"
        onsubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div class="space-y-1">
          <label for="al-prog" class="text-sm font-medium">Programme <span class="text-red-500">*</span></label>
          <Select.Root type="single" bind:value={programmeId}>
            <Select.Trigger id="al-prog" class="ui:w-full">{programmeLabel}</Select.Trigger>
            <Select.Content>
              {#each enrolmentsApi.programmes as p (p.id)}
                <Select.Item value={p.id}>{p.title}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          {#if enrolmentsApi.optionsLoaded && enrolmentsApi.programmes.length === 0}
            <p class="text-xs text-red-500">Create an active programme first.</p>
          {/if}
        </div>

        <fieldset class="space-y-2">
          <legend class="text-sm font-medium">Learner <span class="text-red-500">*</span></legend>
          <div class="flex gap-1.5" role="group" aria-label="Learner type">
            {#each [['existing', 'Existing learner'], ['new', 'New learner']] as const as [value, label] (value)}
              <button
                type="button"
                aria-pressed={mode === value}
                class="rounded-full border px-3 py-1 text-xs {mode === value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'hover:bg-muted'}"
                onclick={() => (mode = value)}
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
                    class="hover:bg-muted flex w-full flex-col px-3 py-1.5 text-left text-sm {learnerId === l.userId
                      ? 'bg-muted'
                      : ''}"
                    onclick={() => (learnerId = l.userId)}
                  >
                    <span class="font-medium">{l.name ?? l.email}</span>
                    {#if l.name && l.email}<span class="text-muted-foreground text-xs">{l.email}</span>{/if}
                  </button>
                </li>
              {:else}
                <li class="text-muted-foreground px-3 py-2 text-sm">No learners found.</li>
              {/each}
            </ul>
            {#if chosenLearner}<p class="text-xs">
                Selected: <strong>{chosenLearner.name ?? chosenLearner.email}</strong>
              </p>{/if}
          {:else}
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div class="space-y-1">
                <label for="al-first" class="text-sm">First name</label>
                <Input id="al-first" bind:value={firstName} maxlength={100} />
              </div>
              <div class="space-y-1">
                <label for="al-last" class="text-sm">Last name</label>
                <Input id="al-last" bind:value={lastName} maxlength={100} />
              </div>
            </div>
            <div class="space-y-1">
              <label for="al-email" class="text-sm">Email</label>
              <Input id="al-email" type="email" autocomplete="off" bind:value={email} />
            </div>
          {/if}
        </fieldset>

        <div class="space-y-1">
          <label for="al-tutor" class="text-sm font-medium">Tutor <span class="text-red-500">*</span></label>
          <Select.Root type="single" bind:value={tutorId}>
            <Select.Trigger id="al-tutor" class="ui:w-full">{tutorLabel}</Select.Trigger>
            <Select.Content>
              {#each enrolmentsApi.tutors as t (t.id)}
                <Select.Item value={t.id}>{t.name ?? t.email ?? 'Tutor'}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div class="space-y-1">
            <label for="al-start" class="text-sm font-medium">Start date <span class="text-red-500">*</span></label>
            <Input id="al-start" type="date" bind:value={startDate} required />
          </div>
          <div class="space-y-1">
            <label for="al-end" class="text-sm font-medium">Planned end date <span class="text-red-500">*</span></label>
            <Input id="al-end" type="date" min={startDate || undefined} bind:value={plannedEndDate} required />
          </div>
          <div class="space-y-1">
            <label for="al-hw" class="text-sm font-medium">Contracted hours / week</label>
            <Input id="al-hw" type="number" min="0.5" max="168" step="0.5" bind:value={hoursWeek} />
          </div>
          <div class="space-y-1">
            <label for="al-otj" class="text-sm font-medium">OTJ target override (hours)</label>
            <Input id="al-otj" type="number" min="0" step="0.5" placeholder="Optional" bind:value={otjHours} />
          </div>
        </div>
        {#if startDate && plannedEndDate && !datesOk}
          <p role="alert" class="text-xs text-rose-600">The planned end date must be on or after the start date.</p>
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
          <Button type="submit" loading={saving} disabled={!canSubmit}>Add learner</Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
