import { randomUUID } from 'node:crypto';

import { parseCsvWithHeader } from '@cio/utils/functions/csv';
import { APPR_IMPORT_MAX_ROWS } from '@cio/utils/validation/apprenticeship';

// Gecko Apprenticeships — generic CSV import of a programme's structure. PURE: given what already exists and the
// CSV text, returns the preview counts + the exact rows to insert / update, so preview and apply can never disagree.
// Columns (case-insensitive header): qualification, unit_code, unit_title, criterion_code, criterion_text, group,
// required, unit_ref, criterion_ref. Matching is idempotent: external ref first, else unit code (or title when the
// unit has no code) within the qualification, else criterion code within the unit.

export interface ImportQualification {
  id: string;
  title: string;
  reference: string | null;
}
export interface ImportUnit {
  id: string;
  qualificationId: string;
  code: string | null;
  title: string;
  externalRef: string | null;
  sort: number;
}
export interface ImportCriterion {
  id: string;
  unitId: string;
  code: string;
  text: string;
  groupLabel: string | null;
  requiredCount: number;
  externalRef: string | null;
  sort: number;
}

export interface ImportPlan {
  summary: { unitsNew: number; unitsUpdated: number; criteriaNew: number; criteriaUpdated: number };
  errors: { row: number; message: string }[];
  newUnits: {
    id: string;
    qualificationId: string;
    code: string | null;
    title: string;
    externalRef: string | null;
    sort: number;
  }[];
  unitUpdates: { id: string; patch: { code: string | null; title: string; externalRef: string | null } }[];
  newCriteria: {
    id: string;
    unitId: string;
    code: string;
    text: string;
    groupLabel: string | null;
    requiredCount: number;
    externalRef: string | null;
    sort: number;
  }[];
  criterionUpdates: {
    id: string;
    patch: { code: string; text: string; groupLabel: string | null; requiredCount: number; externalRef: string | null };
  }[];
}

