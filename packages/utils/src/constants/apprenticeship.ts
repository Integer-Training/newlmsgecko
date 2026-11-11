/**
 * Gecko Apprenticeships — the single CONFIG source for the apprenticeship flow (separate from the diploma /
 * coursework flow). Statuses are plain varchar columns validated against these lists (no Postgres enums), so a
 * value can be added here without a migration. Org-tunable numbers live in `appr_settings`; the defaults below
 * are used until an org saves its own. See docs/APPRENTICESHIP.md.
 */

/** Evidence lifecycle: learner (or staff) submits → tutor accepts or refers back. Only ACCEPTED counts. */
export const APPR_EVIDENCE_STATUSES = ['SUBMITTED', 'ACCEPTED', 'REFERRED'] as const;
export type ApprEvidenceStatus = (typeof APPR_EVIDENCE_STATUSES)[number];

export const APPR_EVIDENCE_STATUS_LABELS: Record<ApprEvidenceStatus, string> = {
  SUBMITTED: 'Submitted',
  ACCEPTED: 'Accepted',
  REFERRED: 'Referred'
};

/** Which evidence statuses count towards criteria/unit/qualification progress and OTJ hours. */
export const APPR_COUNTING_EVIDENCE_STATUSES: readonly ApprEvidenceStatus[] = ['ACCEPTED'];

/** RAG status for a learner, qualification or unit. NOT_SET = no dates yet, so no expected position. */
export const APPR_PROGRESS_STATUSES = ['ON_TARGET', 'BEHIND', 'CONCERN', 'NOT_SET', 'COMPLETE'] as const;
export type ApprProgressStatus = (typeof APPR_PROGRESS_STATUSES)[number];

export const APPR_PROGRESS_STATUS_LABELS: Record<ApprProgressStatus, string> = {
  ON_TARGET: 'On target',
  BEHIND: 'Behind',
  CONCERN: 'Concern',
  NOT_SET: 'Dates not set',
  COMPLETE: 'Complete'
};

/** Evidence notes: AUDIT = system/status trail (who did what, when); GENERAL = free comment. */
export const APPR_NOTE_KINDS = ['AUDIT', 'GENERAL'] as const;
export type ApprNoteKind = (typeof APPR_NOTE_KINDS)[number];

/** Who ticked an evidence→criterion mapping. A tutor's review replaces the learner's proposal. */
export const APPR_MAPPING_SOURCES = ['LEARNER', 'STAFF'] as const;
export type ApprMappingSource = (typeof APPR_MAPPING_SOURCES)[number];

export const APPR_EVIDENCE_TITLE_MAX = 50;
export const APPR_EVIDENCE_DETAILS_MAX = 10000;
export const APPR_NOTE_MAX = 5000;

/** Default evidence types, seeded per org on first use (admin can rename / hide / add). */
export const APPR_DEFAULT_EVIDENCE_TYPES: readonly { key: string; label: string }[] = [
  { key: 'assignment', label: 'Assignment' },
  { key: 'automotive-gateway', label: 'Automotive Gateway' },
  { key: 'behaviours', label: 'Behaviours' },
  { key: 'case-study', label: 'Case Study' },
  { key: 'digital-evidence', label: 'Digital Evidence' },
  { key: 'direct-observation', label: 'Direct Observation' },
  { key: 'employer-reference', label: 'Employer Reference' },
  { key: 'epa-evidence', label: 'EPA Evidence' },
  { key: 'formative-assessment', label: 'Formative Assessment' },
  { key: 'learning-materials', label: 'Learning Materials' },
  { key: 'module-review', label: 'Module Review' },
  { key: 'observation', label: 'Observation' },
  { key: 'oral-question', label: 'Oral Question' },
  { key: 'presentation', label: 'Presentation' },
  { key: 'product-evidence', label: 'Product Evidence' },
  { key: 'professional-discussion', label: 'Professional Discussion' },
  { key: 'rpl', label: 'Recognition of Prior Learning (RPL)' },
  { key: 'reflective-account', label: 'Reflective Account' },
  { key: 'skills', label: 'Skills' },
  { key: 'summative-assessment', label: 'Summative Assessment' },
  { key: 'summative-portfolio-evidence', label: 'Summative Portfolio Evidence' },
  { key: 'witness-testimony', label: 'Witness Testimony' },
  { key: 'written-question', label: 'Written Question' }
];

