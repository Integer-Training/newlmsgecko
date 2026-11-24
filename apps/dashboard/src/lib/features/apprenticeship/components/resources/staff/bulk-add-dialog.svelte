<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import FileIcon from '@lucide/svelte/icons/file';
  import XIcon from '@lucide/svelte/icons/x';
  import CheckIcon from '@lucide/svelte/icons/check';
  import { APPR_RESOURCE_TITLE_MAX, type ApprResourceKind } from '@cio/utils/constants/apprenticeship';
  import { snackbar } from '$features/ui/snackbar/store';
  import { programmesApi } from '../../../api/programmes.svelte';
  import { evidenceApi } from '../../../api/evidence.svelte';
  import { resourcesAdminApi } from '../../../api/resources-admin.svelte';
  import { fmtBytes } from '../../shared/format';
  import FileDrop from './file-drop.svelte';
  import KindPicker from './kind-picker.svelte';
  import { titleFromFile, unitOptions } from './unit-options';

  // Bulk add: several files at once, one resource per file (title from the file name, editable), one common kind and
  // unit. Workbooks can be given suggested criteria afterwards with Edit. Learners get ONE notification for the batch.
  interface Props {
    open: boolean;
    programmeId: string;
    unitId?: string | null;
  }
  let { open = $bindable(), programmeId, unitId = null }: Props = $props();

  interface Row {
    key: number;
    file: File;
    title: string;
    state: 'ready' | 'uploading' | 'done' | 'failed';
    error?: string;
  }

  let kind = $state<ApprResourceKind>('LEARNING');
  let unit = $state('');
  let typeKey = $state('');
  let rows = $state<Row[]>([]);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let counter = 0;

  const tree = $derived(programmesApi.tree?.id === programmeId ? programmesApi.tree : null);
  const units = $derived(unitOptions(tree));
  const activeTypes = $derived(evidenceApi.types.filter((t) => t.active));
  const pending = $derived(rows.filter((r) => r.state === 'ready' || r.state === 'failed'));
  const canSave = $derived(!saving && pending.length > 0 && pending.every((r) => r.title.trim()));

  onMount(() => {
    evidenceApi.loadTypes();
  });

  $effect(() => {
    if (!open) return;
    untrack(() => {
      kind = 'LEARNING';
      unit = unitId ?? '';
      typeKey = '';
      rows = [];
      saving = false;
      error = null;
    });
  });

  function add(files: File[]) {
    const problems: string[] = [];
    for (const f of files) {
      const p = resourcesAdminApi.validateFile(kind, f);
      if (p) problems.push(p);
      else
        rows.push({
          key: ++counter,
          file: f,
          title: titleFromFile(f.name).slice(0, APPR_RESOURCE_TITLE_MAX),
          state: 'ready'
        });
    }
    error = problems.length ? problems.join(' ') : null;
  }

  // Changing kind drops queued files the new kind rejects.
  $effect(() => {
    const k = kind;
    untrack(() => {
      const bad = rows.filter((r) => r.state !== 'done' && resourcesAdminApi.validateFile(k, r.file));
      if (bad.length === 0) return;
      rows = rows.filter((r) => !bad.includes(r));
      error = `Removed ${bad.length} file${bad.length === 1 ? '' : 's'} that ${bad.length === 1 ? "isn't" : "aren't"} allowed as this type: ${bad.map((b) => b.file.name).join(', ')}.`;
    });
  });

  async function save(e: Event) {
    e.preventDefault();
    if (!canSave) return;
    saving = true;
    error = null;
    const createdIds: string[] = [];
    for (const row of rows) {
      if (row.state === 'done') continue;
      row.state = 'uploading';
      row.error = undefined;
      const up = await resourcesAdminApi.uploadFile(programmeId, kind, row.file);
      if (!up.ok) {
        row.state = 'failed';
        row.error = up.error;
        continue;
      }
      const res = await resourcesAdminApi.create(programmeId, up.data, {
        title: row.title.trim(),
        unitId: unit || null,
        kind,
        evidenceTypeKey: kind === 'WORKBOOK' ? typeKey || null : null,
        criterionIds: []
      });
      if (!res.ok) {
        row.state = 'failed';
        row.error = res.error;
        continue;
      }
      row.state = 'done';
      createdIds.push(up.data.resourceId);
    }
    if (createdIds.length > 0) {
      await resourcesAdminApi.refresh();
      await resourcesAdminApi.notify(createdIds);
    }
    saving = false;
    const failed = rows.filter((r) => r.state === 'failed').length;
    if (failed === 0) {
      snackbar.success(
        `${createdIds.length} resource${createdIds.length === 1 ? '' : 's'} added — learners notified once`
      );
      open = false;
    } else {
      error = `${createdIds.length} added, ${failed} failed. Fix or remove the failed files and save again.`;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Add several resources</Dialog.Title>
      <Dialog.Description>
        One resource is created per file, all with the same type and unit. Learners get a single notification.
      </Dialog.Description>
    </Dialog.Header>

    <form onsubmit={save} class="space-y-4">
      <KindPicker bind:value={kind} idPrefix="bd-kind" disabled={saving} />

      <div class="grid gap-3 sm:grid-cols-2">
        <div class="space-y-1">
          <label for="bd-unit" class="text-sm font-medium">Unit</label>
          <select
            id="bd-unit"
            bind:value={unit}
            disabled={saving}
            class="border-input bg-background w-full rounded-md border px-2 py-2 text-sm"
          >
            <option value="">General (whole programme)</option>
            {#each units as u (u.id)}<option value={u.id}>{u.label}</option>{/each}
          </select>
        </div>
        {#if kind === 'WORKBOOK'}
          <div class="space-y-1">
            <label for="bd-type" class="text-sm font-medium">Evidence type</label>
            <select
              id="bd-type"
              bind:value={typeKey}
              disabled={saving}
              class="border-input bg-background w-full rounded-md border px-2 py-2 text-sm"
            >
              <option value="">Learner chooses</option>
              {#each activeTypes as t (t.key)}<option value={t.key}>{t.label}</option>{/each}
            </select>
          </div>
        {/if}
      </div>

      <FileDrop {kind} multiple disabled={saving} onfiles={add} />

      {#if rows.length > 0}
        <ul class="space-y-2" aria-label="Files to add">
          {#each rows as row (row.key)}
            <li class="space-y-1 rounded-md border p-2">
              <div class="flex items-center gap-2">
                <FileIcon size={14} class="shrink-0" />
                <span class="min-w-0 flex-1 truncate text-sm">{row.file.name}</span>
                <span class="shrink-0 text-xs text-(--muted-foreground)">{fmtBytes(row.file.size)}</span>
                {#if row.state === 'done'}
                  <CheckIcon size={16} class="shrink-0 text-emerald-600" aria-label="Added" />
                {:else if row.state === 'uploading'}
                  <span class="shrink-0 text-xs text-(--muted-foreground)">Uploading…</span>
                {:else}
                  <button
                    type="button"
                    class="text-(--muted-foreground) hover:text-(--foreground)"
                    aria-label="Remove {row.file.name}"
                    disabled={saving}
                    onclick={() => (rows = rows.filter((r) => r.key !== row.key))}
                  >
                    <XIcon size={14} />
                  </button>
                {/if}
              </div>
              {#if row.state !== 'done'}
                <Input
                  aria-label="Title for {row.file.name}"
                  bind:value={row.title}
                  maxlength={APPR_RESOURCE_TITLE_MAX}
                  disabled={saving}
                  class="h-8"
                />
              {/if}
              {#if row.error}<p role="alert" class="text-xs text-rose-600">{row.error}</p>{/if}
            </li>
          {/each}
        </ul>
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
        <Button type="button" variant="outline" onclick={() => (open = false)} disabled={saving}>
          {rows.some((r) => r.state === 'done') ? 'Close' : 'Cancel'}
        </Button>
        <Button type="submit" disabled={!canSave} loading={saving}>
          Add {pending.length || ''} resource{pending.length === 1 ? '' : 's'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
