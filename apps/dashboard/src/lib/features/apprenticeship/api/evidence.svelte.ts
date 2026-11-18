import axios from 'axios';
import { classroomio } from '$lib/utils/services/api';
import { snackbar } from '$features/ui/snackbar/store';
import { call, type CallResult } from './call';
import type { ApprProgrammeType } from '@cio/utils/constants/apprenticeship';
import type { ProgressSummary, TutorsInput } from './enrolments.svelte';

// Gecko Apprenticeships — admin client for evidence: list / detail / create / edit / review / notes, file upload
// (presign → PUT → list on the row) and the marking queue. Shapes mirror apps/api/src/services/apprenticeship/evidence.ts.
// Every mutation returns the learner's fresh `summary`; the portfolio store refetches the full payload from it.

export interface EvidenceFile {
  key: string;
  name: string;
  size?: number;
  type?: string;
  uploadedBy?: string;
  uploadedAt?: string;
}

/** One qualification a piece of evidence is mapped to (Deploy 3: a piece can count towards both of a linked pair). */
export interface MappedQualification {
  enrolmentId: string;
  programmeId: string;
  type: ApprProgrammeType;
  title: string;
  criterionCodes: string[];
}

/** The mapped qualifications other than the one the evidence lives on ("Also counts towards"). */
export function alsoCountsTowards(homeEnrolmentId: string | null | undefined, mapped?: MappedQualification[] | null) {
  return (mapped ?? []).filter((m) => m.enrolmentId !== homeEnrolmentId && m.criterionCodes.length > 0);
}

/** Which qualifications a set of criterion ids falls in, read from a picker tree (used when the API sends no list). */
export function mappedFromTree(tree: PickerQualification[], criterionIds: Iterable<string>): MappedQualification[] {
  const ids = new Set(criterionIds);
  return tree
    .filter((q) => q.type && q.enrolmentId && q.programmeId)
    .map((q) => ({
      enrolmentId: q.enrolmentId!,
      programmeId: q.programmeId!,
      type: q.type!,
      title: q.title,
      criterionCodes: q.units.flatMap((u) => u.criteria.filter((c) => ids.has(c.id)).map((c) => c.code))
    }))
    .filter((m) => m.criterionCodes.length > 0);
}

export interface EvidenceListItem {
  id: string;
  title: string;
  typeKey: string;
  typeLabel: string | null;
  status: string;
  minutes: number;
  includeOtj: boolean;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  reviewedBy?: string | null;
  reviewedByName?: string | null;
  reviewedAt?: string | null;
  criteriaCount: number;
  fileCount: number;
  /** The enrolment the evidence lives on; for a linked enrolment the list holds the pair's evidence. */
  homeEnrolmentId?: string;
  mappedQualifications?: MappedQualification[];
  /** Set client-side by the portfolio store (= homeEnrolmentId, or the enrolment the list was fetched for). */
  qualEnrolmentId?: string;
}

export interface CriterionEvidenceItem {
  id: string;
  title: string;
  snippet: string;
  status: string;
  fileCount: number;
  createdAt: string;
  /** Set when the evidence lives on the other qualification of the pair. */
  homeEnrolmentId?: string;
  homeType?: ApprProgrammeType;
}

export interface CriterionEvidence {
  items: CriterionEvidenceItem[];
  taskCount: number | null;
}

export interface EvidenceNote {
  id: string;
  authorId: string | null;
  authorName: string | null;
  kind: 'AUDIT' | 'GENERAL';
  body: string;
  statusAtTime: string | null;
  createdAt: string;
}

