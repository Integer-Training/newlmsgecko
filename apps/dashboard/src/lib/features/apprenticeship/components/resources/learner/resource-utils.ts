import { APPR_EVIDENCE_TITLE_MAX } from '@cio/utils/constants/apprenticeship';
import type { PickerQualification } from '../../../api/evidence.svelte';
import type {
  LearnerResourceItem,
  ResourceKind,
  ResourceProgramme,
  ResourceStatus
} from '../../../api/resources-learner.svelte';

// Pure helpers for the learner resources screens (grouping, filtering, labels, evidence prefill). No I/O.

export type KindFilter = 'ALL' | ResourceKind;

export const STATUS_LABELS: Record<ResourceStatus, string> = {
  NOT_STARTED: 'Not started',
  VIEWED: 'Viewed',
  DOWNLOADED: 'Downloaded',
  SUBMITTED: 'Submitted',
  REFERRED: 'Referred back',
  ACCEPTED: 'Accepted'
};

export const STATUS_CLASSES: Record<ResourceStatus, string> = {
  NOT_STARTED: 'bg-(--muted) text-(--muted-foreground)',
  VIEWED: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300',
  DOWNLOADED: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300',
  SUBMITTED: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  REFERRED: 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300',
  ACCEPTED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300'
};

export type FileFamily = 'pdf' | 'word' | 'sheet' | 'slides' | 'other';

export function fileFamily(r: Pick<LearnerResourceItem, 'file'>): FileFamily {
  const name = r.file.name.toLowerCase();
  const type = r.file.type.toLowerCase();
  if (type.includes('pdf') || name.endsWith('.pdf')) return 'pdf';
  if (type.includes('word') || /\.docx?$/.test(name)) return 'word';
  if (type.includes('sheet') || type.includes('excel') || /\.xlsx?$/.test(name)) return 'sheet';
  if (type.includes('presentation') || /\.pptx?$/.test(name)) return 'slides';
  return 'other';
}

/** Only PDF and .docx can be shown inline; anything else (xlsx, pptx, legacy .doc) is download-only. */
export function canPreview(r: Pick<LearnerResourceItem, 'file'>): boolean {
  const name = r.file.name.toLowerCase();
  return fileFamily(r) === 'pdf' || name.endsWith('.docx');
}

export function matchesQuery(r: LearnerResourceItem, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [r.title, r.description ?? '', r.file.name, r.unitTitle ?? '', r.unitCode ?? '']
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

export interface ResourceGroup {
  /** Unit id, or null for the programme-wide "General" group. */
  unitId: string | null;
  label: string;
  items: LearnerResourceItem[];
}

export interface ProgrammeSection {
  enrolmentId: string;
  title: string;
  type: ResourceProgramme['type'];
  withdrawn: boolean;
  groups: ResourceGroup[];
  count: number;
}

/**
 * Programme → "General" → units (in portfolio order, `unitOrder` = the unit ids of that programme as the portfolio lists
 * them; units not found there go last). Empty groups and empty programmes are dropped.
 */
export function buildSections(
  programmes: ResourceProgramme[],
  resources: LearnerResourceItem[],
  unitOrderOf: (programmeId: string) => string[]
): ProgrammeSection[] {
  const sections: ProgrammeSection[] = [];
  for (const p of programmes) {
    const mine = resources.filter((r) => r.programmeId === p.programmeId);
    if (mine.length === 0) continue;
    const byUnit = new Map<string, LearnerResourceItem[]>();
    const general: LearnerResourceItem[] = [];
    for (const r of mine) {
      if (!r.unitId) general.push(r);
      else byUnit.set(r.unitId, [...(byUnit.get(r.unitId) ?? []), r]);
    }
    const order = unitOrderOf(p.programmeId);
    const rank = (id: string) => {
      const i = order.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const bySort = (a: LearnerResourceItem, b: LearnerResourceItem) =>
      a.sort - b.sort || a.title.localeCompare(b.title);
    const groups: ResourceGroup[] = [];
    if (general.length > 0) groups.push({ unitId: null, label: 'General', items: general.sort(bySort) });
    for (const [unitId, items] of [...byUnit.entries()].sort((a, b) => rank(a[0]) - rank(b[0]))) {
      const first = items[0];
      const label = [first.unitCode, first.unitTitle].filter(Boolean).join(' · ') || 'Unit';
      groups.push({ unitId, label, items: items.sort(bySort) });
    }
    sections.push({
      enrolmentId: p.enrolmentId,
      title: p.title,
      type: p.type,
      withdrawn: p.withdrawn,
      groups,
      count: mine.length
    });
  }
  return sections;
}

/** The suggested criteria the picker can actually show (withdrawn qualifications' criteria are never offered). */
export function pickableCriteria(criterionIds: string[], tree: PickerQualification[]): string[] {
  const allowed = new Set(
    tree.filter((q) => !q.withdrawn).flatMap((q) => q.units.flatMap((u) => u.criteria.map((c) => c.id)))
  );
  return criterionIds.filter((id) => allowed.has(id));
}

export function evidenceTitleFor(title: string): string {
  return title.trim().slice(0, APPR_EVIDENCE_TITLE_MAX);
}