/** Org-tunable rules (stored in appr_settings; these are the defaults). */
export interface ApprSettings {
  /** Below expected by MORE than this many percentage points = CONCERN; any smaller gap = BEHIND. */
  concernGapPct: number;
  /** Share of contracted hours that is off-the-job training (0.2 = 20%). */
  otjFactor: number;
  /** Contracted hours above this per week do not raise the OTJ target. */
  otjWeeklyCapHours: number;
}

export const APPR_DEFAULT_SETTINGS: ApprSettings = {
  concernGapPct: 15,
  otjFactor: 0.2,
  otjWeeklyCapHours: 30
};

// ── Round 2: task plans, tasks, progress reviews, upload clean-up ──

/** Task status cache, kept in step with the task's latest linked evidence. "Overdue" is computed on read. */
export const APPR_TASK_STATUSES = ['PLANNED', 'SUBMITTED', 'REFERRED', 'COMPLETE'] as const;
export type ApprTaskStatus = (typeof APPR_TASK_STATUSES)[number];
export const APPR_TASK_STATUS_LABELS: Record<ApprTaskStatus, string> = {
  PLANNED: 'Planned',
  SUBMITTED: 'Submitted',
  REFERRED: 'Referred',
  COMPLETE: 'Complete'
};

export const APPR_TASK_PLAN_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type ApprTaskPlanStatus = (typeof APPR_TASK_PLAN_STATUSES)[number];
export const APPR_TASK_TITLE_MAX = 256;
export const APPR_TASK_MONTH_OFFSET_MAX = 120;

/** Review lifecycle. COMPLETE is locked and schedules the next review; CANCELLED is kept for the record. */
export const APPR_REVIEW_STATUSES = ['SCHEDULED', 'DRAFT', 'AWAITING_SIGNATURES', 'COMPLETE', 'CANCELLED'] as const;
export type ApprReviewStatus = (typeof APPR_REVIEW_STATUSES)[number];
export const APPR_REVIEW_STATUS_LABELS: Record<ApprReviewStatus, string> = {
  SCHEDULED: 'Scheduled',
  DRAFT: 'In progress',
  AWAITING_SIGNATURES: 'Awaiting signatures',
  COMPLETE: 'Complete',
  CANCELLED: 'Cancelled'
};
export const APPR_REVIEW_INTERVAL_WEEKS_DEFAULT = 12;
/** Tutors are reminded this many days before a review is due (once). */
export const APPR_REVIEW_DUE_NOTICE_DAYS = 7;
export const APPR_REVIEW_TARGETS_MAX = 20;

/** Uploads not saved on a record (or later removed from one) are deleted from storage after this long. */
export const APPR_UPLOAD_GRACE_HOURS = 24;

// ── Round 2 Deploy 2: GLH and gateway / EPA ──

/** Gateway checklist item kinds: AUTO_* are computed from progress on read; MANUAL are ticked by staff. */
export const APPR_GATEWAY_ITEM_KINDS = ['AUTO_UNITS', 'AUTO_OTJ', 'MANUAL'] as const;
export type ApprGatewayItemKind = (typeof APPR_GATEWAY_ITEM_KINDS)[number];
export interface ApprGatewayItem {
  key: string;
  label: string;
  kind: ApprGatewayItemKind;
}
/** Used when a programme has no checklist of its own (programme setup can edit labels and manual items). */
export const APPR_DEFAULT_GATEWAY_CHECKLIST: readonly ApprGatewayItem[] = [
  { key: 'units', label: 'All units complete', kind: 'AUTO_UNITS' },
  { key: 'otj', label: 'Off-the-job hours target met', kind: 'AUTO_OTJ' },
  { key: 'english', label: 'English achieved', kind: 'MANUAL' },
  { key: 'maths', label: 'Maths achieved', kind: 'MANUAL' },
  { key: 'employer', label: 'Employer sign-off', kind: 'MANUAL' },
  { key: 'tutor', label: 'Tutor sign-off', kind: 'MANUAL' }
];
export const APPR_GATEWAY_ITEMS_MAX = 20;

export const APPR_EPA_RESULTS = ['PASS', 'MERIT', 'DISTINCTION', 'FAIL'] as const;
export type ApprEpaResult = (typeof APPR_EPA_RESULTS)[number];
export const APPR_EPA_RESULT_LABELS: Record<ApprEpaResult, string> = {
  PASS: 'Pass',
  MERIT: 'Merit',
  DISTINCTION: 'Distinction',
  FAIL: 'Fail'
};
/** Results that complete the apprenticeship (sets achieved_at). */
export const APPR_EPA_ACHIEVING_RESULTS: readonly ApprEpaResult[] = ['PASS', 'MERIT', 'DISTINCTION'];