export interface EvidenceDetail {
  evidence: {
    id: string;
    learnerId: string;
    programmeId: string;
    title: string;
    details: string;
    typeKey: string;
    typeLabel: string;
    minutes: number;
    includeOtj: boolean;
    status: string;
    statusLabel: string;
    files: EvidenceFile[];
    /** The task this answers, if any. */
    taskId?: string | null;
    createdAt: string;
    createdBy: string | null;
  };
  criteria: {
    id: string;
    title: string;
    units: {
      id: string;
      code: string | null;
      title: string;
      criteria: { id: string; code: string; text: string; groupLabel: string | null; source: string }[];
    }[];
  }[];
  notes: EvidenceNote[];
  /** The learner's enrolment for this evidence — lets a sheet opened outside a portfolio still upload files. */
  enrolmentId: string | null;
  /** Qualifications the evidence is mapped to (optional: the sheet falls back to the picker tree). */
  mappedQualifications?: MappedQualification[];
  permissions: { canEdit: boolean; canReview: boolean };
}

export interface EvidenceType {
  id?: string;
  key: string;
  label: string;
  active: boolean;
}

export interface ToMarkItem {
  id: string;
  title: string;
  createdAt: string;
  learnerId: string;
  learnerName: string | null;
  programmeId: string;
  programmeTitle: string;
  criteriaCount: number;
  typeKey?: string;
  typeLabel?: string | null;
  /** When it was (re)submitted for marking. */
  submittedAt?: string;
  taskId?: string | null;
  taskTitle?: string | null;
  taskDueDate?: string | null;
  tutors: TutorsInput;
}

export interface ToMarkPage {
  items: ToMarkItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface EvidenceCreateBody {
  title: string;
  details: string;
  typeKey: string;
  minutes: number;
  includeOtj: boolean;
  criterionIds: string[];
  files: { key: string; name: string; size?: number; type?: string }[];
  status?: 'SUBMITTED' | 'ACCEPTED';
  evidenceId?: string;
  taskId?: string;
  note?: { body: string; kind: 'AUDIT' | 'GENERAL' };
}

export type EvidenceUpdateBody = Partial<Omit<EvidenceCreateBody, 'status' | 'evidenceId'>> & {
  note?: { body: string; kind: 'AUDIT' | 'GENERAL' };
};

export interface EvidenceMutation {
  evidence: { id: string };
  summary: ProgressSummary | null;
}

/** qualification → unit → criterion tree used by the criteria picker (portfolio and programme-tree both fit). */
export interface PickerQualification {
  id: string;
  title: string;
  /** Set for a linked pair: which qualification of the apprenticeship this is (drives the picker tabs). */
  type?: ApprProgrammeType;
  enrolmentId?: string;
  programmeId?: string;
  /** Withdrawn qualification: the picker offers none of its criteria for NEW mappings (existing ones stay). */
  withdrawn?: boolean;
  units: {
    id: string;
    code: string | null;
    title: string;
    criteria: { id: string; code: string; text: string }[];
  }[];
}

export interface UploadedFile {
  key: string;
  name: string;
  size: number;
  type: string;
}

class EvidenceApi {
  types = $state<EvidenceType[]>([]);
  typesLoaded = $state(false);

  async loadTypes(force = false) {
    if (this.typesLoaded && !force) return;
    const res = await call<{ evidenceTypes: EvidenceType[] }>(() => classroomio.apprenticeship.settings.$get());
    if (res.ok) {
      this.types = res.data.evidenceTypes;
      this.typesLoaded = true;
    }
  }

  forEnrolment(enrolmentId: string, filter: { status?: string; typeKey?: string } = {}) {
    const query: Record<string, string> = {};
    if (filter.status) query.status = filter.status;
    if (filter.typeKey) query.typeKey = filter.typeKey;
    return call<EvidenceListItem[]>(() =>
      classroomio.apprenticeship.evidence.enrolments[':id'].evidence.$get({ param: { id: enrolmentId }, query })
    );
  }

  /** Evidence on a criterion (either side of a pair) plus the task count; tolerates the older bare-array response. */
  async forCriterion(criterionId: string, enrolmentId: string): Promise<CallResult<CriterionEvidence>> {
    const res = await call<CriterionEvidenceItem[] | { items: CriterionEvidenceItem[]; taskCount?: number }>(() =>
      classroomio.apprenticeship.evidence.criteria[':criterionId'].evidence.$get({
        param: { criterionId },
        query: { enrolmentId }
      })
    );
    if (!res.ok) return res;
    const d = res.data;
    return Array.isArray(d)
      ? { ok: true, data: { items: d, taskCount: null } }
      : { ok: true, data: { items: d.items ?? [], taskCount: d.taskCount ?? null } };
  }

