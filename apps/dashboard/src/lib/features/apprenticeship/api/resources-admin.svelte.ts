import axios from 'axios';
import { classroomio, getRequestBaseUrl } from '$lib/utils/services/api';
import { snackbar } from '$features/ui/snackbar/store';
import { call, type CallResult } from './call';
import {
  apprResourceMimeForFile,
  type ApprResourceKind,
  type ApprResourceStatus
} from '@cio/utils/constants/apprenticeship';

// Gecko Apprenticeships — staff client for programme resources (learning resources + workbooks). Shapes mirror the
// API contract in apps/api/src/routes/apprenticeship/resources.ts. One singleton holds the programme's resources so
// the General card, every unit card and the dialogs always agree after any change.

export type ResourceLearnerStatus = 'NOT_STARTED' | 'VIEWED' | 'DOWNLOADED' | 'SUBMITTED' | 'REFERRED' | 'ACCEPTED';

export interface ResourceItem {
  id: string;
  programmeId: string;
  unitId: string | null;
  unitTitle: string | null;
  unitCode: string | null;
  kind: ApprResourceKind;
  title: string;
  description: string | null;
  file: { name: string; size: number; type: string };
  version: number;
  sort: number;
  status: ApprResourceStatus;
  evidenceTypeKey: string | null;
  criterionIds: string[];
  evidenceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LearnerResourceItem extends Omit<ResourceItem, 'evidenceCount' | 'status'> {
  enrolmentId: string;
  programmeTitle: string;
  programmeType: string;
  downloadable: boolean;
  activity: {
    firstViewedAt: string | null;
    lastDownloadedAt: string | null;
    downloadCount: number;
    lastVersion: number | null;
  } | null;
  updatedSinceDownload: boolean;
  status: ResourceLearnerStatus;
  latestEvidenceId: string | null;
}

export interface EnrolmentResources {
  programmes: { enrolmentId: string; programmeId: string; title: string; type: string; withdrawn: boolean }[];
  resources: LearnerResourceItem[];
}

export interface UploadedResourceFile {
  resourceId: string;
  file: { key: string; name: string; size: number; type: string };
}

export interface ResourceWriteBody {
  title: string;
  description?: string;
  unitId: string | null;
  kind: ApprResourceKind;
  evidenceTypeKey?: string | null;
  criterionIds: string[];
}

/** The dialog the host should show. `unitId` pre-selects the unit for an add. */
export type ResourceDialogState =
  | { mode: 'add'; unitId: string | null }
  | { mode: 'bulk'; unitId: string | null }
  | { mode: 'edit'; resource: ResourceItem }
  | { mode: 'replace'; resource: ResourceItem }
  | { mode: 'move'; resource: ResourceItem }
  | { mode: 'delete'; resource: ResourceItem }
  | { mode: 'preview'; resource: ResourceItem }
  | null;

const base = () => classroomio.apprenticeship.resources;

class ResourcesAdminApi {
  programmeId = $state<string | null>(null);
  items = $state<ResourceItem[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  showArchived = $state(false);
  dialog = $state<ResourceDialogState>(null);
  /** Ids of resources with an action in flight (disables their row). */
  busy = $state<string[]>([]);

  private seq = 0;

  /** Resources of one scope (a unit id, or null = General), in display order. */
  scope(unitId: string | null, includeArchived = this.showArchived): ResourceItem[] {
    return this.items
      .filter((r) => r.unitId === unitId && (includeArchived || r.status === 'ACTIVE'))
      .sort((a, b) => a.sort - b.sort || a.createdAt.localeCompare(b.createdAt));
  }

  activeCount(unitId: string | null): number {
    return this.items.filter((r) => r.unitId === unitId && r.status === 'ACTIVE').length;
  }

  archivedCount(unitId?: string | null): number {
    return this.items.filter((r) => r.status === 'ARCHIVED' && (unitId === undefined || r.unitId === unitId)).length;
  }

  get totalArchived() {
    return this.archivedCount();
  }

  async load(programmeId: string, quiet = false) {
    const mine = ++this.seq;
    if (this.programmeId !== programmeId) {
      this.items = [];
      this.programmeId = programmeId;
    }
    if (!quiet) this.loading = true;
    this.error = null;
    const res = await call<{ resources: ResourceItem[] }>(
      () => base().programme[':programmeId'].$get({ param: { programmeId }, query: { status: 'ALL' } }),
      'Could not load resources.'
    );
    if (mine !== this.seq) return;
    this.loading = false;
    if (res.ok) this.items = res.data.resources;
    else this.error = res.error;
  }

  private reload() {
    return this.programmeId ? this.load(this.programmeId, true) : Promise.resolve();
  }

  private setBusy(id: string, on: boolean) {
    this.busy = on ? [...this.busy, id] : this.busy.filter((b) => b !== id);
  }

  // ── Upload (presign → PUT) ──
  /** Check a file against the kind's allowed types. Returns a message, or null when fine. */
  validateFile(kind: ApprResourceKind, file: File): string | null {
    if (file.size === 0) return `${file.name} is empty.`;
    if (apprResourceMimeForFile(kind, file.name)) return null;
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (kind === 'LEARNING') {
      return ext === 'doc'
        ? `${file.name}: .doc files cannot be shown to learners. Save it as .docx or PDF.`
        : `${file.name}: learning resources must be a PDF or Word (.docx) file.`;
    }
    return `${file.name}: workbooks can be PDF, Word, Excel or PowerPoint (pdf, doc, docx, xlsx, pptx).`;
  }

  /** Presign (a new resource id, or `resourceId` to replace) and PUT the bytes straight to storage. */
  async uploadFile(
    programmeId: string,
    kind: ApprResourceKind,
    file: File,
    opts: { resourceId?: string; onProgress?: (pct: number) => void } = {}
  ): Promise<CallResult<UploadedResourceFile>> {
    const type = apprResourceMimeForFile(kind, file.name) ?? file.type;
    const presign = await call<{ resourceId: string; key: string; uploadUrl: string }>(
      () =>
        base().presign.$post({
          json: {
            programmeId,
            resourceId: opts.resourceId,
            kind,
            fileName: file.name,
            contentType: type,
            size: file.size
          }
        }),
      'Could not prepare the upload.'
    );
    if (!presign.ok) return presign;
    try {
      await axios.put(presign.data.uploadUrl, file, {
        headers: { 'Content-Type': type },
        onUploadProgress: (e) => {
          if (e.total) opts.onProgress?.(Math.round((e.loaded / e.total) * 100));
        }
      });
    } catch {
      return { ok: false, error: `Uploading ${file.name} failed. Please try again.` };
    }
    opts.onProgress?.(100);
    return {
      ok: true,
      data: {
        resourceId: presign.data.resourceId,
        file: { key: presign.data.key, name: file.name, size: file.size, type }
      }
    };
  }

  // ── Create / update ──
  async create(programmeId: string, uploaded: UploadedResourceFile, body: ResourceWriteBody) {
    const res = await call<ResourceItem>(
      () =>
        base().$post({
          json: {
            id: uploaded.resourceId,
            programmeId,
            unitId: body.unitId,
            kind: body.kind,
            title: body.title,
            description: body.description || undefined,
            file: uploaded.file,
            evidenceTypeKey: body.kind === 'WORKBOOK' ? (body.evidenceTypeKey ?? undefined) : undefined,
            criterionIds: body.kind === 'WORKBOOK' ? body.criterionIds : []
          }
        }),
      'Could not save the resource.'
    );
    return res;
  }

  async update(id: string, body: Partial<ResourceWriteBody> & { file?: UploadedResourceFile['file'] }) {
    const res = await call<ResourceItem>(
      () => base()[':id'].$patch({ param: { id }, json: body }),
      'Could not save the resource.'
    );
    if (res.ok) await this.reload();
    return res;
  }

  async archive(r: ResourceItem, archived: boolean) {
    this.setBusy(r.id, true);
    const res = await call<unknown>(
      () => (archived ? base()[':id'].archive : base()[':id'].restore).$post({ param: { id: r.id } }),
      archived ? 'Could not archive the resource.' : 'Could not restore the resource.'
    );
    this.setBusy(r.id, false);
    if (!res.ok) {
      snackbar.error(res.error);
      return false;
    }
    await this.reload();
    snackbar.success(archived ? 'Archived — hidden from learners' : 'Restored — visible to learners again');
    return true;
  }

  async remove(r: ResourceItem) {
    this.setBusy(r.id, true);
    const res = await call<unknown>(
      () => base()[':id'].$delete({ param: { id: r.id } }),
      'Could not delete the resource.'
    );
    this.setBusy(r.id, false);
    if (!res.ok) {
      snackbar.error(res.error);
      return false;
    }
    await this.reload();
    snackbar.success('Resource deleted');
    return true;
  }

  /** Reorder one scope. `ids` is the full new order of that scope (active first, then archived). */
  async reorder(unitId: string | null, ids: string[]) {
    const programmeId = this.programmeId;
    if (!programmeId) return;
    // Optimistic: renumber locally so the list moves at once.
    const pos = new Map(ids.map((id, i) => [id, i]));
    this.items = this.items.map((r) => (pos.has(r.id) ? { ...r, sort: pos.get(r.id)! } : r));
    const res = await call<unknown>(
      () => base().programme[':programmeId'].reorder.$post({ param: { programmeId }, json: { unitId, ids } }),
      'Could not reorder the resources.'
    );
    if (!res.ok) {
      snackbar.error(res.error);
      await this.reload();
    }
  }

  /** ONE in-app notification per saved batch (active learners of the programme and its paired diploma). */
  async notify(resourceIds: string[]) {
    const programmeId = this.programmeId;
    if (!programmeId || resourceIds.length === 0) return;
    const res = await call<unknown>(
      () => base().programme[':programmeId'].notify.$post({ param: { programmeId }, json: { resourceIds } }),
      'Could not notify learners.'
    );
    if (!res.ok) snackbar.info(`Saved, but learners were not notified: ${res.error}`);
  }

  /** Refresh after a dialog saved something. */
  refresh() {
    return this.reload();
  }

  // ── Learner view (staff looking at a learner's portfolio) ──
  forEnrolment(enrolmentId: string) {
    return call<EnrolmentResources>(
      () => base().enrolment[':enrolmentId'].$get({ param: { enrolmentId } }),
      'Could not load resources.'
    );
  }

  /** Same-origin stream of the file, inline (what a learner would see). Opens in a new tab. */
  contentUrl(id: string, enrolmentId?: string): string {
    const q = enrolmentId ? `?enrolmentId=${encodeURIComponent(enrolmentId)}` : '';
    return `${getRequestBaseUrl()}/apprenticeship/resources/${id}/content${q}`;
  }

  preview(id: string, enrolmentId?: string) {
    window.open(this.contentUrl(id, enrolmentId), '_blank', 'noopener');
  }
}

export const resourcesAdminApi = new ResourcesAdminApi();
