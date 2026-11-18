import type { ApprProgressStatus, ApprStage } from '@cio/utils/constants/apprenticeship';
import { classroomio } from '$lib/utils/services/api';
import { BaseApi } from '$lib/utils/services/api/base.svelte';
import { snackbar } from '$features/ui/snackbar/store';
import { call, type CallResult } from './call';
import type { ApprProgrammeType } from '@cio/utils/constants/apprenticeship';
import type { ApprenticeshipCreateResult, EnrolmentLinked, LearnerCheckResult, OverviewRollup } from './overview.types';
import type { GatewayView, GlhSummary } from './gateway.svelte';

// Gecko Apprenticeships — admin client for the learners table, enrolment and the portfolio payload. Shapes mirror
// apps/api/src/services/apprenticeship/enrolment.ts. All numbers (actual / expected %, status, OTJ) are the API's;
// this client never recomputes them.

/** Tutors as the API sends them: objects ('PROGRAMME' kind = assigned to the programme, not named) or plain names. */
export type TutorsInput =
  | { id: string; name: string | null; kind?: 'NAMED' | 'PROGRAMME' }[]
  | string[]
  | null
  | undefined;

export interface EnrolmentRow {
  id: string;
  programmeId: string;
  programmeTitle: string;
  learner: { id: string; name: string; email: string | null };
  tutors: TutorsInput;
  /** Required onboarding documents approved / required; null or required 0 = nothing to approve. */
  onboarding?: { required: number; approved: number; submitted: number; rejected: number } | null;
  startDate: string | null;
  plannedEndDate: string | null;
  achievedAt: string | null;
  actualPct: number | null;
  expectedPct: number | null;
  status: ApprProgressStatus;
  statusLabel: string;
  otj: {
    minutes: number;
    targetMinutes: number | null;
    expectedMinutes: number | null;
    status: ApprProgressStatus;
  };
  toMark: number;
  acceptedCount: number;
  referredCount: number;
  overdueTaskCount?: number;
  nextReview?: { id: string; scheduledDate: string; status: string } | null;
  reviewOverdue?: boolean;
  glh?: GlhSummary;
  stage?: ApprStage;
  stageLabel?: string;
  gatewayReady?: boolean;
  /** Deploy 2: carrier programme type, the linked (paired) enrolment and the combined progress. */
  programmeType?: ApprProgrammeType;
  linked?: EnrolmentLinked | null;
  overall?: OverviewRollup;
  /** Deploy 5: set when withdrawn. */
  withdrawnAt?: string | null;
  withdrawalReason?: string | null;
}

export interface EnrolmentList {
  items: EnrolmentRow[];
  total: number;
  page: number;
  pageSize: number;
  statusCounts: Record<ApprProgressStatus, number>;
}

export type EnrolmentState = 'active' | 'withdrawn' | 'all';
export type WithdrawScope = 'THIS' | 'BOTH';

export interface EnrolmentFilters {
  programmeId?: string;
  type?: ApprProgrammeType | 'BOTH';
  tutorId?: string;
  status?: ApprProgressStatus;
  search?: string;
  /** Only learners with neither a named nor a programme tutor. */
  noTutor?: boolean;
  /** 'incomplete' = required onboarding documents not all approved. */
  onboarding?: 'incomplete';
  /** Deploy 5: default (omitted) = active. */
  state?: EnrolmentState;
  page: number;
  pageSize: number;
}

export interface ProgressSummary {
  actualPct: number | null;
  expectedPct: number | null;
  status: ApprProgressStatus;
  otj: {
    targetMinutes: number | null;
    expectedMinutes: number | null;
    minutes: number;
    status: ApprProgressStatus;
  };
  counts: { submitted: number; accepted: number; referred: number };
  /** Tasks / reviews round 2 — absent until the API provides them. */
  overdueTaskCount?: number;
  nextReview?: { id: string; scheduledDate: string; status: string } | null;
  reviewOverdue?: boolean;
  glh?: GlhSummary;
  stage?: ApprStage;
  stageLabel?: string;
  gatewayReady?: boolean;
}

export interface PortfolioCriterion {
  id: string;
  code: string;
  text: string;
  groupLabel: string | null;
  requiredCount: number;
  acceptedCount: number;
  met: boolean;
  evidenceCount: number;
  pendingCount: number;
  achievedAt: string | null;
}

export interface PortfolioUnit {
  id: string;
  code: string | null;
  title: string;
  startDate: string | null;
  targetDate: string | null;
  actualPct: number | null;
  expectedPct: number | null;
  achievedAt: string | null;
  status: ApprProgressStatus;
  criteria: PortfolioCriterion[];
}

