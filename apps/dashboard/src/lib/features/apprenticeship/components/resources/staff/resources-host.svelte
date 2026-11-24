<script lang="ts">
  import { untrack } from 'svelte';
  import { snackbar } from '$features/ui/snackbar/store';
  import { resourcesAdminApi } from '../../../api/resources-admin.svelte';
  import ConfirmDeleteDialog from '../../programme/confirm-delete-dialog.svelte';
  import ResourceDialog from './resource-dialog.svelte';
  import BulkAddDialog from './bulk-add-dialog.svelte';
  import ReplaceDialog from './replace-dialog.svelte';
  import MoveDialog from './move-dialog.svelte';
  import ResourceViewer from '../learner/resource-viewer.svelte';
  import { ResourceActions } from '../learner/resource-actions.svelte';
  import type { LearnerResourceItem } from '../../../api/resources-learner.svelte';

  // One mount point for every resource dialog (rows and unit cards just set `resourcesAdminApi.dialog`). Loads the
  // programme's resources so the General card and every unit card read from the same list.
  interface Props {
    programmeId: string;
  }
  let { programmeId }: Props = $props();

  const api = resourcesAdminApi;
  let deleting = $state(false);

  $effect(() => {
    const id = programmeId;
    untrack(() => {
      api.dialog = null;
      api.load(id);
    });
  });

  const d = $derived(api.dialog);
  const close = (v: boolean) => {
    if (!v) api.dialog = null;
  };

  // "Preview as learner": the same on-page viewer learners get (PDF/Word rendered, no download for Learning).
  const previewActions = new ResourceActions(null, () => {});
  const previewItem = $derived.by((): LearnerResourceItem | null => {
    if (d?.mode !== 'preview') return null;
    const { evidenceCount: _ec, status: _st, ...rest } = d.resource;
    return {
      ...rest,
      enrolmentId: '',
      programmeTitle: '',
      programmeType: null,
      downloadable: d.resource.kind === 'WORKBOOK',
      activity: null,
      updatedSinceDownload: false,
      status: 'NOT_STARTED',
      latestEvidenceId: null
    };
  });

  async function confirmDelete() {
    if (d?.mode !== 'delete') return;
    deleting = true;
    const ok = await api.remove(d.resource);
    deleting = false;
    if (ok) api.dialog = null;
    else snackbar.error('Could not delete the resource.');
  }
</script>

<ResourceDialog
  bind:open={() => d?.mode === 'add' || d?.mode === 'edit', close}
  {programmeId}
  resource={d?.mode === 'edit' ? d.resource : null}
  unitId={d?.mode === 'add' ? d.unitId : null}
/>
<BulkAddDialog
  bind:open={() => d?.mode === 'bulk', close}
  {programmeId}
  unitId={d?.mode === 'bulk' ? d.unitId : null}
/>
{#if d?.mode === 'replace'}
  <ReplaceDialog bind:open={() => true, close} {programmeId} resource={d.resource} />
{/if}
{#if d?.mode === 'preview'}
  <ResourceViewer
    bind:open={() => true, close}
    resource={previewItem}
    downloading={previewActions.downloadingId !== null}
    onDownload={(r) => previewActions.download(r)}
    onUpload={() => {}}
  />
{/if}
{#if d?.mode === 'move'}
  <MoveDialog bind:open={() => true, close} {programmeId} resource={d.resource} />
{/if}
<ConfirmDeleteDialog
  bind:open={() => d?.mode === 'delete', close}
  title="Delete resource"
  description={d?.mode === 'delete'
    ? `Delete “${d.resource.title}” and its file? This cannot be undone. Learners will no longer see it.`
    : ''}
  busy={deleting}
  onconfirm={confirmDelete}
/>
