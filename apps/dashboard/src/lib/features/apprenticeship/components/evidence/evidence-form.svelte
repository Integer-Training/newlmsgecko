<script lang="ts">
  import { isOrgTeamMember } from '$lib/utils/store/org';
  import { onMount } from 'svelte';
  import { Button } from '@cio/ui/base/button';
  import { Checkbox } from '@cio/ui/base/checkbox';
  import { Input } from '@cio/ui/base/input';
  import { Switch } from '@cio/ui/base/switch';
  import { Textarea } from '@cio/ui/base/textarea';
  import * as Select from '@cio/ui/base/select';
  import FileIcon from '@lucide/svelte/icons/file';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import XIcon from '@lucide/svelte/icons/x';
  import {
    APPR_EVIDENCE_DETAILS_MAX,
    APPR_EVIDENCE_TITLE_MAX,
    APPR_NOTE_MAX
  } from '@cio/utils/constants/apprenticeship';
  import { snackbar } from '$features/ui/snackbar/store';
  import {
    evidenceApi,
    type EvidenceDetail,
    type EvidenceFile,
    type PickerQualification
  } from '../../api/evidence.svelte';
  import CriteriaPicker from './criteria-picker.svelte';
  import { fmtBytes } from '../shared/format';

  // Add / edit one piece of evidence. Files upload as soon as they are chosen (presign → PUT) and are attached on
  // save. Staff can pick the starting status (Submitted / Accepted) when adding. Buttons disable while saving and the
  // API's message is shown inline.

  interface Props {
    /** Set when editing an existing piece. */
    initial?: EvidenceDetail | null;
    enrolmentId: string | null;
    tree: PickerQualification[];
    metIds?: Set<string> | null;
    preCriteria?: string[];
    onSaved: () => void;
    onCancel: () => void;
  }
  let { initial = null, enrolmentId, tree, metIds = null, preCriteria = [], onSaved, onCancel }: Props = $props();

  const ev = initial?.evidence;
  let title = $state(ev?.title ?? '');
  let details = $state(ev?.details ?? '');
  let hours = $state(ev ? String(Math.floor(ev.minutes / 60)) : '0');
  let mins = $state(ev ? String(ev.minutes % 60) : '0');
  let includeOtj = $state(ev?.includeOtj ?? false);
  let typeKey = $state(ev?.typeKey ?? '');
  let criterionIds = $state<string[]>(
    initial ? initial.criteria.flatMap((q) => q.units.flatMap((u) => u.criteria.map((c) => c.id))) : [...preCriteria]
  );
  let files = $state<EvidenceFile[]>(ev?.files ? [...ev.files] : []);
  let status = $state<'SUBMITTED' | 'ACCEPTED'>('SUBMITTED');
  let note = $state('');
  let auditNote = $state(false);
  let saving = $state(false);
  let uploading = $state(false);
  let error = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  // The id files are presigned for: the existing id when editing, else the first presign's server-issued id.
  let uploadEvidenceId = $state<string | undefined>(ev?.id);

  onMount(() => {
    evidenceApi.loadTypes();
  });

  const activeTypes = $derived(evidenceApi.types.filter((t) => t.active || t.key === typeKey));
  const minutes = $derived(
    Math.max(0, Math.floor(Number(hours) || 0)) * 60 + Math.max(0, Math.floor(Number(mins) || 0))
  );
  const canSave = $derived(!!title.trim() && !!typeKey && criterionIds.length > 0 && !saving && !uploading);

  async function onFilesPicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const picked = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (picked.length === 0 || !enrolmentId) return;
    uploading = true;
    error = null;
    const res = await evidenceApi.upload(enrolmentId, picked, uploadEvidenceId);
    uploading = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    uploadEvidenceId = res.data.evidenceId;
    files = [...files, ...res.data.files];
  }

  function removeFile(key: string) {
    files = files.filter((f) => f.key !== key);
  }

  async function save() {
    if (!canSave) return;
    saving = true;
    error = null;
    const fileBody = files.map((f) => ({ key: f.key, name: f.name, size: f.size, type: f.type }));
    const noteBody = note.trim()
      ? { body: note.trim(), kind: auditNote ? ('AUDIT' as const) : ('GENERAL' as const) }
      : undefined;
    const fields = {
      title: title.trim(),
      details: details.trim(),
      typeKey,
      minutes,
      includeOtj,
      criterionIds,
      files: fileBody
    };
    const res =
      initial && ev
        ? await evidenceApi.update(ev.id, { ...fields, ...(noteBody ? { note: noteBody } : {}) })
        : enrolmentId
          ? await evidenceApi.create(enrolmentId, {
              ...fields,
              status,
              ...(uploadEvidenceId && files.length > 0 ? { evidenceId: uploadEvidenceId } : {}),
              ...(noteBody ? { note: noteBody } : {})
            })
          : null;
    saving = false;
    if (!res) {
      error = 'No learner is selected for this evidence.';
      return;
    }
    if (!res.ok) {
      error = res.error;
      return;
    }
    snackbar.success(initial ? 'Evidence updated' : 'Evidence added');
    onSaved();
  }
</script>

<form
  class="space-y-5 px-4 pb-6"
  onsubmit={(e) => {
    e.preventDefault();
    save();
  }}
