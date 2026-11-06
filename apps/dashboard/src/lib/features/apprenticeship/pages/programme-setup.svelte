<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import * as Page from '@cio/ui/base/page';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Spinner } from '@cio/ui/base/spinner';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import { currentOrg } from '$lib/utils/store/org';
  import { programmesApi } from '$features/apprenticeship/api/programmes.svelte';
  import ProgrammeHeader from '$features/apprenticeship/components/programme/programme-header.svelte';
  import QualificationSection from '$features/apprenticeship/components/programme/qualification-section.svelte';
  import ImportDialog from '$features/apprenticeship/components/programme/import-dialog.svelte';

  // Programme setup: details + structure editor (qualification -> units -> criteria) + CSV import, on one page.
  const programmeId = $derived(page.params.programmeId ?? '');

  let showImport = $state(false);
  let addingQual = $state(false);
  let qualTitle = $state('');
  let savingQual = $state(false);

  onMount(() => {
    // Drop a previously opened programme so its content never flashes before this one loads.
    programmesApi.tree = null;
  });

  $effect(() => {
    const id = programmeId;
    if (id) programmesApi.loadTree(id);
  });

  const tree = $derived(programmesApi.tree && programmesApi.tree.id === programmeId ? programmesApi.tree : null);

  async function addQualification(e: Event) {
    e.preventDefault();
    if (!qualTitle.trim() || savingQual) return;
    savingQual = true;
    const ok = await programmesApi.createQualification(programmeId, { title: qualTitle.trim() });
    savingQual = false;
    if (ok) {
      qualTitle = '';
      addingQual = false;
    }
  }
</script>

<svelte:head><title>{tree?.title ?? 'Programme'} — Gecko Apprenticeships</title></svelte:head>

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      <Page.Title>{tree?.title ?? 'Programme setup'}</Page.Title>
      <Page.Subtitle>Set up units and criteria · {$currentOrg.name}</Page.Subtitle>
    </Page.HeaderContent>
    <Page.Action>
      <div class="flex items-center gap-2">
        <Button variant="outline" href="/org/{$currentOrg.siteName}/apprenticeships/programmes">
          <ArrowLeftIcon class="size-4" /> All programmes
        </Button>
        <Button onclick={() => (showImport = true)} disabled={!tree}>
          <UploadIcon class="size-4" /> Import
        </Button>
      </div>
    </Page.Action>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      {#if programmesApi.loadError && !tree}
        <div class="flex flex-col items-center gap-3 py-16" role="alert">
          <p class="text-sm text-red-600">{programmesApi.loadError}</p>
          <Button variant="outline" onclick={() => programmesApi.loadTree(programmeId)}>Try again</Button>
        </div>
      {:else if !tree}
        <div class="flex justify-center py-16"><Spinner /></div>
      {:else}
        <div class="flex max-w-5xl flex-col gap-4">
          <ProgrammeHeader programme={tree} />

          {#each tree.qualifications as qualification, i (qualification.id)}
            <QualificationSection
              {programmeId}
              {qualification}
              index={i}
              total={tree.qualifications.length}
              onimport={() => (showImport = true)}
            />
          {/each}

          {#if addingQual}
            <form onsubmit={addQualification} class="bg-card flex flex-wrap items-end gap-2 rounded-xl border p-4">
              <div class="min-w-48 flex-1 space-y-1">
                <label for="nq-title" class="text-sm font-medium">Qualification title</label>
                <Input id="nq-title" bind:value={qualTitle} maxlength={200} required />
              </div>
              <Button type="submit" disabled={!qualTitle.trim()} loading={savingQual}>Add qualification</Button>
              <Button type="button" variant="ghost" onclick={() => (addingQual = false)}>Cancel</Button>
            </form>
          {:else}
            <div>
              <Button variant="ghost" size="sm" onclick={() => (addingQual = true)}>
                <PlusIcon class="size-4" /> Add another qualification
              </Button>
            </div>
          {/if}
        </div>
      {/if}
    {/snippet}
  </Page.Body>
</Page.Root>

{#if tree}
  <ImportDialog bind:open={showImport} programmeId={tree.id} />
{/if}
