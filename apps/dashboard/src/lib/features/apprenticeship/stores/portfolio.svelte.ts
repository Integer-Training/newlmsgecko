import { snackbar } from '$features/ui/snackbar/store';
import { enrolmentsApi, type EnrolmentUpdateBody, type Portfolio, type UnitDatesBody } from '../api/enrolments.svelte';
import { reviewsApi, type ReviewItem } from '../api/reviews.svelte';
import { tasksApi, type TaskItem } from '../api/tasks.svelte';
import { evidenceApi, type EvidenceListItem, type PickerQualification } from '../api/evidence.svelte';

/**
 * ONE store per open portfolio. It holds the GET /:id/portfolio payload and the learner's evidence list; every
 * mutation (enrolment edit, dates, spread, evidence create / edit / review) replaces them from the API response (or
 * one refetch), so the header, units, criteria, grid, evidence list and OTJ tab always agree. No progress maths here.
 */
export class PortfolioStore {
  enrolmentId: string;
  data = $state<Portfolio | null>(null);
  evidence = $state<EvidenceListItem[]>([]);
  tasks = $state<TaskItem[]>([]);
  reviews = $state<ReviewItem[]>([]);
  tasksError = $state<string | null>(null);
  reviewsError = $state<string | null>(null);
  loading = $state(true);
  error = $state<string | null>(null);
  saving = $state(false);
  /** Bumped after every change so open criterion popovers re-fetch their list. */
  version = $state(0);

  // The evidence side-sheet (one per portfolio, opened from any tab).
  sheet = $state<{
    open: boolean;
    mode: 'add' | 'view';
    evidenceId: string | null;
    criterionIds: string[];
    /** Set when answering a task: the form opens pre-filled from it. */
    taskId: string | null;
  }>({
    open: false,
    mode: 'view',
    evidenceId: null,
    criterionIds: [],
    taskId: null
  });
  /** The portfolio tab to show (a notification deep-links with ?tab=tasks|reviews; the header chips jump too). */
  tab = $state('units');

  #reqId = 0;

  constructor(enrolmentId: string) {
    this.enrolmentId = enrolmentId;
  }

  /** The programme structure in the shape the criteria picker wants (straight from the portfolio payload). */
  pickerTree = $derived<PickerQualification[]>(
    (this.data?.qualifications ?? []).map((q) => ({
      id: q.id,
      title: q.title,
      units: q.units.map((u) => ({
        id: u.id,
        code: u.code,
        title: u.title,
        criteria: u.criteria.map((c) => ({ id: c.id, code: c.code, text: c.text }))
      }))
    }))
  );

  async load() {
    const reqId = ++this.#reqId;
    this.loading = this.data === null;
    const [p, e, t, r] = await Promise.all([
      enrolmentsApi.getPortfolio(this.enrolmentId),
      evidenceApi.forEnrolment(this.enrolmentId),
      tasksApi.forEnrolment(this.enrolmentId),
      reviewsApi.forEnrolment(this.enrolmentId)
    ]);
    if (reqId !== this.#reqId) return;
    this.loading = false;
    if (p.ok) {
      this.data = p.data;
      this.error = null;
    } else {
      this.error = p.error;
    }
    if (e.ok) this.evidence = e.data;
    // Tasks / reviews fail independently: the rest of the portfolio still works.
    if (t.ok) {
      this.tasks = t.data.items;
      this.tasksError = null;
    } else {
      this.tasksError = t.error;
    }
    if (r.ok) {
      this.reviews = r.data.items;
      this.reviewsError = null;
    } else {
      this.reviewsError = r.error;
    }
    this.version += 1;
  }

  /** Refetch everything once (after an evidence mutation, whose response carries only the summary). */
  refresh() {
    return this.load();
  }

  #apply(res: { ok: true; data: Portfolio } | { ok: false; error: string }, okMessage: string): boolean {
    if (res.ok) {
      this.data = res.data;
      this.version += 1;
      snackbar.success(okMessage);
      return true;
    }
    snackbar.error(res.error);
    return false;
  }

  async patchEnrolment(body: EnrolmentUpdateBody): Promise<boolean> {
    this.saving = true;
    try {
      return this.#apply(await enrolmentsApi.patch(this.enrolmentId, body), 'Dates and hours saved');
    } finally {
      this.saving = false;
    }
  }

  async setUnitDates(body: UnitDatesBody): Promise<boolean> {
    this.saving = true;
    try {
      return this.#apply(await enrolmentsApi.putUnitDates(this.enrolmentId, body), 'Unit dates saved');
    } finally {
      this.saving = false;
    }
  }

  async spread(onlyEmpty: boolean): Promise<boolean> {
    this.saving = true;
    try {
      return this.#apply(await enrolmentsApi.spread(this.enrolmentId, { onlyEmpty }), 'Unit dates spread');
    } finally {
      this.saving = false;
    }
  }

  // ── Evidence sheet ──
  openEvidence(evidenceId: string) {
    this.sheet = { open: true, mode: 'view', evidenceId, criterionIds: [], taskId: null };
  }

  openNewEvidence(criterionIds: string[] = [], taskId: string | null = null) {
    this.sheet = { open: true, mode: 'add', evidenceId: null, criterionIds, taskId };
  }

  /** Answer a task: add-evidence sheet pre-filled from it (title, type, criteria, taskId). */
  openAnswerTask(task: TaskItem) {
    this.openNewEvidence(
      task.criteria.map((c) => c.id),
      task.id
    );
  }

  // ── Tasks / reviews ──
  get overdueTaskCount(): number {
    return this.data?.summary.overdueTaskCount ?? this.tasks.filter((t) => t.overdue).length;
  }

  /** The review to show in the header: the API's, else the earliest open one we hold. */
  get nextReview(): { id: string; scheduledDate: string; status: string; overdue: boolean } | null {
    const open = this.reviews
      .filter((r) => !['COMPLETE', 'CANCELLED'].includes(r.status))
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))[0];
    const n = this.data?.summary.nextReview ?? open ?? null;
    if (!n) return null;
    const overdue = this.data?.summary.reviewOverdue ?? open?.overdue ?? false;
    return { id: n.id, scheduledDate: n.scheduledDate, status: n.status, overdue };
  }

  /** Replace one review in place from a mutation response (the header data is refreshed afterwards). */
  applyReview(r: ReviewItem) {
    const i = this.reviews.findIndex((x) => x.id === r.id);
    this.reviews = i === -1 ? [...this.reviews, r] : this.reviews.map((x) => (x.id === r.id ? r : x));
  }

  closeSheet() {
    this.sheet = { ...this.sheet, open: false };
  }
}