export interface PortfolioQualification {
  id: string;
  title: string;
  reference: string | null;
  awardingBody: string | null;
  level: string | null;
  actualPct: number | null;
  /** Deploy 5: set when this qualification is withdrawn (its criteria are not offered for new mappings). */
  withdrawnAt?: string | null;
  units: PortfolioUnit[];
}

export interface Portfolio {
  enrolment: {
    id: string;
    programmeId: string;
    learnerId: string;
    startDate: string | null;
    plannedEndDate: string | null;
    contractedHoursWeek: number | null;
    otjTargetMinutesOverride: number | null;
    achievedAt: string | null;
    recomputedAt: string | null;
    /** Deploy 5 */
    withdrawnAt?: string | null;
    withdrawalReason?: string | null;
    /** Every half of the apprenticeship is withdrawn (a lone enrolment, or both halves): read-only for everyone. */
    apprenticeshipClosed?: boolean;
  };
  learner: { id: string; name: string; email: string | null };
  programme: { id: string; title: string; reference: string | null; level: string | null };
  tutors: TutorsInput;
  summary: ProgressSummary;
  gateway?: GatewayView;
  qualifications: PortfolioQualification[];
}

export interface EnrolmentCreateBody {
  programmeId: string;
  learner: { learnerId: string } | { firstName: string; lastName: string; email: string };
  tutorId: string;
  startDate: string;
  plannedEndDate: string;
  contractedHoursWeek?: number | null;
  otjTargetMinutesOverride?: number | null;
}

export interface EnrolmentUpdateBody {
  startDate?: string;
  plannedEndDate?: string;
  contractedHoursWeek?: number | null;
  otjTargetMinutesOverride?: number | null;
}

export interface UnitDatesBody {
  units: { unitId: string; startDate: string | null; targetDate: string | null }[];
}

export interface ProgrammeOption {
  id: string;
  title: string;
  status?: string;
  type?: ApprProgrammeType;
  level?: string | null;
  levelNumber?: number | null;
  tutorNames?: string[];
  pairedProgramme?: { id: string; title: string; level: string | null } | null;
}

export interface ApprenticeshipCreateBody {
  learner: { learnerId: string } | { firstName: string; lastName: string; email: string };
  tutorId: string;
  contractedHoursWeek?: number | null;
  otjTargetMinutesOverride?: number | null;
  enrolments: { programmeId: string; startDate: string; plannedEndDate: string }[];
}
export interface TutorOption {
  id: string;
  name: string | null;
  email: string | null;
}
export interface LearnerOption {
  userId: string;
  name: string | null;
  email: string | null;
}

/** Tutor names for display, whichever shape the API sends. Programme tutors read "Name (programme)". */
export function tutorNames(tutors: TutorsInput | Portfolio['tutors']): string {
  const names = ((tutors ?? []) as (string | { name: string | null; kind?: string })[])
    .map((t) => {
      if (typeof t === 'string') return t;
      if (!t?.name) return '';
      return t.kind === 'PROGRAMME' ? `${t.name} (programme)` : t.name;
    })
    .filter(Boolean);
  return names.length ? names.join(', ') : '—';
}

/** The tutor id (when the API sends objects) used to pre-select the tutor filter / chip. */
export function tutorIds(tutors: EnrolmentRow['tutors'] | null | undefined): string[] {
  return ((tutors ?? []) as (string | { id?: string })[])
    .map((t) => (typeof t === 'string' ? '' : (t?.id ?? '')))
    .filter(Boolean);
}

class EnrolmentsApi extends BaseApi {
  list = $state<EnrolmentList | null>(null);
  listError = $state<string | null>(null);
  programmes = $state<ProgrammeOption[]>([]);
  tutors = $state<TutorOption[]>([]);
  learners = $state<LearnerOption[]>([]);
  optionsLoaded = $state(false);
  // Monotonic id so a slow earlier filter response can't overwrite a newer one.
  #reqId = 0;

