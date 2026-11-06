import { snackbar } from '$features/ui/snackbar/store';
import { enrolmentsApi, type EnrolmentUpdateBody, type Portfolio, type UnitDatesBody } from '../api/enrolments.svelte';
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
  loading = $state(true);
  error = $state<string | null>(null);
  saving = $state(false);
  /** Bumped after every change so open criterion popovers re-fetch their list. */
  version = $state(0);

  // The evidence side-sheet (one per portfolio, opened from any tab).
  sheet = $state<{ open: boolean; mode: 'add' | 'view'; evidenceId: string | null; criterionIds: string[] }>({
    open: false,
    mode: 'view',
    evidenceId: null,
    criterionIds: []
  });

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
    const [p, e] = await Promise.all([
      enrolmentsApi.getPortfolio(this.enrolmentId),
      evidenceApi.forEnrolment(this.enrolmentId)
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
    this.sheet = { open: true, mode: 'view', evidenceId, criterionIds: [] };
  }

  openNewEvidence(criterionIds: string[] = []) {
    this.sheet = { open: true, mode: 'add', evidenceId: null, criterionIds };
  }

  closeSheet() {
    this.sheet = { ...this.sheet, open: false };
  }
}
