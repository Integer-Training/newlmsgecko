import axios from 'axios';
import { classroomio } from '$lib/utils/services/api';
import { snackbar } from '$features/ui/snackbar/store';
import { call, type CallResult } from './call';
import type { EnrolmentRow } from './enrolments.svelte';

// Gecko Apprenticeships — admin client for task plans (templates): list / detail / edit / archive / delete, their
// tasks (plan items), brief file upload (presign → PUT) and assigning plans to learners. Shapes mirror
// apps/api/src/services/apprenticeship/task-plans.ts. Every route is ADMIN-only server-side.

export type TaskPlanStatus = 'ACTIVE' | 'ARCHIVED';

export interface BriefFile {
  key: string;
  name: string;
  size?: number;
  type?: string;
}

export interface TaskPlanListItem {
  id: string;
  programmeId: string;
  programmeTitle: string;
  title: string;
  validFrom: string | null;
  validTo: string | null;
  status: TaskPlanStatus;
  itemCount: number;
  assignedCount: number;
}

export interface TaskPlan {
  id: string;
  programmeId: string;
  title: string;
  validFrom: string | null;
  validTo: string | null;
  status: TaskPlanStatus;
  files: BriefFile[];
}

export interface TaskPlanItem {
  id: string;
  planId: string;
  title: string;
  details: string;
  typeKey: string;
  sequence: number;
  monthOffset: number;
  expectedMinutes: number;
  files: BriefFile[];
  criteria: { id: string; code: string }[];
}

export interface TaskPlanAssignee {
  enrolmentId: string;
  learnerId: string;
  learnerName: string;
  startDate: string | null;
  taskCount: number;
  completeCount: number;
}

export interface TaskPlanDetail {
  plan: TaskPlan;
  items: TaskPlanItem[];
  assignees: TaskPlanAssignee[];
}

export interface TaskPlanItemBody {
  title: string;
  details: string;
  typeKey: string;
  monthOffset: number;
  expectedMinutes: number;
  files: BriefFile[];
  criterionIds: string[];
}

// Only the fields the API accepts (the server rows also carry uploadedBy / uploadedAt).
const toFile = (f: BriefFile): BriefFile => ({ key: f.key, name: f.name, size: f.size, type: f.type });
const toFiles = (files: BriefFile[] | undefined) => (files ? { files: files.map(toFile) } : {});

const base = () => classroomio.apprenticeship['task-plans'];

class TaskPlansApi {
  list(query: { programmeId?: string; status?: TaskPlanStatus } = {}) {
    const q: Record<string, string> = {};
    if (query.programmeId) q.programmeId = query.programmeId;
    if (query.status) q.status = query.status;
    return call<TaskPlanListItem[]>(() => base().$get({ query: q }), 'Could not load task plans.');
  }

  detail(id: string) {
    return call<TaskPlanDetail>(() => base()[':id'].$get({ param: { id } }), 'Could not load the task plan.');
  }

  create(body: {
    id?: string;
    programmeId: string;
    title: string;
    validFrom: string | null;
    validTo: string | null;
    files: BriefFile[];
  }) {
    return call<TaskPlan>(
      () => base().$post({ json: { ...body, ...toFiles(body.files) } }),
      'Could not create the task plan.'
    );
  }

  update(
    id: string,
    body: { title?: string; validFrom?: string | null; validTo?: string | null; files?: BriefFile[] }
  ) {
    return call<TaskPlan>(
      () => base()[':id'].$patch({ param: { id }, json: { ...body, ...toFiles(body.files) } }),
      'Could not save the task plan.'
    );
  }

  setArchived(id: string, archived: boolean) {
    return call<TaskPlan>(
      () => (archived ? base()[':id'].archive : base()[':id'].unarchive).$post({ param: { id } }),
      archived ? 'Could not archive the task plan.' : 'Could not restore the task plan.'
    );
  }

  remove(id: string) {
    return call<{ deleted: boolean }>(
      () => base()[':id'].$delete({ param: { id } }),
      'Could not delete the task plan.'
    );
  }

  // ── Tasks (plan items) ──

  addItem(planId: string, body: TaskPlanItemBody) {
    return call<TaskPlanItem>(
      () => base()[':id'].items.$post({ param: { id: planId }, json: { ...body, ...toFiles(body.files) } }),
      'Could not add the task.'
    );
  }

