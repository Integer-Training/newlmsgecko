<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Textarea } from '@cio/ui/base/textarea';
  import FileIcon from '@lucide/svelte/icons/file';
  import XIcon from '@lucide/svelte/icons/x';
  import {
    APPR_RESOURCE_DESCRIPTION_MAX,
    APPR_RESOURCE_TITLE_MAX,
    isAllowedApprResourceFile,
    type ApprResourceKind
  } from '@cio/utils/constants/apprenticeship';
  import { snackbar } from '$features/ui/snackbar/store';
  import { programmesApi } from '../../../api/programmes.svelte';
  import { evidenceApi } from '../../../api/evidence.svelte';
  import { resourcesAdminApi, type ResourceItem } from '../../../api/resources-admin.svelte';
  import CriteriaPicker from '../../evidence/criteria-picker.svelte';
  import { fmtBytes } from '../../shared/format';
  import FileDrop from './file-drop.svelte';
  import KindPicker from './kind-picker.svelte';
  import { pickerTreeOf, titleFromFile, unitOptions } from './unit-options';

  // Add one resource (pick a file, then save: presign → PUT → create → notify) or edit an existing one's details. A
  // workbook also carries the evidence type and the suggested criteria (non-binding: pre-ticked for the learner,
  // still editable by them).
  interface Props {
    open: boolean;
    programmeId: string;
    /** Set when editing. */
    resource?: ResourceItem | null;
    /** Unit pre-selected for a new resource (null = General). */
    unitId?: string | null;
  }
  let { open = $bindable(), programmeId, resource = null, unitId = null }: Props = $props();

  let kind = $state<ApprResourceKind>('LEARNING');
  let file = $state<File | null>(null);
  let title = $state('');
  let titleTouched = $state(false);
  let description = $state('');
  let unit = $state('');
  let typeKey = $state('');
  let criterionIds = $state<string[]>([]);
  let saving = $state(false);
  let progress = $state(0);
  let error = $state<string | null>(null);

  const tree = $derived(programmesApi.tree?.id === programmeId ? programmesApi.tree : null);
  const units = $derived(unitOptions(tree));
  const pickerTree = $derived(pickerTreeOf(tree));
  const activeTypes = $derived(evidenceApi.types.filter((t) => t.active || t.key === typeKey));
  const editing = $derived(!!resource);
  // Editing: the kind can only change when the stored file is allowed under the other kind too.
  const canSwitchKind = $derived(
    !resource || isAllowedApprResourceFile(resource.kind === 'LEARNING' ? 'WORKBOOK' : 'LEARNING', resource.file.name)
  );
  const kindFileError = $derived(
    resource && !isAllowedApprResourceFile(kind, resource.file.name)
      ? `${resource.file.name} cannot be a ${kind === 'LEARNING' ? 'learning resource' : 'workbook'}. Replace the file instead.`
      : null
  );
  const canSave = $derived(!!title.trim() && (editing || !!file) && !saving && !kindFileError);

  onMount(() => {
    evidenceApi.loadTypes();
  });

  // Seed the form when the dialog opens (not when the parent refreshes the same resource).
  $effect(() => {
    if (!open) return;
    void (resource?.id ?? null);
    untrack(() => {
      kind = resource?.kind ?? 'LEARNING';
      file = null;
      title = resource?.title ?? '';
      titleTouched = !!resource;
      description = resource?.description ?? '';
      unit = resource ? (resource.unitId ?? '') : (unitId ?? '');
      typeKey = resource?.evidenceTypeKey ?? '';
      criterionIds = resource ? [...resource.criterionIds] : [];
      saving = false;
      progress = 0;
      error = null;
    });
  });

  function pick(files: File[]) {
    const f = files[0];
    if (!f) return;
    const problem = resourcesAdminApi.validateFile(kind, f);
    if (problem) {
      error = problem;
      return;
    }
    error = null;
    file = f;
    if (!titleTouched) title = titleFromFile(f.name).slice(0, APPR_RESOURCE_TITLE_MAX);
  }

  // Switching kind drops a chosen file the new kind would not accept (and says why).
  $effect(() => {
    const k = kind;
    untrack(() => {
      if (!file) return;
      const problem = resourcesAdminApi.validateFile(k, file);
      if (problem) {
        error = problem;
        file = null;
      }
    });
  });

  async function save(e: Event) {
    e.preventDefault();
    if (!canSave) return;
    saving = true;
    error = null;
    const body = {
      title: title.trim(),
      description: description.trim(),
      unitId: unit || null,
      kind,
      evidenceTypeKey: kind === 'WORKBOOK' ? typeKey || null : null,
      criterionIds: kind === 'WORKBOOK' ? criterionIds : []
    };
    if (resource) {
      const res = await resourcesAdminApi.update(resource.id, body);
      saving = false;
      if (!res.ok) {
        error = res.error;
        return;
      }
      snackbar.success('Resource saved');
      open = false;
      return;
    }
    const uploaded = await resourcesAdminApi.uploadFile(programmeId, kind, file!, {
      onProgress: (p) => (progress = p)
    });
    if (!uploaded.ok) {
      saving = false;
      error = uploaded.error;
      return;
    }
    const created = await resourcesAdminApi.create(programmeId, uploaded.data, body);
    if (!created.ok) {
      saving = false;
      error = created.error;
      return;
    }
    await resourcesAdminApi.refresh();
    await resourcesAdminApi.notify([uploaded.data.resourceId]);
    saving = false;
    snackbar.success('Resource added — learners have been notified');
    open = false;
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>{editing ? 'Edit resource' : 'Add resource'}</Dialog.Title>
      <Dialog.Description>
        {editing
          ? 'Change the details. To change the file itself use “Replace file” so learners see an Updated badge.'
          : 'Upload a file for learners on this programme. Learners are notified once it is saved.'}
      </Dialog.Description>
    </Dialog.Header>

    <form onsubmit={save} class="space-y-4">
      <KindPicker bind:value={kind} idPrefix="rd-kind" disabled={saving || !canSwitchKind} />
      {#if editing && !canSwitchKind}
        <p class="text-xs text-(--muted-foreground)">This file type is only valid for its current kind.</p>
      {/if}
      {#if kindFileError}
        <p role="alert" class="text-xs text-rose-600">{kindFileError}</p>
      {/if}

      {#if !editing}
        <div class="space-y-1">
          <p class="text-sm font-medium">File <span class="text-red-500">*</span></p>
          {#if file}
            <div class="flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-sm">
              <span class="inline-flex min-w-0 items-center gap-1.5">
                <FileIcon size={14} class="shrink-0" />
                <span class="truncate">{file.name}</span>
                <span class="shrink-0 text-xs text-(--muted-foreground)">{fmtBytes(file.size)}</span>
              </span>
              <button
                type="button"
                class="text-(--muted-foreground) hover:text-(--foreground)"
                aria-label="Remove {file.name}"
                disabled={saving}
                onclick={() => (file = null)}
              >
                <XIcon size={14} />
              </button>
            </div>
          {:else}
            <FileDrop {kind} disabled={saving} onfiles={pick} />
          {/if}
        </div>
      {:else if resource}
        <p class="text-sm text-(--muted-foreground)">
          File: <span class="text-(--foreground)">{resource.file.name}</span> · {fmtBytes(resource.file.size)} · v{resource.version}
        </p>
      {/if}

      <div class="space-y-1">
        <div class="flex items-baseline justify-between">
          <label for="rd-title" class="text-sm font-medium">Title <span class="text-red-500">*</span></label>
          <span class="text-xs text-(--muted-foreground)" aria-live="polite"
            >{title.length}/{APPR_RESOURCE_TITLE_MAX}</span
          >
        </div>
        <Input
          id="rd-title"
          bind:value={title}
          maxlength={APPR_RESOURCE_TITLE_MAX}
          required
          oninput={() => (titleTouched = true)}
        />
      </div>

      <div class="space-y-1">
        <label for="rd-desc" class="text-sm font-medium">Description</label>
        <Textarea
          id="rd-desc"
          class="min-h-[72px]!"
          bind:value={description}
          maxlength={APPR_RESOURCE_DESCRIPTION_MAX}
        />
      </div>

      <div class="space-y-1">
        <label for="rd-unit" class="text-sm font-medium">Unit</label>
        <select
          id="rd-unit"
          bind:value={unit}
          class="border-input bg-background w-full rounded-md border px-2 py-2 text-sm"
        >
          <option value="">General (whole programme)</option>
          {#each units as u (u.id)}<option value={u.id}>{u.label}</option>{/each}
        </select>
      </div>

      {#if kind === 'WORKBOOK'}
        <div class="space-y-3 rounded-md border bg-(--muted)/20 p-3">
          <div class="space-y-1">
            <label for="rd-type" class="text-sm font-medium">Evidence type for the completed copy</label>
            <select
              id="rd-type"
              bind:value={typeKey}
              class="border-input bg-background w-full rounded-md border px-2 py-2 text-sm"
            >
              <option value="">Learner chooses</option>
              {#each activeTypes as t (t.key)}<option value={t.key}>{t.label}</option>{/each}
            </select>
          </div>
          <div class="space-y-1">
            <p class="text-sm font-medium">Suggested criteria</p>
            <p class="text-xs text-(--muted-foreground)">
              Pre-ticked when the learner uploads their completed workbook; they can still change them. Any unit of this
              programme.
            </p>
            {#if pickerTree.length === 0}
              <p class="text-sm text-(--muted-foreground)">This programme has no criteria yet.</p>
            {:else}
              <CriteriaPicker
                tree={pickerTree}
                bind:selected={criterionIds}
                idPrefix="res-crit"
                disabled={saving}
                pairPrompt={false}
              />
            {/if}
          </div>
        </div>
      {/if}

      {#if saving && !editing}
        <div
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin="0"
          aria-valuemax="100"
          aria-label="Upload progress"
          class="h-2 overflow-hidden rounded-full bg-(--muted)"
        >
          <div class="h-full bg-(--primary) transition-all" style="width: {progress}%"></div>
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

      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (open = false)} disabled={saving}>Cancel</Button>
        <Button type="submit" disabled={!canSave} loading={saving}>{editing ? 'Save changes' : 'Add resource'}</Button>
      </Dialog.Footer>
      {#if !canSave && !saving}
        <p class="text-right text-xs text-(--muted-foreground)">
          {editing ? 'A title is required.' : 'A file and a title are required.'}
        </p>
      {/if}
    </form>
  </Dialog.Content>
</Dialog.Root>
