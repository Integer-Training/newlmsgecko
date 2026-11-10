<script lang="ts">
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import { snackbar } from '$features/ui/snackbar/store';
  import { apprTutorsApi, type TutorProgrammes } from '$features/apprenticeship/api/tutors.svelte';

  // Tutor Management › Apprenticeships: the apprenticeship programmes a tutor teaches (like their courses). Saves the
  // exact selection. Archived programmes are listed only while still assigned, so they can be removed.

  interface Props {
    open: boolean;
    tutorId: string | null;
    tutorName: string;
  }

  let { open = $bindable(), tutorId, tutorName }: Props = $props();

  let data = $state<TutorProgrammes | null>(null);
  let selected = $state<string[]>([]);
  let error = $state('');
  let busy = $state(false);
  let loadedFor = $state<string | null>(null);

  $effect(() => {
    if (open && tutorId && loadedFor !== tutorId) {
      loadedFor = tutorId;
      load(tutorId);
    }
  });

  async function load(id: string) {
    data = null;
    error = '';
    const res = await apprTutorsApi.tutorProgrammes(id);
    if (loadedFor !== id) return;
    if (res.ok) {
      data = res.data;
      selected = [...res.data.assignedProgrammeIds];
    } else error = res.error;
  }

  const options = $derived(
    (data?.programmes ?? []).filter((p) => p.status === 'ACTIVE' || data?.assignedProgrammeIds.includes(p.id))
  );

  function toggle(id: string, checked: boolean) {
    selected = checked ? (selected.includes(id) ? selected : [...selected, id]) : selected.filter((x) => x !== id);
  }

  function onOpenChange(next: boolean) {
    if (!next) loadedFor = null;
  }

  async function save() {
    if (!tutorId || !data || busy) return;
    busy = true;
    const res = await apprTutorsApi.setTutorProgrammes(tutorId, selected);
    busy = false;
    if (res.ok) {
      snackbar.success('Apprenticeships updated');
      open = false;
      loadedFor = null;
    } else snackbar.error(res.error);
  }
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Manage apprenticeships</Dialog.Title>
      <Dialog.Description>Choose the apprenticeship programmes {tutorName} teaches.</Dialog.Description>
    </Dialog.Header>

    {#if error}
      <p class="py-6 text-center text-sm text-red-600">{error}</p>
    {:else if !data}
      <p class="ui:text-muted-foreground py-6 text-center text-sm">Loading…</p>
    {:else}
      <p class="ui:text-muted-foreground text-xs">
        The tutor can see and mark every apprentice on a selected programme. Alerts (new evidence, reviews, overdue
        tasks) still go to each apprentice's named tutor, set on the apprentice's portfolio.
      </p>
      {#if options.length === 0}
        <p class="ui:text-muted-foreground text-sm">No apprenticeship programmes yet.</p>
      {:else}
        <div class="max-h-60 divide-y overflow-y-auto rounded-md border">
          {#each options as p (p.id)}
            <label class="hover:bg-muted/50 flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
              <Checkbox
                disabled={busy}
                checked={selected.includes(p.id)}
                onCheckedChange={(v) => toggle(p.id, v === true)}
              />
              <span>{p.title}</span>
              {#if p.status !== 'ACTIVE'}
                <span class="ui:text-muted-foreground ml-auto text-xs">Archived</span>
              {/if}
            </label>
          {/each}
        </div>
      {/if}
    {/if}

    <Dialog.Footer class="mt-4">
      <Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
      <Button onclick={save} loading={busy} disabled={!data}>Save apprenticeships</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