/** Where a learner is on the road to the end-point assessment (computed on read). */
export const APPR_STAGES = [
  'IN_LEARNING',
  'READY_FOR_GATEWAY',
  'AT_GATEWAY',
  'EPA_BOOKED',
  'ACHIEVED',
  'EPA_FAILED'
] as const;
export type ApprStage = (typeof APPR_STAGES)[number];
export const APPR_STAGE_LABELS: Record<ApprStage, string> = {
  IN_LEARNING: 'In learning',
  READY_FOR_GATEWAY: 'Ready for gateway',
  AT_GATEWAY: 'At gateway',
  EPA_BOOKED: 'EPA booked',
  ACHIEVED: 'Achieved',
  EPA_FAILED: 'EPA not passed'
};
/** One staff GLH log entry is capped at a day. */
export const APPR_GLH_LOG_MAX_MINUTES = 24 * 60;

// ── Onboarding documents (uploaded by the apprentice after receiving their login) ──

export const APPR_ONBOARDING_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED'] as const;
export type ApprOnboardingStatus = (typeof APPR_ONBOARDING_STATUSES)[number];
export const APPR_ONBOARDING_STATUS_LABELS: Record<ApprOnboardingStatus, string> = {
  SUBMITTED: 'Waiting for review',
  APPROVED: 'Approved',
  REJECTED: 'Needs re-upload'
};
export const APPR_ONBOARDING_FILES_MAX = 10;
export const APPR_ONBOARDING_LABEL_MAX = 120;
export const APPR_ONBOARDING_TYPES_MAX = 50;

/** Seeded for an org the first time its onboarding types are read. Admins edit them in Apprenticeships › Settings. */
export const APPR_DEFAULT_ONBOARDING_DOC_TYPES: readonly {
  label: string;
  description: string;
  required: boolean;
  allowNotHeld: boolean;
}[] = [
  { label: 'Photo ID', description: 'Passport or photocard driving licence.', required: true, allowNotHeld: false },
  {
    label: 'Proof of National Insurance number',
    description: 'NI card, payslip or a letter from HMRC/DWP showing your NI number.',
    required: true,
    allowNotHeld: false
  },
  {
    label: 'Proof of address',
    description: 'Utility bill, bank statement or council tax bill dated within the last 3 months.',
    required: true,
    allowNotHeld: false
  },
  {
    label: 'Right to work',
    description: 'UK/Irish passport, or your share code / visa / biometric residence permit.',
    required: true,
    allowNotHeld: false
  },
  {
    label: 'English and maths certificates',
    description: 'GCSE or Functional Skills certificates. If you do not have them, tick "I don\'t have this".',
    required: true,
    allowNotHeld: true
  },
  {
    label: 'Other qualification certificates',
    description: 'Any other relevant qualifications (optional).',
    required: false,
    allowNotHeld: false
  },
  {
    label: 'Signed apprenticeship agreement',
    description: 'The apprenticeship agreement signed by you and your employer.',
    required: true,
    allowNotHeld: false
  },
  {
    label: 'Signed commitment statement / training plan',
    description: 'The training plan signed by you, your employer and the provider.',
    required: true,
    allowNotHeld: false
  },
  {
    label: 'Learning support evidence',
    description: 'EHCP, diagnosis letter or similar, if you would like extra support (optional).',
    required: false,
    allowNotHeld: false
  }
];

// ── Round 2 Deploy 3: IQA sampling ──

/** IQA sample outcome. DISAGREE never changes the evidence status; an admin may refer the evidence separately. */
export const APPR_IQA_OUTCOMES = ['PENDING', 'AGREE', 'DISAGREE'] as const;
export type ApprIqaOutcome = (typeof APPR_IQA_OUTCOMES)[number];
export const APPR_IQA_OUTCOME_LABELS: Record<ApprIqaOutcome, string> = {
  PENDING: 'Pending',
  AGREE: 'Agree',
  DISAGREE: 'Disagree'
};
/** Default share of each assessor's accepted evidence to sample (appr_settings.iqa_target_pct). */
export const APPR_IQA_TARGET_PCT_DEFAULT = 10;
/** Most samples one "Suggest sample" run may create. */
export const APPR_IQA_SUGGEST_MAX = 100;
export const APPR_IQA_FEEDBACK_MAX = 5000;
