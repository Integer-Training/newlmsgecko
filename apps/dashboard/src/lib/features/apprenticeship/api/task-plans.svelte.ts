import axios from 'axios';
import { classroomio } from '$lib/utils/services/api';
import { snackbar } from '$features/ui/snackbar/store';
import { call, type CallResult } from './call';
import type { ApprTaskStatus } from '@cio/utils/constants/apprenticeship';
import type { EnrolmentRow, TutorsInput } from './enrolments.svelte';

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
  /** Learners who currently hold this task (a task row exists for them). */
  assignedCount: number;
}

/** One task a learner holds from this plan. */
export interface TaskPlanAssigneeItem {
  itemId: string;
  taskId: string;
  status: ApprTaskStatus;
  dueDate: string | null;
  /** True when the due date was set by hand (a batch date); sync keeps it. */
  dueManual: boolean;
}

export interface TaskPlanAssignee {
  enrolmentId: string;
  learnerId: string;
  learnerName: string;
  startDate: string | null;
  taskCount: number;
  completeCount: number;
  overdueCount: number;
  tutors: TutorsInput;
  /** The plan's tasks this learner holds. */
  items: TaskPlanAssigneeItem[];
  /** How many of the plan's current tasks this learner holds. */
  heldCount: number;
  /** True when the learner holds a task for every current item of the plan. */
  wholePlan: boolean;
}

export interface TaskPlanDetail {
  plan: TaskPlan;
  items: TaskPlanItem[];
  assignees: TaskPlanAssignee[];
  /** Learners who hold every current task of the plan. */
  wholePlanCount: number;
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

export interface TaskPlanAssignBody {
  enrolmentIds: string[];
  /** Omit = the whole plan. */
  itemIds?: string[];
  /** Optional due date for this batch (kept even if the task or the start date changes later). */
  dueDate?: string | null;
}

export interface TaskPlanAutoAssigned {
  created: number;
  learners: number;
  /** Set when the task was added but could not be given to learners. */
  skippedReason?: 'ARCHIVED' | 'OUTSIDE_WINDOW';
}

export type TaskPlanItemAdded = Omit<TaskPlanItem, 'assignedCount'> & { assigned: TaskPlanAutoAssigned };

/** What an assign / add-from-plan call reports (assign and from-plan share this shape). */
export interface TaskPlanAssignResult {
  created: number;
  /** (learner, task) pairs that already existed. */
  skipped: number;
  learners: number;
  /** New tasks already past their due date. */
  pastDue: number;
  /** New tasks with no due date (no start date and no batch date). */
  undated: number;
  /** The batch due date that was applied, if any. */
  dueOverride: string | null;
  /** The batch due date is in the past. */
  overrideInPast: boolean;
}

/** The warnings worth showing after tasks were created ('' when there are none). */
export function assignWarnings(r: Pick<TaskPlanAssignResult, 'pastDue' | 'undated' | 'overrideInPast'>): string {
  const parts: string[] = [];
  if (r.overrideInPast) parts.push('the due date you chose is in the past');
  if (r.pastDue > 0) parts.push(`${r.pastDue} task${r.pastDue === 1 ? ' is' : 's are'} already overdue`);
  if (r.undated > 0) parts.push(`${r.undated} task${r.undated === 1 ? ' has' : 's have'} no due date`);
  return parts.length ? `Heads up: ${parts.join('; ')}.` : '';
}

/**
 * A batch due date earlier than a learner's start date is refused by the server for the WHOLE batch (a task due before
 * the learner began is a wrong flow). Check it up front so nothing is sent: returns a message naming the first few
 * learners (and how many more), or null when the date is fine. Pass only the learners who would receive a NEW task —
 * a learner who already holds everything is skipped by the server and must not block the batch.
 */
export function dueBeforeStartProblem(
  dueDate: string | null,
  learners: readonly { name: string; startDate: string | null }[]
): string | null {
  if (!dueDate) return null;
  const early = learners.filter((l) => !!l.startDate && dueDate < l.startDate.slice(0, 10));
  if (early.length === 0) return null;
  const shown = early.slice(0, 3).map((l) => l.name);
  const more = early.length - shown.length;
  const names = shown.join(', ') + (more > 0 ? ` and ${more} more` : '');
  const count = `${early.length} selected learner${early.length === 1 ? '' : 's'}`;
  return `That due date is before the start date of ${count} (${names}). Choose a later date or untick them.`;
}

// Only the fields the API accepts (the server rows also carry uploadedBy / uploadedAt).
const toFile = (f: BriefFile): BriefFile => ({ key: f.key, name: f.name, size: f.size, type: f.type });
const toFiles = (files: BriefFile[] | undefined) => (files ? { files: files.map(toFile) } : {});

/** Max enrolments the API takes per assign / unassign call (callers with more must batch). */
export const PLAN_BATCH_SIZE = 500;

const base = () => classroomio.apprenticeship['task-plans'];

// The sync route reads its optional { itemIds } body by hand (no validator), so the generated type has no `json`.
const syncRoute = () =>
  base()[':id'].sync as unknown as {
    $post: (args: { param: { id: string }; json: { itemIds?: string[] } }) => Promise<Response>;
  };

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

  /** `assignTo: 'WHOLE_PLAN'` also gives the new task to learners who hold every other task of the plan. */
  addItem(planId: string, body: TaskPlanItemBody, assignTo: 'NONE' | 'WHOLE_PLAN' = 'NONE') {
    return call<TaskPlanItemAdded>(
      () => base()[':id'].items.$post({ param: { id: planId }, json: { ...body, ...toFiles(body.files), assignTo } }),
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

  assign(planId: string, body: TaskPlanAssignBody) {
    const json = {
      enrolmentIds: body.enrolmentIds,
      ...(body.itemIds ? { itemIds: body.itemIds } : {}),
      ...(body.dueDate ? { dueDate: body.dueDate } : {})
    };
    return call<TaskPlanAssignResult>(
      () => base()[':id'].assign.$post({ param: { id: planId }, json }),
      'Could not assign the task plan.'
    );
  }

  /** Removes planned tasks nobody has answered; `kept` = tasks left because evidence or progress exists. */
  unassign(planId: string, enrolmentIds: string[], itemIds?: string[]) {
    return call<{ removed: number; kept: number }>(
      () =>
        base()[':id'].unassign.$post({
          param: { id: planId },
          json: { enrolmentIds, ...(itemIds ? { itemIds } : {}) }
        }),
      'Could not unassign the learners.'
    );
  }

  /**
   * Copies the plan's current task details onto assigned learners' not-yet-started tasks (optionally only some
   * tasks). `manualDueKept` = tasks whose hand-set due date differed from the rule and was left alone.
   */
  sync(planId: string, itemIds?: string[]) {
    return call<{ updated: number; manualDueKept: number }>(
      () => syncRoute().$post({ param: { id: planId }, json: itemIds ? { itemIds } : {} }),
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
