<script lang="ts">
  import * as Dialog from '@cio/ui/base/dialog';
  import * as Select from '@cio/ui/base/select';
  import { Button } from '@cio/ui/base/button';
  import XIcon from '@lucide/svelte/icons/x';
  import { snackbar } from '$features/ui/snackbar/store';
  import { enrolmentsApi } from '../../api/enrolments.svelte';
  import { apprTutorsApi, type EnrolmentTutors } from '../../api/tutors.svelte';
  import type { PortfolioStore } from '../../stores/portfolio.svelte';

  // Admin: the apprentice's NAMED tutors (tutor of record — alerts + review sign-off) with add / remove, and the
  // read-only list of tutors who reach them through the programme (set in Tutor Management › Apprenticeships).

  interface Props {
    open: boolean;
    store: PortfolioStore;
  }
  let { open = $bindable(), store }: Props = $props();

  let data = $state<EnrolmentTutors | null>(null);
  let error = $state('');
  let busy = $state(false);
  let addId = $state('');
  let confirmRemove = $state<string | null>(null);

  $effect(() => {
    if (open) load();
  });

  async function load() {
    data = null;
    error = '';
    addId = '';
    confirmRemove = null;
    if (!enrolmentsApi.optionsLoaded || enrolmentsApi.tutors.length === 0) enrolmentsApi.loadOptions(true);
    const res = await apprTutorsApi.enrolmentTutors(store.enrolmentId);
    if (res.ok) data = res.data;
    else error = res.error;
  }

  const addable = $derived(enrolmentsApi.tutors.filter((t) => !data?.named.some((n) => n.id === t.id)));
  const addLabel = $derived.by(() => {
    const t = enrolmentsApi.tutors.find((x) => x.id === addId);
    return t ? (t.name ?? t.email ?? 'Tutor') : 'Select a tutor';
  });

  async function apply(run: () => ReturnType<typeof apprTutorsApi.addNamed>, done: string) {
    busy = true;
    const res = await run();
    busy = false;
    if (!res.ok) {
      snackbar.error(res.error);
      return;
    }
    data = res.data;
    addId = '';
    confirmRemove = null;
    snackbar.success(done);
    store.load(); // the header shows the named tutors
  }

  const add = () => apply(() => apprTutorsApi.addNamed(store.enrolmentId, addId), 'Tutor added');
  const remove = (id: string) => apply(() => apprTutorsApi.removeNamed(store.enrolmentId, id), 'Tutor removed');
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Tutors</Dialog.Title>
      <Dialog.Description>Who tutors {store.data?.learner.name ?? 'this apprentice'}.</Dialog.Description>
    </Dialog.Header>

    {#if error}
      <p class="py-4 text-center text-sm text-red-600">{error}</p>
    {:else if !data}
      <p class="py-4 text-center text-sm text-(--muted-foreground)">Loading…</p>
    {:else}
      <section class="space-y-2">
        <h3 class="text-sm font-medium">Named tutor</h3>
        <p class="text-xs text-(--muted-foreground)">
          Gets the alerts for this apprentice (evidence to mark, reviews, overdue tasks, gateway) and signs reviews.
          This is the learner's tutor allocation, so it also applies to any diploma courses they take.
        </p>
        {#if data.named.length === 0}
          <p class="rounded-md border border-amber-300 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            No named tutor — tutor alerts for this apprentice go to nobody. Add one below.
          </p>
        {:else}
          <ul class="divide-y rounded-md border">
            {#each data.named as t (t.id)}
              <li class="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span>{t.name}</span>
                {#if confirmRemove === t.id}
                  <span class="flex gap-1">
                    <Button size="sm" variant="destructive" disabled={busy} onclick={() => remove(t.id)}>Remove</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onclick={() => (confirmRemove = null)}>
                      Cancel
                    </Button>
                  </span>
                {:else}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Remove {t.name}"
                    disabled={busy}
                    onclick={() => (confirmRemove = t.id)}
                  >
                    <XIcon class="size-4" />
                  </Button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        <div class="flex gap-2">
          <Select.Root type="single" bind:value={addId}>
            <Select.Trigger class="ui:w-full" aria-label="Tutor to add">{addLabel}</Select.Trigger>
            <Select.Content>
              {#each addable as t (t.id)}
                <Select.Item value={t.id}>{t.name ?? t.email ?? 'Tutor'}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          <Button size="sm" disabled={!addId || busy} onclick={add}>Add</Button>
        </div>
      </section>

      <section class="mt-4 space-y-2">
        <h3 class="text-sm font-medium">Programme tutors</h3>
        <p class="text-xs text-(--muted-foreground)">
          Can see and mark every apprentice on {store.data?.programme.title ?? 'this programme'}, without alerts. Change
          these in Tutor Management › Apprenticeships.
        </p>
        {#if data.programme.length === 0}
          <p class="text-sm text-(--muted-foreground)">None.</p>
        {:else}
          <p class="text-sm">{data.programme.map((t) => t.name).join(', ')}</p>
        {/if}
      </section>
    {/if}

    <Dialog.Footer class="mt-4">
      <Button variant="outline" onclick={() => (open = false)}>Close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
