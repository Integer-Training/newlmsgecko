import { get } from 'svelte/store';
import type { ApprProgrammeType } from '@cio/utils/constants/apprenticeship';
import { isOrgTeamMember } from '$lib/utils/store/org';
import { snackbar } from '$features/ui/snackbar/store';
import { enrolmentsApi, type EnrolmentUpdateBody, type Portfolio, type UnitDatesBody } from '../api/enrolments.svelte';
import type { CallResult } from '../api/call';
import { overviewApi } from '../api/overview.svelte';
import type { OverviewPayload, PortfolioLinked } from '../api/overview.types';
import { gatewayApi, type GlhLog } from '../api/gateway.svelte';
import { reviewsApi, type ReviewItem } from '../api/reviews.svelte';
import { tasksApi, type TaskItem } from '../api/tasks.svelte';
import { evidenceApi, type EvidenceListItem, type PickerQualification } from '../api/evidence.svelte';

/** The portfolio payload plus the Deploy 2 additions (`programme.type`, `linked`); both absent on an older API. */
export type PortfolioView = Portfolio & { programme: { type?: ApprProgrammeType }; linked?: PortfolioLinked | null };

export interface PortfolioStoreOptions {
  /**
   * true = load exactly this one enrolment (qualification and unit pages). false (default) = the learner portfolio:
   * a component id resolves to its carrier, and the paired enrolment is loaded alongside it.
   */
  scoped?: boolean;
}

const okOf = <T>(data: T): CallResult<T> => ({ ok: true, data });

/**
 * ONE store per open portfolio. It holds the GET /:id/portfolio payload and the learner's evidence list; every
 * mutation (enrolment edit, dates, spread, evidence create / edit / review) replaces them from the API response (or
 * one refetch), so the header, units, criteria, grid, evidence list and OTJ tab always agree. No progress maths here.
 *
 * Paired apprenticeships (Diploma + Standard): `data` is always the CARRIER's portfolio (learner-level things such as
 * evidence, tasks, reviews, OTJ and the gateway live there) and `pair` is the other enrolment's portfolio. A page opened
 * with the component's id resolves to the carrier and remembers the requested qualification (`selectedQualId`).
 */
export class PortfolioStore {
  /** The id the page was opened with. */
  readonly requestedId: string;
  readonly scoped: boolean;
  /** The id every learner-level call uses: the carrier once resolved (same as requestedId when not paired). */
  enrolmentId: string;
  data = $state<PortfolioView | null>(null);
  /** The other enrolment of the pair (null when standalone or scoped). */
  pair = $state<PortfolioView | null>(null);
  overview = $state<OverviewPayload | null>(null);
  overviewError = $state<string | null>(null);
  evidence = $state<EvidenceListItem[]>([]);
  tasks = $state<TaskItem[]>([]);
  reviews = $state<ReviewItem[]>([]);
  tasksError = $state<string | null>(null);
  reviewsError = $state<string | null>(null);
  glhLogs = $state<GlhLog[]>([]);
  glhError = $state<string | null>(null);
  loading = $state(true);
  error = $state<string | null>(null);
  saving = $state(false);
  /** Bumped after every change so open criterion popovers re-fetch their list. */
  version = $state(0);
  /** The qualification shown on the Units tab (an enrolment id of the pair). */
  selectedQualId = $state('');

  // The evidence side-sheet (one per portfolio, opened from any tab).
  sheet = $state<{
    open: boolean;
    mode: 'add' | 'view';
    evidenceId: string | null;
    criterionIds: string[];
    /** Set when answering a task: the form opens pre-filled from it. */
    taskId: string | null;
    /** Which enrolment of the pair a NEW piece is added to (its programme owns the criteria being ticked). */
    qualEnrolmentId: string | null;
  }>({
    open: false,
    mode: 'view',
    evidenceId: null,
    criterionIds: [],
    taskId: null,
    qualEnrolmentId: null
  });
  /** The portfolio tab to show (a notification deep-links with ?tab=tasks|reviews; the header chips jump too). */
  tab = $state('overview');

  #reqId = 0;
  #resolved = false;
  #pairId: string | null = null;

  constructor(enrolmentId: string, opts: PortfolioStoreOptions = {}) {
    this.requestedId = enrolmentId;
    this.enrolmentId = enrolmentId;
    this.selectedQualId = enrolmentId;
    this.scoped = opts.scoped === true;
    if (this.scoped) this.tab = 'units';
  }