  async load(filters: EnrolmentFilters) {
    const reqId = ++this.#reqId;
    const query: Record<string, string> = { page: String(filters.page), pageSize: String(filters.pageSize) };
    if (filters.programmeId) query.programmeId = filters.programmeId;
    if (filters.type) query.type = filters.type;
    if (filters.tutorId) query.tutorId = filters.tutorId;
    if (filters.status) query.status = filters.status;
    if (filters.search?.trim()) query.search = filters.search.trim();
    if (filters.noTutor) query.noTutor = 'true';
    if (filters.onboarding) query.onboarding = filters.onboarding;
    if (filters.state && filters.state !== 'active') query.state = filters.state;
    this.isLoading = true;
    const res = await call<EnrolmentList>(() => classroomio.apprenticeship.enrolments.$get({ query }));
    if (reqId !== this.#reqId) return;
    this.isLoading = false;
    if (res.ok) {
      this.list = res.data;
      this.listError = null;
    } else {
      this.listError = res.error;
    }
  }

  /**
   * Pickers for the Add-learner dialog and the filters (programmes, tutors, existing learners). A tutor (Phase B) only
   * needs the programme filter — the tutor / learner pickers are admin-only. Names are the account's full name.
   */
  async loadOptions(isAdmin = true) {
    if (!isAdmin) {
      const p = await call<ProgrammeOption[]>(() =>
        classroomio.apprenticeship.programmes.$get({ query: { status: 'ACTIVE' } })
      );
      if (p.ok) this.programmes = p.data;
      this.optionsLoaded = true;
      return;
    }
    type Person = { id: string; name: string | null; email: string | null };
    const [p, o] = await Promise.all([
      call<ProgrammeOption[]>(() => classroomio.apprenticeship.programmes.$get({ query: { status: 'ACTIVE' } })),
      call<{ tutors: Person[]; learners: Person[] }>(() => classroomio.apprenticeship.enrolments.options.$get())
    ]);
    if (p.ok) this.programmes = p.data;
    if (o.ok) {
      this.tutors = o.data.tutors;
      this.learners = o.data.learners.map((l) => ({ userId: l.id, name: l.name, email: l.email }));
    }
    this.optionsLoaded = true;
  }

  create(body: EnrolmentCreateBody): Promise<CallResult<{ id: string; temporaryPassword?: string }>> {
    return call(() => classroomio.apprenticeship.enrolments.$post({ json: body }));
  }

  createApprenticeship(body: ApprenticeshipCreateBody): Promise<CallResult<ApprenticeshipCreateResult>> {
    return call(() => classroomio.apprenticeship.enrolments.apprenticeship.$post({ json: body }));
  }

  learnerCheck(q: { learnerId?: string; email?: string }): Promise<CallResult<LearnerCheckResult>> {
    const query: Record<string, string> = {};
    if (q.learnerId) query.learnerId = q.learnerId;
    if (q.email) query.email = q.email;
    return call(() => classroomio.apprenticeship.enrolments['learner-check'].$get({ query }));
  }

  // Deploy 5: withdraw (THIS | BOTH) and reinstate.
  withdraw(id: string, body: { reason: string; scope: WithdrawScope }): Promise<CallResult<unknown>> {
    return call(() => classroomio.apprenticeship.enrolments[':id'].withdraw.$post({ param: { id }, json: body }));
  }

  reinstate(id: string): Promise<CallResult<unknown>> {
    return call(() => classroomio.apprenticeship.enrolments[':id'].reinstate.$post({ param: { id } }));
  }

  getPortfolio(id: string): Promise<CallResult<Portfolio>> {
    return call(() => classroomio.apprenticeship.enrolments[':id'].portfolio.$get({ param: { id } }));
  }

  patch(id: string, body: EnrolmentUpdateBody): Promise<CallResult<Portfolio>> {
    return call(() => classroomio.apprenticeship.enrolments[':id'].$patch({ param: { id }, json: body }));
  }

  putUnitDates(id: string, body: UnitDatesBody): Promise<CallResult<Portfolio>> {
    return call(() => classroomio.apprenticeship.enrolments[':id']['unit-dates'].$put({ param: { id }, json: body }));
  }

  spread(id: string, body: { onlyEmpty: boolean }): Promise<CallResult<Portfolio>> {
    return call(() =>
      classroomio.apprenticeship.enrolments[':id']['unit-dates'].spread.$post({ param: { id }, json: body })
    );
  }

  /** Download the portfolio CSV (the API builds it; we only hand the bytes to the browser). */
  async exportCsv(id: string): Promise<boolean> {
    try {
      const res = await classroomio.apprenticeship.enrolments[':id']['export.csv'].$get({
        param: { id },
        query: {}
      });
      if (!res.ok) {
        snackbar.error('Could not export the portfolio.');
        return false;
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') ?? '';
      const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'portfolio.csv';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    } catch {
      snackbar.error('Could not export the portfolio.');
      return false;
    }
  }
}

export const enrolmentsApi = new EnrolmentsApi();
