<script lang="ts">
  import { Badge } from '@cio/ui/base/badge';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Textarea } from '@cio/ui/base/textarea';
  import ArchiveIcon from '@lucide/svelte/icons/archive';
  import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
  import { snackbar } from '$features/ui/snackbar/store';
  import { programmesApi, type ProgrammeTree } from '$features/apprenticeship/api/programmes.svelte';

  // Programme details, edited in place: title / reference / level / description save together; status toggles
  // between ACTIVE and ARCHIVED.
  interface Props {
    programme: ProgrammeTree;
  }

  let { programme }: Props = $props();

  let title = $state('');
  let reference = $state('');
  let awardingBody = $state('');
  let level = $state('');
  let description = $state('');
  let saving = $state(false);
  let toggling = $state(false);

  // Re-seed the form when the server copy actually changes (not on every structure reload, which would wipe
  // unsaved typing).
  let seeded = '';
  $effect(() => {
    const key = JSON.stringify([
      programme.id,
      programme.title,
      programme.reference,
      programme.awardingBody,
      programme.level,
      programme.description
    ]);
    if (key === seeded) return;
    seeded = key;
    title = programme.title;
    reference = programme.reference ?? '';
    awardingBody = programme.awardingBody ?? '';
    level = programme.level ?? '';
    description = programme.description ?? '';
  });

  const dirty = $derived(
    title.trim() !== programme.title ||
      reference.trim() !== (programme.reference ?? '') ||
      awardingBody.trim() !== (programme.awardingBody ?? '') ||
      level.trim() !== (programme.level ?? '') ||
      description.trim() !== (programme.description ?? '')
  );

  async function save(e: Event) {
    e.preventDefault();
    if (!title.trim() || !dirty || saving) return;
    saving = true;
    const ok = await programmesApi.updateProgramme(programme.id, {
      title: title.trim(),
      reference: reference.trim() || null,
      awardingBody: awardingBody.trim() || null,
      level: level.trim() || null,
      description: description.trim() || null
    });
    saving = false;
    if (ok) snackbar.success('Programme saved');
  }

  async function toggleStatus() {
    toggling = true;
    await programmesApi.updateProgramme(programme.id, {
      status: programme.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE'
    });
    toggling = false;
  }
</script>

<form onsubmit={save} class="flex flex-col gap-3 rounded-xl border bg-(--card) p-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div class="flex items-center gap-2">
      <h2 class="text-lg font-semibold tracking-tight">Programme details</h2>
      <Badge variant={programme.status === 'ACTIVE' ? 'success' : 'secondary'}>
        {programme.status === 'ACTIVE' ? 'Active' : 'Archived'}
      </Badge>
    </div>
    <Button type="button" variant="outline" size="sm" onclick={toggleStatus} loading={toggling}>
      {#if programme.status === 'ACTIVE'}
        <ArchiveIcon class="size-4" /> Archive
      {:else}
        <ArchiveRestoreIcon class="size-4" /> Restore
      {/if}
    </Button>
  </div>

  <div class="grid grid-cols-1 gap-3 md:grid-cols-[1fr_10rem_10rem_6rem]">
    <div class="space-y-1">
      <label for="pd-title" class="text-sm font-medium">Title <span class="text-red-500">*</span></label>
      <Input id="pd-title" bind:value={title} maxlength={200} required />
    </div>
    <div class="space-y-1">
      <label for="pd-ref" class="text-sm font-medium">Reference</label>
      <Input id="pd-ref" bind:value={reference} maxlength={100} />
    </div>
    <div class="space-y-1">
      <label for="pd-body" class="text-sm font-medium">Awarding body</label>
      <Input id="pd-body" bind:value={awardingBody} maxlength={200} placeholder="NCFE" />
    </div>
    <div class="space-y-1">
      <label for="pd-level" class="text-sm font-medium">Level</label>
      <Input id="pd-level" bind:value={level} maxlength={50} />
    </div>
  </div>
  <div class="space-y-1">
    <label for="pd-desc" class="text-sm font-medium">Description</label>
    <Textarea id="pd-desc" bind:value={description} rows={2} maxlength={5000} />
  </div>
  <div>
    <Button type="submit" disabled={!dirty || !title.trim()} loading={saving}>Save details</Button>
  </div>
</form>
