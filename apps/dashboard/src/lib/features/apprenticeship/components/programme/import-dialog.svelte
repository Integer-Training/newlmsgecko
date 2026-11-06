<script lang="ts">
  import * as Dialog from '@cio/ui/base/dialog';
  import * as Table from '@cio/ui/base/table';
  import { Button } from '@cio/ui/base/button';
  import { Textarea } from '@cio/ui/base/textarea';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import { snackbar } from '$features/ui/snackbar/store';
  import { programmesApi, type ImportResult } from '$features/apprenticeship/api/programmes.svelte';

  // CSV import of a programme's units + criteria: paste or choose a file -> Preview (counts + row errors) -> Apply.
  // Preview and apply run the same server plan, so what you see is what is written.
  interface Props {
    open: boolean;
    programmeId: string;
  }

  let { open = $bindable(), programmeId }: Props = $props();

  const MAX_BYTES = 2 * 1024 * 1024;
  const COLUMNS = [
    ['qualification', 'Qualification title (optional; blank uses the first one)'],
    ['unit_code', 'Unit code, e.g. K1 (a unit needs a code or a title)'],
    ['unit_title', 'Unit title'],
    ['criterion_code', 'Criterion code, e.g. 1.1 (needed with criterion_text for a new criterion)'],
    ['criterion_text', 'What the learner must show'],
    ['group', 'Heading the criterion sits under, e.g. Knowledge'],
    ['required', 'How many pieces of evidence it needs (default 1)'],
    ['unit_ref / criterion_ref', 'Optional IDs from another system, so re-importing updates instead of duplicating']
  ];

  let csv = $state('');
  let preview = $state<ImportResult | null>(null);
  let busy = $state<'preview' | 'apply' | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);

  const tooBig = $derived(new Blob([csv]).size > MAX_BYTES);

  function reset() {
    csv = '';
    preview = null;
    busy = null;
  }

  async function onFile(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > MAX_BYTES) {
      snackbar.error('That file is larger than 2 MB.');
      return;
    }
    csv = await file.text();
    preview = null;
    if (fileInput) fileInput.value = '';
  }

  async function run(mode: 'preview' | 'apply') {
    if (!csv.trim() || tooBig || busy) return;
    busy = mode;
    const res = await programmesApi.importCsv(programmeId, csv, mode);
    busy = null;
    if (!res) return;
    if (mode === 'preview') {
      preview = res;
      return;
    }
    snackbar.success(
      `Imported: ${res.unitsNew} new and ${res.unitsUpdated} updated units, ${res.criteriaNew} new and ${res.criteriaUpdated} updated criteria`
    );
    open = false;
    reset();
  }

  const nothingToDo = $derived(
    !!preview && preview.unitsNew + preview.unitsUpdated + preview.criteriaNew + preview.criteriaUpdated === 0
  );
</script>

<Dialog.Root bind:open onOpenChange={(next) => !next && reset()}>
  <Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Import from a spreadsheet</Dialog.Title>
      <Dialog.Description>
        Paste CSV text or choose a .csv file (export from Excel or Sheets). Preview first, then apply.
      </Dialog.Description>
    </Dialog.Header>

    <details class="rounded-md border p-3 text-sm">
      <summary class="cursor-pointer font-medium">Column format</summary>
      <p class="text-muted-foreground mt-2">
        First row is the header. One row per criterion, or one row per unit with the criterion columns left blank.
      </p>
      <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {#each COLUMNS as [name, help] (name)}
          <dt class="font-mono text-xs">{name}</dt>
          <dd class="text-muted-foreground text-xs">{help}</dd>
        {/each}
      </dl>
    </details>

    <div class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <label for="imp-csv" class="text-sm font-medium">CSV</label>
        <Button size="sm" variant="outline" onclick={() => fileInput?.click()}>
          <UploadIcon class="size-4" /> Choose file
        </Button>
        <input
          bind:this={fileInput}
          type="file"
          accept=".csv,text/csv"
          class="sr-only"
          tabindex="-1"
          aria-label="Choose a CSV file"
          onchange={onFile}
        />
      </div>
      <Textarea
        id="imp-csv"
        bind:value={csv}
        rows={8}
        class="font-mono text-xs"
        placeholder="unit_code,unit_title,criterion_code,criterion_text,group,required"
        oninput={() => (preview = null)}
      />
      {#if tooBig}<p class="text-xs text-red-600" role="alert">This is larger than 2 MB.</p>{/if}
    </div>

    {#if preview}
      <div class="rounded-md border p-3" aria-live="polite">
        <p class="text-sm font-medium">Preview</p>
        <ul class="mt-1 grid grid-cols-2 gap-1 text-sm">
          <li>Units to add: <strong>{preview.unitsNew}</strong></li>
          <li>Units to update: <strong>{preview.unitsUpdated}</strong></li>
          <li>Criteria to add: <strong>{preview.criteriaNew}</strong></li>
          <li>Criteria to update: <strong>{preview.criteriaUpdated}</strong></li>
        </ul>
        {#if preview.errors.length > 0}
          <p class="mt-3 text-sm font-medium text-amber-700 dark:text-amber-400">
            {preview.errors.length} row{preview.errors.length === 1 ? '' : 's'} will be skipped
          </p>
          <div class="mt-1 max-h-40 overflow-y-auto rounded border">
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.Head class="w-16">Row</Table.Head>
                  <Table.Head>Problem</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each preview.errors as err, i (err.row + ':' + i)}
                  <Table.Row>
                    <Table.Cell class="tabular-nums">{err.row}</Table.Cell>
                    <Table.Cell class="text-sm">{err.message}</Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
          </div>
        {/if}
      </div>
    {/if}

    <Dialog.Footer>
      <Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
      <Button
        variant="outline"
        onclick={() => run('preview')}
        disabled={!csv.trim() || tooBig || busy !== null}
        loading={busy === 'preview'}
      >
        Preview
      </Button>
      <Button
        onclick={() => run('apply')}
        disabled={!preview || nothingToDo || busy !== null}
        loading={busy === 'apply'}
      >
        Apply import
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