  /** Every loaded portfolio of the apprenticeship, Diploma first. */
  portfolios = $derived<PortfolioView[]>(
    [this.data, this.pair]
      .filter((p): p is PortfolioView => !!p)
      .sort((a, b) => (a.programme.type === 'STANDARD' ? 1 : 0) - (b.programme.type === 'STANDARD' ? 1 : 0))
  );

  /** The portfolio for the qualification chosen on the Units tab. */
  activePortfolio = $derived<PortfolioView | null>(
    this.portfolios.find((p) => p.enrolment.id === this.selectedQualId) ?? this.data
  );

  /** Look up one loaded portfolio by its enrolment id. */
  portfolioFor(enrolmentId: string | null | undefined): PortfolioView | null {
    return this.portfolios.find((p) => p.enrolment.id === enrolmentId) ?? null;
  }

  #treeOf(p: PortfolioView | null): PickerQualification[] {
    return (p?.qualifications ?? []).map((q) => ({
      id: q.id,
      title: q.title,
      units: q.units.map((u) => ({
        id: u.id,
        code: u.code,
        title: u.title,
        criteria: u.criteria.map((c) => ({ id: c.id, code: c.code, text: c.text }))
      }))
    }));
  }

  /**
   * The programme structure for the evidence sheet: the enrolment a new piece is being added to (Deploy 3 widens the
   * picker to both qualifications of a pair).
   */
  pickerTree = $derived<PickerQualification[]>(
    this.#treeOf(this.portfolioFor(this.sheet.qualEnrolmentId) ?? this.activePortfolio)
  );

  /** The enrolment the evidence sheet saves to. */
  get sheetEnrolmentId(): string {
    if (this.sheet.mode !== 'add') return this.enrolmentId;
    return this.sheet.qualEnrolmentId ?? this.activePortfolio?.enrolment.id ?? this.enrolmentId;
  }

  /** Criteria already met in the programme the sheet is working on. */
  get sheetMetIds(): Set<string> {
    const p = this.portfolioFor(this.sheet.qualEnrolmentId) ?? this.activePortfolio;
    return new Set(
      (p?.qualifications ?? []).flatMap((q) => q.units.flatMap((u) => u.criteria.filter((c) => c.met).map((c) => c.id)))
    );
  }

  async load() {
    const reqId = ++this.#reqId;
    this.loading = this.data === null;

    // Step 1 (first load of a learner portfolio only): resolve carrier + counterpart from the requested id.
    let carrierRes: CallResult<PortfolioView> | null = null;
    let pairRes: CallResult<PortfolioView> | null = null;
    if (!this.scoped && !this.#resolved) {
      const first = await enrolmentsApi.getPortfolio(this.requestedId);
      if (reqId !== this.#reqId) return;
      if (!first.ok) {
        this.loading = false;
        this.error = first.error;
        return;
      }
      const f = first.data as PortfolioView;
      const l = f.linked ?? null;
      if (l && l.role === 'COMPONENT') {
        this.enrolmentId = l.carrierId;
        this.#pairId = f.enrolment.id;
        pairRes = okOf(f);
      } else {
        this.enrolmentId = f.enrolment.id;
        this.#pairId = l ? l.counterpart.enrolmentId : null;
        carrierRes = okOf(f);
      }
      this.#resolved = true;
    }

    const id = this.enrolmentId;
    const fetchPortfolio = (eid: string) => enrolmentsApi.getPortfolio(eid) as Promise<CallResult<PortfolioView>>;
    const [p, pp, e, pe, t, r, g, o] = await Promise.all([
      carrierRes ?? fetchPortfolio(id),
      this.#pairId ? (pairRes ?? fetchPortfolio(this.#pairId)) : Promise.resolve(null),
      evidenceApi.forEnrolment(id),
      this.#pairId && !this.scoped ? evidenceApi.forEnrolment(this.#pairId) : Promise.resolve(null),
      tasksApi.forEnrolment(id),
      this.scoped ? Promise.resolve(null) : reviewsApi.forEnrolment(id),
      this.scoped ? Promise.resolve(null) : gatewayApi.glhLogs(id),
      this.scoped ? Promise.resolve(null) : overviewApi.get(id)
    ]);
    if (reqId !== this.#reqId) return;
    this.loading = false;
    if (p.ok) {
      this.data = p.data;
      this.error = null;
    } else {
      this.error = p.error;
    }
    if (pp?.ok) this.pair = pp.data;
    if (e.ok) {
      // Evidence added on the paired enrolment (e.g. the Standard) is merged in, tagged with where it lives.
      const tag = (items: EvidenceListItem[], qid: string) => items.map((x) => ({ ...x, qualEnrolmentId: qid }));
      const merged = [...tag(e.data, id), ...(pe?.ok && this.#pairId ? tag(pe.data, this.#pairId) : [])];
      const seen = new Set<string>();
      this.evidence = merged
        .filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    // Tasks / reviews fail independently: the rest of the portfolio still works.
    if (t.ok) {
      this.tasks = t.data.items;
      this.tasksError = null;
    } else {
      this.tasksError = t.error;
    }
    if (r) {
      if (r.ok) {
        this.reviews = r.data.items;
        this.reviewsError = null;
      } else {
        this.reviewsError = r.error;
      }
    }
    if (g) {
      if (g.ok) {
        this.glhLogs = g.data.items;
        this.glhError = null;
      } else {
        this.glhError = g.error;
      }
    }
    if (o) {
      if (o.ok) {
        this.overview = o.data;
        this.overviewError = null;
      } else {
        this.overviewError = o.error;
      }
    }
    this.version += 1;
  }

  /** Refetch everything once (after an evidence mutation, whose response carries only the summary). */
  refresh() {
    return this.load();
  }

  #apply(res: { ok: true; data: Portfolio } | { ok: false; error: string }, okMessage: string): boolean {
    if (res.ok) {
      const next = res.data as PortfolioView;
      if (this.pair && next.enrolment.id === this.pair.enrolment.id) this.pair = next;
      else this.data = next;
      this.version += 1;
      snackbar.success(okMessage);
      // The overview roll-ups (cards, bars) come from the same numbers: refresh them quietly.
      if (!this.scoped) {
        overviewApi.get(this.enrolmentId).then((o) => {
          if (o.ok) this.overview = o.data;
        });
      }
      return true;
    }
    snackbar.error(res.error);
    return false;
  }

  /** Edit dates / hours of one enrolment of the pair (default: the carrier, or the only enrolment). */
  async patchEnrolment(body: EnrolmentUpdateBody, enrolmentId: string = this.enrolmentId): Promise<boolean> {
    this.saving = true;
    try {
      return this.#apply(await enrolmentsApi.patch(enrolmentId, body), 'Dates and hours saved');
    } finally {
      this.saving = false;
    }
  }

  async setUnitDates(body: UnitDatesBody, enrolmentId: string = this.enrolmentId): Promise<boolean> {
    this.saving = true;
    try {
      return this.#apply(await enrolmentsApi.putUnitDates(enrolmentId, body), 'Unit dates saved');
    } finally {
      this.saving = false;
    }
  }

  async spread(onlyEmpty: boolean, enrolmentId: string = this.enrolmentId): Promise<boolean> {
    this.saving = true;
    try {
      return this.#apply(await enrolmentsApi.spread(enrolmentId, { onlyEmpty }), 'Unit dates spread');
    } finally {
      this.saving = false;
    }
  }

  // ── Evidence sheet ──
  openEvidence(evidenceId: string) {
    this.sheet = { open: true, mode: 'view', evidenceId, criterionIds: [], taskId: null, qualEnrolmentId: null };
  }

  openNewEvidence(criterionIds: string[] = [], taskId: string | null = null, qualEnrolmentId: string | null = null) {
    if (this.evidenceBlocked) {
      snackbar.error(this.blockedMessage);
      return;
    }
    this.sheet = {
      open: true,
      mode: 'add',
      evidenceId: null,
      criterionIds,
      taskId,
      qualEnrolmentId: qualEnrolmentId ?? this.activePortfolio?.enrolment.id ?? null
    };
  }

  /** Answer a task: add-evidence sheet pre-filled from it (title, type, criteria, taskId). */
  openAnswerTask(task: TaskItem) {
    this.openNewEvidence(
      task.criteria.map((c) => c.id),
      task.id,
      this.portfolioFor(task.enrolmentId) ? task.enrolmentId : null
    );
  }

  /** The gateway has been confirmed: the apprentice is at end-point assessment and cannot add evidence. */
  get gatewayLocked(): boolean {
    return !!this.data?.gateway?.gatewayPassedAt;
  }

  /** The apprentice (not staff) may not add evidence once the gateway is confirmed. */
  get evidenceBlocked(): boolean {
    return this.gatewayLocked && get(isOrgTeamMember) !== true;
  }
  readonly blockedMessage = 'Your apprenticeship is at end-point assessment — speak to your tutor';

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
