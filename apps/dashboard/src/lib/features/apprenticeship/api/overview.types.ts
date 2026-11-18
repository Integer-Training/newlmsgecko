// Gecko Apprenticeships — FROZEN shapes for the Deploy 2 overview, linked-enrolment and learner-check payloads.
// Mirrors plan §5.2 "Overview payload" and §4 "Deploy 2 — enrolment, link, overview". The API (overview.ts service,
// enrolment.ts service) produces these; the dashboard never recomputes any number.
import type {
  ApprEnrolmentRole,
  ApprProgrammeType,
  ApprProgressStatus,
  ApprStage
} from '@cio/utils/constants/apprenticeship';
import type { TutorsInput } from './enrolments.svelte';

export interface OverviewRollup {
  actualPct: number | null;
  status: ApprProgressStatus;
}

export interface OverviewUnit {
  id: string;
  title: string;
  actualPct: number | null;
  status: ApprProgressStatus;
}

/** One qualification (enrolment) of the apprenticeship. */
export interface OverviewCard {
  enrolmentId: string;
  programmeId: string;
  title: string;
  type: ApprProgrammeType;
  level: string | null;
  startDate: string | null;
  plannedEndDate: string | null;
  actualPct: number | null;
  expectedPct: number | null;
  status: ApprProgressStatus;
  unitsTotal: number;
  unitsComplete: number;
  achievedAt: string | null;
  /** Set when this qualification is withdrawn (Deploy 5). */
  withdrawnAt: string | null;
  withdrawalReason?: string | null;
  role: ApprEnrolmentRole;
  units: OverviewUnit[];
}

export interface OverviewBreakdown {
  tasks: { PLANNED: number; SUBMITTED: number; REFERRED: number; COMPLETE: number; overdue: number };
  evidence: { SUBMITTED: number; ACCEPTED: number; REFERRED: number };
  otj: { SUBMITTED: number; VALIDATED: number; REJECTED: number };
}

export interface OverviewOtj {
  doneMinutes: number;
  expectedMinutes: number | null;
  targetMinutes: number | null;
  completionPct: number | null;
  status: ApprProgressStatus;
}

export interface OverviewPayload {
  learner: { id: string; name: string; email: string | null };
  tutors: TutorsInput;
  overall: OverviewRollup;
  cards: OverviewCard[];
  breakdown: OverviewBreakdown;
  otj: OverviewOtj;
  nextReview: { id: string; scheduledDate: string; status: string } | null;
  stage: ApprStage | null;
  onboarding: { approved: number; required: number };
  /** Diploma-only learner whose diploma has a paired Standard: offer "Add the paired standard". */
  canAddPair: { programmeId: string; title: string } | null;
}

// ── Enrolment list rows (GET /enrolments) additions ──

export interface EnrolmentLinked {
  id: string;
  programmeId: string;
  programmeTitle: string;
  type: ApprProgrammeType;
  actualPct: number | null;
  expectedPct: number | null;
  status: ApprProgressStatus;
}

/** Fields added to EnrolmentRow by Deploy 2. */
export interface EnrolmentRowLinkAdditions {
  programmeType: ApprProgrammeType;
  linked: EnrolmentLinked | null;
  overall: OverviewRollup;
}

// ── Portfolio (GET /enrolments/:id/portfolio) additions ──

export interface PortfolioLinked {
  role: Extract<ApprEnrolmentRole, 'CARRIER' | 'COMPONENT'>;
  carrierId: string;
  counterpart: {
    enrolmentId: string;
    programmeId: string;
    title: string;
    type: ApprProgrammeType;
    withdrawnAt?: string | null;
  };
}

/** Fields added to the portfolio payload by Deploy 2 (`programme.type` plus `linked`). */
export interface PortfolioLinkAdditions {
  programme: { type: ApprProgrammeType };
  linked: PortfolioLinked | null;
}

// ── POST /enrolments/apprenticeship response ──

export interface ApprenticeshipCreateResult {
  learnerId: string;
  enrolments: { id: string; programmeId: string; role: ApprEnrolmentRole }[];
  temporaryPassword?: string;
}

// ── GET /enrolments/learner-check response ──

export interface LearnerCheckResult {
  exists: boolean;
  learnerId?: string;
  apprenticeship: {
    enrolmentId: string;
    programmeId: string;
    programmeTitle: string;
    type: ApprProgrammeType;
    level: string | null;
    /** e.g. 'active' | 'achieved' (and 'withdrawn' from Deploy 5). */
    state: string;
  }[];
  regularCourses: number;
}
