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