  detail(id: string) {
    return call<EvidenceDetail>(() => classroomio.apprenticeship.evidence[':id'].$get({ param: { id } }));
  }

  create(enrolmentId: string, body: EvidenceCreateBody): Promise<CallResult<EvidenceMutation>> {
    return call(() =>
      classroomio.apprenticeship.evidence.enrolments[':id'].evidence.$post({ param: { id: enrolmentId }, json: body })
    );
  }

  update(id: string, body: EvidenceUpdateBody): Promise<CallResult<EvidenceMutation>> {
    return call(() => classroomio.apprenticeship.evidence[':id'].$patch({ param: { id }, json: body }));
  }

  review(
    id: string,
    body: { decision: 'ACCEPT' | 'REFER'; criterionIds: string[]; note?: { body: string; kind: 'AUDIT' | 'GENERAL' } }
  ): Promise<CallResult<EvidenceMutation>> {
    return call(() => classroomio.apprenticeship.evidence[':id'].review.$post({ param: { id }, json: body }));
  }

  addNote(id: string, body: { body: string; kind: 'AUDIT' | 'GENERAL' }): Promise<CallResult<EvidenceNote>> {
    return call(() => classroomio.apprenticeship.evidence[':id'].notes.$post({ param: { id }, json: body }));
  }

  toMark(page: number, pageSize: number, programmeId?: string) {
    const query: Record<string, string> = { page: String(page), pageSize: String(pageSize) };
    if (programmeId) query.programmeId = programmeId;
    return call<ToMarkPage>(() => classroomio.apprenticeship.evidence['to-mark'].$get({ query }));
  }

  /** Programme structure for the criteria picker when the caller has no portfolio (the marking queue). */
  programmeTree(programmeId: string) {
    return call<{ qualifications: PickerQualification[] }>(() =>
      classroomio.apprenticeship.programmes[':id'].$get({ param: { id: programmeId } })
    );
  }

  /**
   * Presign → PUT each file straight to storage. Returns the file metadata to attach to the evidence plus the id the
   * files were presigned for (it must be passed back on create). Surfaces the API's message on failure.
   */
  async upload(
    enrolmentId: string,
    files: File[],
    evidenceId?: string
  ): Promise<CallResult<{ evidenceId: string; files: UploadedFile[] }>> {
    const presign = await call<{ evidenceId: string; files: { name: string; key: string; uploadUrl: string }[] }>(() =>
      classroomio.apprenticeship.evidence.presign.$post({
        json: {
          enrolmentId,
          ...(evidenceId ? { evidenceId } : {}),
          files: files.map((f) => ({
            name: f.name,
            size: f.size,
            type: f.type || 'application/octet-stream'
          }))
        }
      })
    );
    if (!presign.ok) return presign;
    try {
      const uploaded: UploadedFile[] = [];
      for (let i = 0; i < files.length; i++) {
        const target = presign.data.files[i];
        const type = files[i].type || 'application/octet-stream';
        await axios.put(target.uploadUrl, files[i], { headers: { 'Content-Type': type } });
        uploaded.push({ key: target.key, name: files[i].name, size: files[i].size, type });
      }
      return { ok: true, data: { evidenceId: presign.data.evidenceId, files: uploaded } };
    } catch {
      return { ok: false, error: 'The upload failed. Please try again.' };
    }
  }

  /**
   * Open one evidence file via a short-lived signed URL (the only door to the bytes). The tab is opened BEFORE the
   * await — still inside the click — so popup blockers allow it; it is then pointed at the signed URL (or closed).
   */
  async openFile(evidenceId: string, key: string): Promise<void> {
    const tab = window.open('', '_blank');
    const res = await call<Record<string, string>>(() =>
      classroomio.apprenticeship.evidence.download.$post({ json: { evidenceId, keys: [key] } })
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

export const evidenceApi = new EvidenceApi();
