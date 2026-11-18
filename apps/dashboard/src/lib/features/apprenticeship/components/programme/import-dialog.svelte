<script lang="ts">
  import * as Dialog from '@cio/ui/base/dialog';
  import * as Table from '@cio/ui/base/table';
  import { Button } from '@cio/ui/base/button';
  import { Textarea } from '@cio/ui/base/textarea';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import { snackbar } from '$features/ui/snackbar/store';
  import { programmesApi, type ImportResult } from '$features/apprenticeship/api/programmes.svelte';
  import {
    downloadTemplate,
    isLegacyXlsFile,
    isXlsxFile,
    xlsxFileToCsv
  } from '$features/apprenticeship/utils/spreadsheet';

  // Import of a programme's units + criteria: paste CSV or choose a .csv / .xlsx file -> Preview (unit table, row
  // errors, warnings) -> Apply. An .xlsx is converted to CSV in the browser (first sheet); the server only reads CSV.
  // Preview and apply run the same server plan, so what you see is what is written.
  interface Props {
    open: boolean;
    programmeId: string;
    /** The programme's type: its own template is offered first and highlighted. */
    type?: 'DIPLOMA' | 'STANDARD';
  }

  let { open = $bindable(), programmeId, type = 'DIPLOMA' }: Props = $props();

  // The API client type may not list the newer fields yet; read them defensively.
  type UnitRow = {
    title: string;
    code: string | null;
    state: 'NEW' | 'UPDATED' | 'UNCHANGED';
    criteriaNew: number;
    criteriaUpdated: number;
  };
  type Preview = ImportResult & { warnings?: { row: number; message: string }[]; units?: UnitRow[] };

  const MAX_BYTES = 2 * 1024 * 1024;
  const COLUMNS = [
    ['qualification', 'Qualification title (optional; blank uses the first one)'],
    ['unit_code', 'Unit code, e.g. K1 (a unit needs a code or a title; a Standard often has no code)'],
    ['unit_title', 'Unit title'],
    ['criterion_code', 'Criterion code, e.g. 1.1 (needed with criterion_text for a new criterion)'],
    ['criterion_text', 'What the learner must show'],
    ['group', 'Heading the criterion sits under, e.g. Knowledge, Skills, Behaviours'],
    ['required', 'How many pieces of evidence it needs (default 1)'],
    ['glh', 'Optional guided learning hours for the unit, a whole number 0–2000'],
    ['unit_ref / criterion_ref', 'Optional IDs from another system, so re-importing updates instead of duplicating']
  ];
  const STATE_LABEL: Record<UnitRow['state'], string> = {
    NEW: 'New',
    UPDATED: 'Updated',
    UNCHANGED: 'No change'
  };

  let csv = $state('');
  let preview = $state<Preview | null>(null);
  let busy = $state<'preview' | 'apply' | 'file' | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);

  const templateKinds = $derived<('diploma' | 'standard')[]>(
    type === 'STANDARD' ? ['standard', 'diploma'] : ['diploma', 'standard']
  );
  const tooBig = $derived(new Blob([csv]).size > MAX_BYTES);
  const warnings = $derived(preview?.warnings ?? []);
  const unitRows = $derived(preview?.units ?? []);

  function reset() {
    csv = '';
    preview = null;
    busy = null;
  }

  async function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (isLegacyXlsFile(file)) {
        snackbar.error('Old .xls files are not supported. Save the sheet as .xlsx or .csv and try again.');
        return;
      }
      if (file.size > MAX_BYTES) {
        snackbar.error('That file is larger than 2 MB.');
        return;
      }
      if (isXlsxFile(file)) {
        busy = 'file';
        try {
          csv = await xlsxFileToCsv(file);
        } catch {
          snackbar.error('Could not read that spreadsheet. Check it is a valid .xlsx file.');
          return;
        } finally {
          busy = null;
        }
      } else {
        csv = await file.text();
      }
      preview = null;
    } finally {
      input.value = '';
    }
  }

  async function run(mode: 'preview' | 'apply') {
    if (!csv.trim() || tooBig || busy) return;
    busy = mode;
    const res = (await programmesApi.importCsv(programmeId, csv, mode)) as Preview | undefined;
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
        Paste CSV text or choose a .csv or .xlsx file (the first sheet is used). Preview first, then apply. Import adds
        and updates; it never deletes.
      </Dialog.Description>
    </Dialog.Header>

    <div class="flex flex-wrap items-center gap-2">
      <span class="text-sm font-medium">Template</span>
      {#each templateKinds as kind, i (kind)}
        <Button size="sm" variant={i === 0 ? 'default' : 'outline'} onclick={() => downloadTemplate(kind)}>
          <DownloadIcon class="size-4" />
          {kind === 'standard' ? 'Standard' : 'Diploma'}
        </Button>
      {/each}
    </div>

    <details class="rounded-md border p-3 text-sm">
      <summary class="cursor-pointer font-medium">Column format</summary>
      <p class="mt-2 text-(--muted-foreground)">
        First row is the header. One row per criterion, or one row per unit with the criterion columns left blank. In
        Excel, format criterion codes like 1.10 as Text so the trailing zero is kept.
      </p>
      <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {#each COLUMNS as [name, help] (name)}
          <dt class="font-mono text-xs">{name}</dt>
          <dd class="text-xs text-(--muted-foreground)">{help}</dd>
        {/each}
      </dl>
    </details>

    <div class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <label for="imp-csv" class="text-sm font-medium">CSV</label>
        <Button size="sm" variant="outline" onclick={() => fileInput?.click()} loading={busy === 'file'}>
          <UploadIcon class="size-4" /> Choose file
        </Button>
        <input
          bind:this={fileInput}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          class="sr-only"
          tabindex="-1"
          aria-label="Choose a CSV or XLSX file"
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
      <div class="space-y-3 rounded-md border p-3" aria-live="polite">
        <p class="text-sm font-medium">Preview</p>
        <ul class="grid grid-cols-2 gap-1 text-sm">
          <li>Units to add: <strong>{preview.unitsNew}</strong></li>
          <li>Units to update: <strong>{preview.unitsUpdated}</strong></li>
          <li>Criteria to add: <strong>{preview.criteriaNew}</strong></li>
          <li>Criteria to update: <strong>{preview.criteriaUpdated}</strong></li>
        </ul>

        {#if unitRows.length > 0}
          <div class="max-h-56 overflow-y-auto rounded border">
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.Head class="w-20">Code</Table.Head>
                  <Table.Head>Unit</Table.Head>
                  <Table.Head class="w-24">Status</Table.Head>
                  <Table.Head class="w-20 text-right">New</Table.Head>
                  <Table.Head class="w-24 text-right">Updated</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each unitRows as u, i (u.title + ':' + i)}
                  <Table.Row>
                    <Table.Cell class="font-mono text-xs">{u.code ?? ''}</Table.Cell>
                    <Table.Cell class="text-sm">{u.title}</Table.Cell>
                    <Table.Cell class="text-sm">{STATE_LABEL[u.state] ?? u.state}</Table.Cell>
                    <Table.Cell class="text-right tabular-nums">{u.criteriaNew}</Table.Cell>
                    <Table.Cell class="text-right tabular-nums">{u.criteriaUpdated}</Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
          </div>
        {/if}

        {#if preview.errors.length > 0}
          <div>
            <p class="text-sm font-medium text-red-700 dark:text-red-400">
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
          </div>
        {/if}

        {#if warnings.length > 0}
          <div>
            <p class="text-sm font-medium text-amber-700 dark:text-amber-400">
              {warnings.length} warning{warnings.length === 1 ? '' : 's'} (these rows still import)
            </p>
            <div class="mt-1 max-h-40 overflow-y-auto rounded border">
              <Table.Root>
                <Table.Header>
                  <Table.Row>
                    <Table.Head class="w-16">Row</Table.Head>
                    <Table.Head>Note</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {#each warnings as w, i (w.row + ':' + i)}
                    <Table.Row>
                      <Table.Cell class="tabular-nums">{w.row > 0 ? w.row : '—'}</Table.Cell>
                      <Table.Cell class="text-sm">{w.message}</Table.Cell>
                    </Table.Row>
                  {/each}
                </Table.Body>
              </Table.Root>
            </div>
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