  updateItem(planId: string, itemId: string, body: Partial<TaskPlanItemBody>) {
    return call<TaskPlanItem>(
      () =>
        base()[':id'].items[':itemId'].$patch({
          param: { id: planId, itemId },
          json: { ...body, ...toFiles(body.files) }
        }),
      'Could not save the task.'
    );
  }

  deleteItem(planId: string, itemId: string) {
    return call<{ deleted: boolean; removedTasks: number }>(
      () => base()[':id'].items[':itemId'].$delete({ param: { id: planId, itemId } }),
      'Could not delete the task.'
    );
  }

  reorder(planId: string, orderedIds: string[]) {
    return call<{ ordered: number }>(
      () => base()[':id'].items.reorder.$put({ param: { id: planId }, json: { orderedIds } }),
      'Could not reorder the tasks.'
    );
  }

  // ── Learners ──

  assign(planId: string, enrolmentIds: string[]) {
    return call<{ created: number; skipped: number }>(
      () => base()[':id'].assign.$post({ param: { id: planId }, json: { enrolmentIds } }),
      'Could not assign the task plan.'
    );
  }

  unassign(planId: string, enrolmentIds: string[]) {
    return call<{ removed: number }>(
      () => base()[':id'].unassign.$post({ param: { id: planId }, json: { enrolmentIds } }),
      'Could not unassign the learners.'
    );
  }

  sync(planId: string) {
    return call<{ updated: number }>(
      () => base()[':id'].sync.$post({ param: { id: planId } }),
      'Could not update the assigned learners.'
    );
  }

  /** Every enrolment on a programme (the list API pages at 100). */
  async enrolmentsForProgramme(programmeId: string): Promise<CallResult<EnrolmentRow[]>> {
    const rows: EnrolmentRow[] = [];
    for (let page = 1; page <= 50; page++) {
      const res = await call<{ items: EnrolmentRow[]; total: number }>(
        () =>
          classroomio.apprenticeship.enrolments.$get({
            query: { programmeId, page: String(page), pageSize: '100' }
          }),
        'Could not load the programme’s learners.'
      );
      if (!res.ok) return res;
      rows.push(...res.data.items);
      if (rows.length >= res.data.total || res.data.items.length === 0) break;
    }
    return { ok: true, data: rows };
  }

  // ── Brief files ──

  /**
   * Presign → PUT each file straight to storage. `planId` is omitted for a plan not saved yet; the server issues one
   * that must be passed back on create.
   */
  async upload(planId: string | undefined, files: File[]): Promise<CallResult<{ planId: string; files: BriefFile[] }>> {
    const presign = await call<{ planId: string; files: { name: string; key: string; uploadUrl: string }[] }>(
      () =>
        base().presign.$post({
          json: {
            ...(planId ? { planId } : {}),
            files: files.map((f) => ({ name: f.name, size: f.size, type: f.type || 'application/octet-stream' }))
          }
        }),
      'Could not prepare the upload.'
    );
    if (!presign.ok) return presign;
    try {
      const uploaded: BriefFile[] = [];
      for (let i = 0; i < files.length; i++) {
        const target = presign.data.files[i];
        const type = files[i].type || 'application/octet-stream';
        await axios.put(target.uploadUrl, files[i], { headers: { 'Content-Type': type } });
        uploaded.push({ key: target.key, name: files[i].name, size: files[i].size, type });
      }
      return { ok: true, data: { planId: presign.data.planId, files: uploaded } };
    } catch {
      return { ok: false, error: 'The upload failed. Please try again.' };
    }
  }

  /** Open one brief file via a short-lived signed URL. The tab is opened before the await so popup blockers allow it. */
  async openFile(planId: string, key: string): Promise<void> {
    const tab = window.open('', '_blank');
    const res = await call<Record<string, string>>(() =>
      classroomio.apprenticeship.tasks.download.$post({ json: { planId, keys: [key] } })
    );
    const url = res.ok ? res.data[key] : undefined;
    if (!url) {
      tab?.close();
      snackbar.error(res.ok ? 'Could not open the file.' : res.error);
      return;
    }
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.open(url, '_blank', 'noopener');
    }
  }
}

export const taskPlansApi = new TaskPlansApi();
