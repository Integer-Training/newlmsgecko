import { classroomio } from '$lib/utils/services/api';
import { BaseApi } from '$lib/utils/services/api/base.svelte';
import { snackbar } from '$features/ui/snackbar/store';

// Gecko Apprenticeships admin client: programme catalogue, structure CRUD, CSV import, org settings + evidence types.
// Every route is requireAdmin server-side; this client just drives the UI.
export type ProgrammeStatus = 'ACTIVE' | 'ARCHIVED';

export interface ProgrammeRow {
  id: string;
  title: string;
  description: string | null;
  reference: string | null;
  awardingBody: string | null;
  level: string | null;
  status: ProgrammeStatus;
  qualificationCount: number;
  unitCount: number;
  criterionCount: number;
  learnerCount: number;
}
export interface Criterion {
  id: string;
  unitId: string;
  code: string;
  text: string;
  groupLabel: string | null;
  requiredCount: number;
  sort: number;
}
export interface Unit {
  id: string;
  qualificationId: string;
  code: string | null;
  title: string;
  glh: number | null;
  sort: number;
  criteria: Criterion[];
}
export interface Qualification {
  id: string;
  programmeId: string;
  title: string;
  reference: string | null;
  awardingBody: string | null;
  level: string | null;
  sort: number;
  units: Unit[];
}
export interface ProgrammeTree {
  id: string;
  title: string;
  description: string | null;
  reference: string | null;
  awardingBody: string | null;
  level: string | null;
  status: ProgrammeStatus;
  qualifications: Qualification[];
}
export interface ImportResult {
  unitsNew: number;
  unitsUpdated: number;
  criteriaNew: number;
  criteriaUpdated: number;
  errors: { row: number; message: string }[];
}
export interface ApprSettings {
  concernGapPct: number;
  otjFactor: number;
  otjWeeklyCapHours: number;
}
export interface EvidenceType {
  id: string;
  key: string;
  label: string;
  active: boolean;
  sort: number;
}

export type ReorderKind = 'qualification' | 'unit' | 'criterion';

function errMsg(result: unknown, fallback: string): string {
  if (typeof result === 'string') return result;
  const e = (result as { error?: unknown } | null)?.error;
  return typeof e === 'string' ? e : fallback;
}

const base = () => classroomio.apprenticeship.programmes;

class ProgrammesApi extends BaseApi {
  programmes = $state<ProgrammeRow[] | null>(null);
  tree = $state<ProgrammeTree | null>(null);
  settings = $state<ApprSettings | null>(null);
  evidenceTypes = $state<EvidenceType[] | null>(null);
  loadError = $state<string | null>(null);
  // Monotonic ids so a slow earlier response cannot overwrite a newer one.
  #listReq = 0;
  #treeReq = 0;