interface UnitState {
  id: string;
  isNew: boolean;
  qualificationId: string;
  cur: { code: string | null; title: string; externalRef: string | null };
  orig: { code: string | null; title: string; externalRef: string | null } | null;
  sort: number;
  nextCriterionSort: number;
}
interface CriterionState {
  id: string;
  isNew: boolean;
  unitId: string;
  cur: { code: string; text: string; groupLabel: string | null; requiredCount: number; externalRef: string | null };
  orig: CriterionState['cur'] | null;
  sort: number;
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/**
 * Skills Portfolio "Export Unit Data" / "Export All Unit Data" files are accepted as-is and mapped onto our columns:
 * `code` (e.g. A/650/1366/01 = Ofqual unit ref + criterion no.) → criterion_ref, and unit_ref = code without its last
 * segment; `unitTitle` → unit_title; `name` → criterion_code; `description` → criterion_text; `requiredItems` →
 * required. `completedItems` is that learner's progress, not structure, so it is ignored. A single-unit export has no
 * unitTitle, so it can only update a unit that already exists (import "All Units" first).
 */
export function fromSkillsPortfolioExport(
  parsed: ReturnType<typeof parseCsvWithHeader>
): ReturnType<typeof parseCsvWithHeader> {
  const h = parsed.headers;
  if (!(h.includes('code') && h.includes('name') && h.includes('description') && h.includes('requireditems')))
    return parsed;
  const records = parsed.records.map(({ row, values }) => {
    const code = (values['code'] ?? '').trim();
    const cut = code.lastIndexOf('/');
    return {
      row,
      values: {
        unit_ref: cut > 0 ? code.slice(0, cut) : '',
        unit_title: values['unittitle'] ?? '',
        criterion_ref: code,
        criterion_code: values['name'] ?? '',
        criterion_text: values['description'] ?? '',
        required: values['requireditems'] ?? ''
      }
    };
  });
  return {
    headers: ['unit_ref', 'unit_title', 'criterion_ref', 'criterion_code', 'criterion_text', 'required'],
    records
  };
}

export function planStructureImport(
  existing: { qualifications: ImportQualification[]; units: ImportUnit[]; criteria: ImportCriterion[] },
  csv: string
): ImportPlan {
  const errors: ImportPlan['errors'] = [];
  const { headers, records } = fromSkillsPortfolioExport(parseCsvWithHeader(csv));
  const fail = (row: number, message: string) => errors.push({ row, message });

  if (!headers.includes('unit_code') && !headers.includes('unit_title') && !headers.includes('unit_ref')) {
    fail(1, 'Header must include unit_code or unit_title');
  }
  if (records.length > APPR_IMPORT_MAX_ROWS) {
    fail(1, `Too many rows (max ${APPR_IMPORT_MAX_ROWS})`);
  }
  if (errors.length > 0) return emptyPlan(errors);

  // ── Index what exists ──
  const units = new Map<string, UnitState>(); // by id
  const unitByRef = new Map<string, UnitState>();
  const unitByCode = new Map<string, UnitState>(); // `${qid}|code`
  const unitByTitle = new Map<string, UnitState>(); // `${qid}|title` — only units without a code
  const maxUnitSort = new Map<string, number>();
  const indexUnit = (u: UnitState) => {
    units.set(u.id, u);
    if (u.cur.externalRef) unitByRef.set(norm(u.cur.externalRef), u);
    if (u.cur.code) unitByCode.set(`${u.qualificationId}|${norm(u.cur.code)}`, u);
    else unitByTitle.set(`${u.qualificationId}|${norm(u.cur.title)}`, u);
  };
  const criteriaOfUnit = new Map<string, number>(); // next sort per unit
  for (const u of existing.units) {
    const cur = { code: u.code, title: u.title, externalRef: u.externalRef };
    indexUnit({
      id: u.id,
      isNew: false,
      qualificationId: u.qualificationId,
      cur: { ...cur },
      orig: cur,
      sort: u.sort,
      nextCriterionSort: 0
    });
    maxUnitSort.set(u.qualificationId, Math.max(maxUnitSort.get(u.qualificationId) ?? -1, u.sort));
  }
  const criterionByRef = new Map<string, CriterionState>();
  const criterionByCode = new Map<string, CriterionState>(); // `${unitId}|code`
  const criteria = new Map<string, CriterionState>();
  const indexCriterion = (c: CriterionState) => {
    criteria.set(c.id, c);
    if (c.cur.externalRef) criterionByRef.set(norm(c.cur.externalRef), c);
    criterionByCode.set(`${c.unitId}|${norm(c.cur.code)}`, c);
  };
  for (const c of existing.criteria) {
    const cur = {
      code: c.code,
      text: c.text,
      groupLabel: c.groupLabel,
      requiredCount: c.requiredCount,
      externalRef: c.externalRef
    };
    indexCriterion({ id: c.id, isNew: false, unitId: c.unitId, cur: { ...cur }, orig: cur, sort: c.sort });
    criteriaOfUnit.set(c.unitId, Math.max(criteriaOfUnit.get(c.unitId) ?? 0, c.sort + 1));
  }

  // ── Walk the rows ──
  for (const { row, values: v } of records) {
    const qualCell = v['qualification'] ?? '';
    const unitCode = v['unit_code'] ?? '';
    const unitTitle = v['unit_title'] ?? '';
    const unitRef = v['unit_ref'] ?? '';
    const critCode = v['criterion_code'] ?? '';
    const critText = v['criterion_text'] ?? '';
    const critRef = v['criterion_ref'] ?? '';
    const group = v['group'] ?? '';
    const requiredCell = v['required'] ?? '';

    if (!unitCode && !unitTitle && !unitRef) {
      // Fully blank data rows are ignored; anything else needs a unit.
      if (Object.values(v).some((x) => x !== '')) fail(row, 'unit_code, unit_title or unit_ref is required');
      continue;
    }

    // Qualification
    let qualification: ImportQualification | undefined;
    if (qualCell) {
      qualification = existing.qualifications.find(
        (q) => norm(q.title) === norm(qualCell) || (q.reference && norm(q.reference) === norm(qualCell))
      );
      if (!qualification) {
        fail(row, `Qualification "${qualCell}" not found in this programme`);
        continue;
      }
    } else {
      qualification = existing.qualifications[0];
      if (!qualification) {
        fail(row, 'This programme has no qualification to import into');
        continue;
      }
    }
    const qid = qualification.id;

    // Criterion fields validated BEFORE any state is touched, so an errored row changes nothing.
    const hasCriterion = critCode !== '' || critText !== '' || critRef !== '';
    let required: number | null = null;
    if (requiredCell !== '') {
      const n = Number(requiredCell);
      if (!Number.isInteger(n) || n < 1 || n > 50) {
        fail(row, 'required must be a whole number from 1 to 50');
        continue;
      }
      required = n;
    }

    // Unit match
    let unit =
      (unitRef ? unitByRef.get(norm(unitRef)) : undefined) ??
      (unitCode ? unitByCode.get(`${qid}|${norm(unitCode)}`) : undefined) ??
      (!unitCode && unitTitle ? unitByTitle.get(`${qid}|${norm(unitTitle)}`) : undefined);

    if (!unit && !unitTitle && !unitCode) {
      fail(row, `unit_ref "${unitRef}" matches no unit and no unit_code / unit_title was given`);
      continue;
    }

    // Criterion match (needs the unit, which may be new — new units have no existing criteria)
    let criterion: CriterionState | undefined;
    if (hasCriterion) {
      criterion = critRef ? criterionByRef.get(norm(critRef)) : undefined;
      if (!criterion && unit && critCode) criterion = criterionByCode.get(`${unit.id}|${norm(critCode)}`);
      if (!criterion && (!critCode || !critText)) {
        fail(row, 'criterion_code and criterion_text are required for a new criterion');
        continue;
      }
    }

    // ── Apply to state ──
    if (!unit) {
      const sort = (maxUnitSort.get(qid) ?? -1) + 1;
      maxUnitSort.set(qid, sort);
      const title = unitTitle || unitCode;
      unit = {
        id: randomUUID(),
        isNew: true,
        qualificationId: qid,
        cur: { code: unitCode || null, title, externalRef: unitRef || null },
        orig: null,
        sort,
        nextCriterionSort: 0
      };
      indexUnit(unit);
    } else {
      if (unitTitle) unit.cur.title = unitTitle;
      if (unitCode) unit.cur.code = unitCode;
      if (unitRef) unit.cur.externalRef = unitRef;
      indexUnit(unit);
    }

    if (hasCriterion) {
      if (!criterion) {
        const sort = criteriaOfUnit.get(unit.id) ?? 0;
        criteriaOfUnit.set(unit.id, sort + 1);
        indexCriterion({
          id: randomUUID(),
          isNew: true,
          unitId: unit.id,
          cur: {
            code: critCode,
            text: critText,
            groupLabel: group || null,
            requiredCount: required ?? 1,
            externalRef: critRef || null
          },
          orig: null,
          sort
        });
      } else {
        if (critCode) criterion.cur.code = critCode;
        if (critText) criterion.cur.text = critText;
        if (group) criterion.cur.groupLabel = group;
        if (required !== null) criterion.cur.requiredCount = required;
        if (critRef) criterion.cur.externalRef = critRef;
        indexCriterion(criterion);
      }
    }
  }

  // ── Diff into ops ──
  const plan = emptyPlan(errors);
  for (const u of units.values()) {
    if (u.isNew) {
      plan.newUnits.push({
        id: u.id,
        qualificationId: u.qualificationId,
        code: u.cur.code,
        title: u.cur.title,
        externalRef: u.cur.externalRef,
        sort: u.sort
      });
    } else if (
      u.orig &&
      (u.orig.code !== u.cur.code || u.orig.title !== u.cur.title || u.orig.externalRef !== u.cur.externalRef)
    ) {
      plan.unitUpdates.push({ id: u.id, patch: { ...u.cur } });
    }
  }
  for (const c of criteria.values()) {
    if (c.isNew) {
      plan.newCriteria.push({ id: c.id, unitId: c.unitId, sort: c.sort, ...c.cur });
    } else if (c.orig && (Object.keys(c.cur) as (keyof typeof c.cur)[]).some((k) => c.orig![k] !== c.cur[k])) {
      plan.criterionUpdates.push({ id: c.id, patch: { ...c.cur } });
    }
  }
  plan.summary = {
    unitsNew: plan.newUnits.length,
    unitsUpdated: plan.unitUpdates.length,
    criteriaNew: plan.newCriteria.length,
    criteriaUpdated: plan.criterionUpdates.length
  };
  return plan;
}

function emptyPlan(errors: ImportPlan['errors']): ImportPlan {
  return {
    summary: { unitsNew: 0, unitsUpdated: 0, criteriaNew: 0, criteriaUpdated: 0 },
    errors,
    newUnits: [],
    unitUpdates: [],
    newCriteria: [],
    criterionUpdates: []
  };
}
