import axios from 'axios';
import type { ApprTaskStatus } from '@cio/utils/constants/apprenticeship';
import { classroomio } from '$lib/utils/services/api';
import { snackbar } from '$features/ui/snackbar/store';
import { call, type CallResult } from './call';
import type { UploadedFile } from './evidence.svelte';

// Gecko Apprenticeships — client for a learner's tasks (plan-assigned or individual). Shapes mirror
// apps/api/src/services/apprenticeship/tasks.ts. Status / overdue are the API's; nothing is recomputed here.

export interface TaskFile {
  key: string;
  name: string;
  size?: number;
  type?: string;
}

export interface TaskItem {
  id: string;
  enrolmentId: string;
  title: string;
  details: string;
  typeKey: string;
  /** No start date on the enrolment → no due date (null). */
  dueDate: string | null;
  expectedMinutes: number;
  files: TaskFile[];
  status: ApprTaskStatus;
  statusLabel: string;
  overdue: boolean;
  fromPlan: boolean;
  planId: string | null;
  /** Provided by the API when it can; otherwise the UI says "Plan task". */
  planTitle?: string | null;
  criteria: { id: string; code: string }[];
  evidence: { id: string; title: string; status: string }[];
}

export interface TaskList {
  items: TaskItem[];
  counts: { total: number; complete: number; overdue: number };
}

export interface TaskBody {
  id?: string;
  title: string;
  details: string;
  typeKey: string;
  dueDate: string | null;
  expectedMinutes: number;
  files: TaskFile[];
  criterionIds: string[];
}

class TasksApi {
  forEnrolment(enrolmentId: string) {
    return call<TaskList>(() =>
      classroomio.apprenticeship.tasks.enrolments[':id'].tasks.$get({ param: { id: enrolmentId } })
    );
  }

  create(enrolmentId: string, body: TaskBody): Promise<CallResult<{ id: string }>> {
    return call(() =>
      classroomio.apprenticeship.tasks.enrolments[':id'].tasks.$post({ param: { id: enrolmentId }, json: body })
    );
  }

  update(id: string, body: Partial<Omit<TaskBody, 'id'>>): Promise<CallResult<{ id: string }>> {
    return call(() => classroomio.apprenticeship.tasks[':id'].$patch({ param: { id }, json: body }));
  }

  remove(id: string) {
    return call<{ deleted: boolean; detachedEvidence: number }>(() =>
      classroomio.apprenticeship.tasks[':id'].$delete({ param: { id } })
    );
  }

  /** Brief files for an individual task: presign → PUT. Returns the id they were presigned for (pass it on create). */
  async upload(
    enrolmentId: string,
    files: File[],
    taskId?: string
  ): Promise<CallResult<{ taskId: string; files: UploadedFile[] }>> {
    const presign = await call<{ taskId: string; files: { name: string; key: string; uploadUrl: string }[] }>(() =>
      classroomio.apprenticeship.tasks.presign.$post({
        json: {
          enrolmentId,
          ...(taskId ? { taskId } : {}),
          files: files.map((f) => ({ name: f.name, size: f.size, type: f.type || 'application/octet-stream' }))
        }
      })
    );
    if (!presign.ok) return presign;
    try {
      const uploaded: UploadedFile[] = [];
      for (let i = 0; i < files.length; i++) {
        const type = files[i].type || 'application/octet-stream';
        await axios.put(presign.data.files[i].uploadUrl, files[i], { headers: { 'Content-Type': type } });
        uploaded.push({ key: presign.data.files[i].key, name: files[i].name, size: files[i].size, type });
      }
      return { ok: true, data: { taskId: presign.data.taskId, files: uploaded } };
    } catch {
      return { ok: false, error: 'The upload failed. Please try again.' };
    }
  }

  /** Open one brief file via a short-lived signed URL (tab opened inside the click so popup blockers allow it). */
  async openFile(taskId: string, key: string): Promise<void> {
    const tab = window.open('', '_blank');
    const res = await call<Record<string, string>>(() =>
      classroomio.apprenticeship.tasks.download.$post({ json: { taskId, keys: [key] } })
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

export const tasksApi = new TasksApi();