>
  <div class="space-y-1">
    <div class="flex items-baseline justify-between">
      <label for="ev-title" class="text-sm font-medium">Title <span class="text-red-500">*</span></label>
      <span class="text-xs text-(--muted-foreground)" aria-live="polite">{title.length}/{APPR_EVIDENCE_TITLE_MAX}</span>
    </div>
    <Input id="ev-title" bind:value={title} maxlength={APPR_EVIDENCE_TITLE_MAX} required />
  </div>

  <div class="space-y-1">
    <label for="ev-details" class="text-sm font-medium">Details</label>
    <Textarea id="ev-details" class="min-h-[96px]!" bind:value={details} maxlength={APPR_EVIDENCE_DETAILS_MAX} />
  </div>

  <div class="grid grid-cols-2 items-end gap-3 sm:grid-cols-4">
    <div class="space-y-1">
      <label for="ev-hours" class="text-sm font-medium">Time (hours)</label>
      <Input id="ev-hours" type="number" min="0" max="1600" bind:value={hours} />
    </div>
    <div class="space-y-1">
      <label for="ev-mins" class="text-sm font-medium">Minutes</label>
      <Input id="ev-mins" type="number" min="0" max="59" bind:value={mins} />
    </div>
    <label class="col-span-2 flex items-center gap-2 pb-2 text-sm">
      <Switch bind:checked={includeOtj} aria-label="Include in off-the-job hours" />
      Include in off-the-job hours
    </label>
  </div>

  <fieldset class="space-y-2">
    <legend class="text-sm font-medium">Type <span class="text-red-500">*</span></legend>
    <div class="flex flex-wrap gap-1.5">
      {#each activeTypes as t (t.key)}
        <button
          type="button"
          aria-pressed={typeKey === t.key}
          class="rounded-full border px-2.5 py-1 text-xs transition-colors {typeKey === t.key
            ? 'border-(--primary) bg-(--primary) text-(--primary-foreground)'
            : 'hover:bg-(--muted)'}"
          onclick={() => (typeKey = t.key)}
        >
          {t.label}
        </button>
      {/each}
      {#if activeTypes.length === 0}
        <p class="text-sm text-(--muted-foreground)">Loading types…</p>
      {/if}
    </div>
  </fieldset>

  <div class="space-y-1">
    <p class="text-sm font-medium">Criteria <span class="text-red-500">*</span></p>
    <CriteriaPicker {tree} bind:selected={criterionIds} {metIds} idPrefix="form-crit" />
  </div>

  <div class="space-y-2">
    <p class="text-sm font-medium">Files</p>
    <input
      bind:this={fileInput}
      type="file"
      multiple
      class="hidden"
      aria-label="Choose evidence files"
      onchange={onFilesPicked}
    />
    <Button
      type="button"
      variant="outline"
      size="sm"
      loading={uploading}
      disabled={!enrolmentId || uploading || saving}
      onclick={() => fileInput?.click()}
    >
      <UploadIcon size={16} class="mr-1" /> Add files
    </Button>
    {#if !enrolmentId}
      <p class="text-xs text-(--muted-foreground)">Open this learner's portfolio to add more files.</p>
    {/if}
    {#if files.length > 0}
      <ul class="space-y-1">
        {#each files as f (f.key)}
          <li class="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm">
            <span class="inline-flex min-w-0 items-center gap-1.5">
              <FileIcon size={14} class="shrink-0" />
              <span class="truncate">{f.name}</span>
              <span class="shrink-0 text-xs text-(--muted-foreground)">{fmtBytes(f.size)}</span>
            </span>
            <button
              type="button"
              class="text-(--muted-foreground) hover:text-(--foreground)"
              aria-label="Remove {f.name}"
              onclick={() => removeFile(f.key)}
            >
              <XIcon size={14} />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <!-- Staff only: an apprentice's own evidence is always Submitted (the API forces it too). -->
  {#if !initial && $isOrgTeamMember}
    <div class="space-y-1">
      <label for="ev-status" class="text-sm font-medium">Status</label>
      <Select.Root type="single" bind:value={status}>
        <Select.Trigger id="ev-status" class="ui:w-48"
          >{status === 'ACCEPTED' ? 'Accepted' : 'Submitted'}</Select.Trigger
        >
        <Select.Content>
          <Select.Item value="SUBMITTED">Submitted</Select.Item>
          <Select.Item value="ACCEPTED">Accepted</Select.Item>
        </Select.Content>
      </Select.Root>
      <p class="text-xs text-(--muted-foreground)">Accepted evidence counts towards progress straight away.</p>
    </div>
  {/if}

  <div class="space-y-1">
    <label for="ev-note" class="text-sm font-medium">Note (optional)</label>
    <Textarea id="ev-note" class="min-h-[64px]!" bind:value={note} maxlength={APPR_NOTE_MAX} />
    <label class="flex items-center gap-2 text-sm">
      <Checkbox bind:checked={auditNote} />
      Audit note
    </label>
  </div>

  {#if error}
    <p
      role="alert"
      class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
    >
      {error}
    </p>
  {/if}

  <div class="flex justify-end gap-2">
    <Button type="button" variant="outline" onclick={onCancel} disabled={saving}>Cancel</Button>
    <Button type="submit" loading={saving} disabled={!canSave}>{initial ? 'Save changes' : 'Add evidence'}</Button>
  </div>
  {#if !canSave && !saving}
    <p class="text-right text-xs text-(--muted-foreground)">A title, a type and at least one criterion are required.</p>
  {/if}
</form>