  #fail = (fallback: string) => (result: unknown) => {
    snackbar.error(errMsg(result, fallback));
  };

  // ── Programmes ──

  async load(status: ProgrammeStatus | 'ALL' = 'ALL') {
    const req = ++this.#listReq;
    this.loadError = null;
    return this.execute<typeof classroomio.apprenticeship.programmes.$get>({
      requestFn: () => base().$get({ query: { status } }),
      logContext: 'loading programmes',
      onSuccess: (result) => {
        if (req === this.#listReq) this.programmes = result.data as ProgrammeRow[];
      },
      onError: (result) => {
        this.loadError = errMsg(result, 'Could not load programmes.');
      }
    });
  }

  async create(input: {
    title: string;
    description?: string | null;
    reference?: string | null;
    awardingBody?: string | null;
    level?: string | null;
  }) {
    const res = await this.execute<typeof classroomio.apprenticeship.programmes.$post>({
      requestFn: () => base().$post({ json: input }),
      logContext: 'creating programme',
      onError: this.#fail('Could not create the programme.')
    });
    return res ? (res.data as { id: string }) : undefined;
  }

  async loadTree(id: string) {
    const req = ++this.#treeReq;
    this.loadError = null;
    return this.execute<(typeof classroomio.apprenticeship.programmes)[':id']['$get']>({
      requestFn: () => base()[':id'].$get({ param: { id } }),
      logContext: 'loading programme',
      onSuccess: (result) => {
        if (req === this.#treeReq) this.tree = result.data as unknown as ProgrammeTree;
      },
      onError: (result) => {
        this.loadError = errMsg(result, 'Could not load the programme.');
      }
    });
  }

  async updateProgramme(
    id: string,
    patch: Partial<{
      title: string;
      description: string | null;
      reference: string | null;
      awardingBody: string | null;
      level: string | null;
    }> & {
      status?: ProgrammeStatus;
    }
  ) {
    const res = await this.execute<(typeof classroomio.apprenticeship.programmes)[':id']['$patch']>({
      requestFn: () => base()[':id'].$patch({ param: { id }, json: patch }),
      logContext: 'updating programme',
      onError: this.#fail('Could not save the programme.')
    });
    if (res) {
      if (this.tree?.id === id) this.tree = { ...this.tree, ...patch };
      if (this.programmes) {
        this.programmes = this.programmes.map((p) => (p.id === id ? { ...p, ...patch } : p));
      }
    }
    return !!res;
  }

  // ── Structure (every mutation reloads the tree so counts/order stay server-true) ──

  async createQualification(programmeId: string, json: { title: string; reference?: string | null }) {
    const res = await this.execute<(typeof classroomio.apprenticeship.programmes)[':id']['qualifications']['$post']>({
      requestFn: () => base()[':id'].qualifications.$post({ param: { id: programmeId }, json }),
      logContext: 'creating qualification',
      onError: this.#fail('Could not add the qualification.')
    });
    if (res) await this.loadTree(programmeId);
    return !!res;
  }

  async updateQualification(programmeId: string, qid: string, json: { title?: string; reference?: string | null }) {
    const res = await this.execute<
      (typeof classroomio.apprenticeship.programmes)[':id']['qualifications'][':qid']['$patch']
    >({
      requestFn: () => base()[':id'].qualifications[':qid'].$patch({ param: { id: programmeId, qid }, json }),
      logContext: 'updating qualification',
      onError: this.#fail('Could not save the qualification.')
    });
    if (res) await this.loadTree(programmeId);
    return !!res;
  }

  /** Resolves to the number of evidence mappings removed with it, or undefined on failure. */
  async deleteQualification(programmeId: string, qid: string) {
    const res = await this.execute<
      (typeof classroomio.apprenticeship.programmes)[':id']['qualifications'][':qid']['$delete']
    >({
      requestFn: () => base()[':id'].qualifications[':qid'].$delete({ param: { id: programmeId, qid } }),
      logContext: 'deleting qualification',
      onError: this.#fail('Could not delete the qualification.')
    });
    if (res) await this.loadTree(programmeId);
    return res ? ((res.data as { removedMappings?: number } | undefined)?.removedMappings ?? 0) : undefined;
  }

  async createUnit(programmeId: string, qid: string, json: { code?: string | null; title: string }) {
    const res = await this.execute<
      (typeof classroomio.apprenticeship.programmes)[':id']['qualifications'][':qid']['units']['$post']
    >({
      requestFn: () => base()[':id'].qualifications[':qid'].units.$post({ param: { id: programmeId, qid }, json }),
      logContext: 'creating unit',
      onError: this.#fail('Could not add the unit.')
    });
    if (res) await this.loadTree(programmeId);
    return !!res;
  }

  async updateUnit(programmeId: string, qid: string, uid: string, json: { code?: string | null; title?: string }) {
    const res = await this.execute<
      (typeof classroomio.apprenticeship.programmes)[':id']['qualifications'][':qid']['units'][':uid']['$patch']
    >({
      requestFn: () =>
        base()[':id'].qualifications[':qid'].units[':uid'].$patch({ param: { id: programmeId, qid, uid }, json }),
      logContext: 'updating unit',
      onError: this.#fail('Could not save the unit.')
    });
    if (res) await this.loadTree(programmeId);
    return !!res;
  }

  async deleteUnit(programmeId: string, qid: string, uid: string) {
    const res = await this.execute<
      (typeof classroomio.apprenticeship.programmes)[':id']['qualifications'][':qid']['units'][':uid']['$delete']
    >({
      requestFn: () =>
        base()[':id'].qualifications[':qid'].units[':uid'].$delete({ param: { id: programmeId, qid, uid } }),
      logContext: 'deleting unit',
      onError: this.#fail('Could not delete the unit.')
    });
    if (res) await this.loadTree(programmeId);
    return res ? ((res.data as { removedMappings?: number } | undefined)?.removedMappings ?? 0) : undefined;
  }

  async createCriterion(
    programmeId: string,
    qid: string,
    uid: string,
    json: { code: string; text: string; groupLabel?: string | null; requiredCount: number }
  ) {
    const res = await this.execute<
      (typeof classroomio.apprenticeship.programmes)[':id']['qualifications'][':qid']['units'][':uid']['criteria']['$post']
    >({
      requestFn: () =>
        base()[':id'].qualifications[':qid'].units[':uid'].criteria.$post({
          param: { id: programmeId, qid, uid },
          json
        }),
      logContext: 'creating criterion',
      onError: this.#fail('Could not add the criterion.')
    });
    if (res) await this.loadTree(programmeId);
    return !!res;
  }

  async updateCriterion(
    programmeId: string,
    qid: string,
    uid: string,
    cid: string,
    json: Partial<{ code: string; text: string; groupLabel: string | null; requiredCount: number }>
  ) {
    const res = await this.execute<
      (typeof classroomio.apprenticeship.programmes)[':id']['qualifications'][':qid']['units'][':uid']['criteria'][':cid']['$patch']
    >({
      requestFn: () =>
        base()[':id'].qualifications[':qid'].units[':uid'].criteria[':cid'].$patch({
          param: { id: programmeId, qid, uid, cid },
          json
        }),
      logContext: 'updating criterion',
      onError: this.#fail('Could not save the criterion.')
    });
    if (res) await this.loadTree(programmeId);
    return !!res;
  }

  async deleteCriterion(programmeId: string, qid: string, uid: string, cid: string) {
    const res = await this.execute<
      (typeof classroomio.apprenticeship.programmes)[':id']['qualifications'][':qid']['units'][':uid']['criteria'][':cid']['$delete']
    >({
      requestFn: () =>
        base()[':id'].qualifications[':qid'].units[':uid'].criteria[':cid'].$delete({
          param: { id: programmeId, qid, uid, cid }
        }),
      logContext: 'deleting criterion',
      onError: this.#fail('Could not delete the criterion.')
    });
    if (res) await this.loadTree(programmeId);
    return res ? ((res.data as { removedMappings?: number } | undefined)?.removedMappings ?? 0) : undefined;
  }

  /** parentId = programme id (qualification), qualification id (unit) or unit id (criterion). */
  async reorder(programmeId: string, kind: ReorderKind, parentId: string, orderedIds: string[]) {
    const res = await this.execute<(typeof classroomio.apprenticeship.programmes)[':id']['reorder']['$put']>({
      requestFn: () => base()[':id'].reorder.$put({ param: { id: programmeId }, json: { kind, parentId, orderedIds } }),
      logContext: 'reordering',
      onError: this.#fail('Could not reorder.')
    });
    if (res) await this.loadTree(programmeId);
    return !!res;
  }

  /** CSV import. mode 'preview' returns counts + row errors without writing; 'apply' writes. */
  async importCsv(programmeId: string, csv: string, mode: 'preview' | 'apply') {
    const res = await this.execute<(typeof classroomio.apprenticeship.programmes)[':id']['import']['$post']>({
      requestFn: () => base()[':id'].import.$post({ param: { id: programmeId }, json: { csv, mode } }),
      logContext: 'importing structure',
      onError: this.#fail('Could not read that CSV.')
    });
    if (res && mode === 'apply') await this.loadTree(programmeId);
    return res ? (res.data as ImportResult) : undefined;
  }

  // ── Settings + evidence types ──

  async loadSettings() {
    this.loadError = null;
    return this.execute<typeof classroomio.apprenticeship.settings.$get>({
      requestFn: () => classroomio.apprenticeship.settings.$get(),
      logContext: 'loading apprenticeship settings',
      onSuccess: (result) => {
        const data = result.data as unknown as { settings: ApprSettings; evidenceTypes: EvidenceType[] };
        this.settings = data.settings;
        this.evidenceTypes = [...data.evidenceTypes].sort((a, b) => a.sort - b.sort);
      },
      onError: (result) => {
        this.loadError = errMsg(result, 'Could not load settings.');
      }
    });
  }

  async saveSettings(input: ApprSettings) {
    const res = await this.execute<typeof classroomio.apprenticeship.settings.$put>({
      requestFn: () => classroomio.apprenticeship.settings.$put({ json: input }),
      logContext: 'saving apprenticeship settings',
      onSuccess: (result) => {
        this.settings = result.data as unknown as ApprSettings;
      },
      onError: this.#fail('Could not save the settings.')
    });
    return !!res;
  }

  async addEvidenceType(label: string) {
    const res = await this.execute<(typeof classroomio.apprenticeship.settings)['evidence-types']['$post']>({
      requestFn: () => classroomio.apprenticeship.settings['evidence-types'].$post({ json: { label } }),
      logContext: 'adding evidence type',
      onError: this.#fail('Could not add the evidence type.')
    });
    if (res) await this.loadSettings();
    return !!res;
  }

  async patchEvidenceType(id: string, json: Partial<{ label: string; active: boolean; sort: number }>) {
    const res = await this.execute<(typeof classroomio.apprenticeship.settings)['evidence-types'][':id']['$patch']>({
      requestFn: () => classroomio.apprenticeship.settings['evidence-types'][':id'].$patch({ param: { id }, json }),
      logContext: 'updating evidence type',
      onError: this.#fail('Could not update the evidence type.')
    });
    return !!res;
  }

  /** Move one evidence type up/down by rewriting each changed sort value to its new index. */
  async moveEvidenceType(id: string, dir: -1 | 1) {
    const list = [...(this.evidenceTypes ?? [])];
    const i = list.findIndex((e) => e.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await Promise.all(list.map((e, idx) => (e.sort === idx ? true : this.patchEvidenceType(e.id, { sort: idx }))));
    await this.loadSettings();
  }
}

export const programmesApi = new ProgrammesApi();
