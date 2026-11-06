import { AppError, ErrorCodes } from '@api/utils/errors';
import { getProgrammeForActor, requireAuthed } from '@api/services/apprenticeship/access';
import { planStructureImport } from '@api/services/apprenticeship/programme-import';
import { recomputeEnrolment } from '@api/services/apprenticeship/progress';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import { runInTransaction, type TxClient } from '@cio/db/drizzle';
import {
  countEvidenceMappingsForCriteria,
  deleteApprCriterion,
  deleteApprQualification,
  deleteApprUnit,
  getApprCriterionInProgramme,
  getApprProgrammeStructure,
  getApprQualificationInProgramme,
  getApprUnitInProgramme,
  insertApprCriteria,
  insertApprCriterion,
  insertApprProgrammeWithQualification,
  insertApprQualification,
  insertApprUnit,
  insertApprUnits,
  listApprProgrammesWithCounts,
  listChildIds,
  listCriterionIdsForQualification,
  listCriterionIdsForUnit,
  listEnrolmentIdsForProgramme,
  updateApprCriterion,
  updateApprProgramme,
  updateApprQualification,
  updateApprUnit,
  writeSortOrder
} from '@cio/db/queries/apprenticeship';
import { reindexOrder } from '@cio/utils/functions/reorder';
import {
  APPR_IMPORT_MAX_BYTES,
  type ImportBody,
  type ProgrammeCreateInput,
  type ProgrammeUpdateInput,
  type ReorderInput
} from '@cio/utils/validation/apprenticeship';

// Gecko Apprenticeships — Phase A1 admin service: programme catalogue + structure CRUD + CSV import. Every route is
// requireAdmin; the org always comes from the RESOLVED actor, and every nested id is verified through the programme
// chain (404 otherwise, so ids of other programmes/orgs cannot be probed). Anything that changes criteria or required
// counts recomputes every enrolment of the programme in the same transaction. Audit = ids + counts only.

const notFound = (what: string) => new AppError(`${what} not found`, ErrorCodes.NOT_FOUND, 404);

function audit(
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown> = {}
) {
  return recordAudit({ actor, action, entityType, entityId, metadata });
}

/** Recompute the progress cache of every enrolment on the programme. Returns how many were refreshed. */
async function recomputeProgramme(tx: TxClient, programmeId: string): Promise<number> {
  const ids = await listEnrolmentIdsForProgramme(programmeId, tx);
  for (const id of ids) await recomputeEnrolment(tx, id);
  return ids.length;
}

// ── Programmes ──

export async function listProgrammes(actor: Actor, status: 'ACTIVE' | 'ARCHIVED' | 'ALL') {
  const a = requireAuthed(actor);
  return listApprProgrammesWithCounts(a.orgId, status);
}

export async function createProgramme(actor: Actor, input: ProgrammeCreateInput) {
  const a = requireAuthed(actor);
  const { programme, qualification } = await runInTransaction((tx) =>
    insertApprProgrammeWithQualification(tx, {
      organizationId: a.orgId,
      createdBy: a.userId,
      title: input.title,
      description: input.description,
      reference: input.reference,
      level: input.level
    })
  );
  await audit(actor, 'appr.programme.created', 'appr_programme', programme.id, { qualificationId: qualification.id });
  return { ...programme, qualifications: [{ ...qualification, units: [] }] };
}

/** Programme + qualifications → units → criteria, in display order (programme lookup + 3 structure queries). */
export async function getProgrammeTree(actor: Actor, programmeId: string) {
  const programme = await getProgrammeForActor(actor, programmeId);
  const { qualifications, units, criteria } = await getApprProgrammeStructure(programmeId);

  const criteriaByUnit = new Map<string, typeof criteria>();
  for (const c of criteria) {
    const list = criteriaByUnit.get(c.unitId) ?? [];
    list.push(c);
    criteriaByUnit.set(c.unitId, list);
  }
  const unitsByQualification = new Map<string, ((typeof units)[number] & { criteria: typeof criteria })[]>();
  for (const u of units) {
    const list = unitsByQualification.get(u.qualificationId) ?? [];
    list.push({ ...u, criteria: criteriaByUnit.get(u.id) ?? [] });
    unitsByQualification.set(u.qualificationId, list);
  }
  return {
    ...programme,
    qualifications: qualifications.map((q) => ({ ...q, units: unitsByQualification.get(q.id) ?? [] }))
  };
}

export async function updateProgramme(actor: Actor, programmeId: string, patch: ProgrammeUpdateInput) {
  await getProgrammeForActor(actor, programmeId);
  const row = await updateApprProgramme(programmeId, patch);
  if (!row) throw notFound('Programme');
  await audit(actor, 'appr.programme.updated', 'appr_programme', programmeId, { fields: Object.keys(patch) });
  return row;
}

// ── Qualifications ──

export async function createQualification(
  actor: Actor,
  programmeId: string,
  input: { title: string; reference?: string | null; awardingBody?: string | null; level?: string | null }
) {
  const programme = await getProgrammeForActor(actor, programmeId);
  const row = await runInTransaction((tx) =>
    insertApprQualification(tx, { organizationId: programme.organizationId, programmeId, ...input })
  );
  await audit(actor, 'appr.qualification.created', 'appr_qualification', row.id, { programmeId });
  return row;
}

export async function updateQualification(
  actor: Actor,
  programmeId: string,
  qualificationId: string,
  patch: Partial<{ title: string; reference: string | null; awardingBody: string | null; level: string | null }>
) {
  await getProgrammeForActor(actor, programmeId);
  if (!(await getApprQualificationInProgramme(programmeId, qualificationId))) throw notFound('Qualification');
  const row = await updateApprQualification(qualificationId, patch);
  await audit(actor, 'appr.qualification.updated', 'appr_qualification', qualificationId, {
    programmeId,
    fields: Object.keys(patch)
  });
  return row;
}

export async function deleteQualification(actor: Actor, programmeId: string, qualificationId: string) {
  await getProgrammeForActor(actor, programmeId);
  if (!(await getApprQualificationInProgramme(programmeId, qualificationId))) throw notFound('Qualification');
  const removedMappings = await runInTransaction(async (tx) => {
    const n = await countEvidenceMappingsForCriteria(await listCriterionIdsForQualification(qualificationId, tx), tx);
    await deleteApprQualification(qualificationId, tx);
    await recomputeProgramme(tx, programmeId);
    return n;
  });
  await audit(actor, 'appr.qualification.deleted', 'appr_qualification', qualificationId, {
    programmeId,
    removedMappings
  });
  return { removedMappings };
}

// ── Units ──

export async function createUnit(
  actor: Actor,
  programmeId: string,
  qualificationId: string,
  input: { code?: string | null; title: string; glh?: number | null }
) {
  await getProgrammeForActor(actor, programmeId);
  if (!(await getApprQualificationInProgramme(programmeId, qualificationId))) throw notFound('Qualification');
  const row = await runInTransaction(async (tx) => {
    const unit = await insertApprUnit(tx, { qualificationId, ...input });
    await recomputeProgramme(tx, programmeId);
    return unit;
  });
  await audit(actor, 'appr.unit.created', 'appr_unit', row.id, { programmeId, qualificationId });
  return row;
}

export async function updateUnit(
  actor: Actor,
  programmeId: string,
  qualificationId: string,
  unitId: string,
  patch: Partial<{ code: string | null; title: string; glh: number | null }>
) {
  await getProgrammeForActor(actor, programmeId);
  if (!(await getApprUnitInProgramme(programmeId, qualificationId, unitId))) throw notFound('Unit');
  const row = await updateApprUnit(unitId, patch);
  await audit(actor, 'appr.unit.updated', 'appr_unit', unitId, { programmeId, fields: Object.keys(patch) });
  return row;
}

export async function deleteUnit(actor: Actor, programmeId: string, qualificationId: string, unitId: string) {
  await getProgrammeForActor(actor, programmeId);
  if (!(await getApprUnitInProgramme(programmeId, qualificationId, unitId))) throw notFound('Unit');
  const removedMappings = await runInTransaction(async (tx) => {
    const n = await countEvidenceMappingsForCriteria(await listCriterionIdsForUnit(unitId, tx), tx);
    await deleteApprUnit(unitId, tx);
    await recomputeProgramme(tx, programmeId);
    return n;
  });
  await audit(actor, 'appr.unit.deleted', 'appr_unit', unitId, { programmeId, removedMappings });
  return { removedMappings };
}

// ── Criteria ──

export async function createCriterion(
  actor: Actor,
  programmeId: string,
  qualificationId: string,
  unitId: string,
  input: { code: string; text: string; groupLabel?: string | null; requiredCount: number }
) {
  await getProgrammeForActor(actor, programmeId);
  if (!(await getApprUnitInProgramme(programmeId, qualificationId, unitId))) throw notFound('Unit');
  const row = await runInTransaction(async (tx) => {
    const criterion = await insertApprCriterion(tx, { unitId, ...input });
    await recomputeProgramme(tx, programmeId);
    return criterion;
  });
  await audit(actor, 'appr.criterion.created', 'appr_criterion', row.id, { programmeId, unitId });
  return row;
}

export async function updateCriterion(
  actor: Actor,
  programmeId: string,
  qualificationId: string,
  unitId: string,
  criterionId: string,
  patch: Partial<{ code: string; text: string; groupLabel: string | null; requiredCount: number }>
) {
  await getProgrammeForActor(actor, programmeId);
  const existing = await getApprCriterionInProgramme(programmeId, qualificationId, unitId, criterionId);
  if (!existing) throw notFound('Criterion');
  const row = await runInTransaction(async (tx) => {
    const updated = await updateApprCriterion(criterionId, patch, tx);
    if (patch.requiredCount !== undefined && patch.requiredCount !== existing.requiredCount) {
      await recomputeProgramme(tx, programmeId);
    }
    return updated;
  });
  await audit(actor, 'appr.criterion.updated', 'appr_criterion', criterionId, {
    programmeId,
    fields: Object.keys(patch)
  });
  return row;
}

export async function deleteCriterion(
  actor: Actor,
  programmeId: string,
  qualificationId: string,
  unitId: string,
  criterionId: string
) {
  await getProgrammeForActor(actor, programmeId);
  if (!(await getApprCriterionInProgramme(programmeId, qualificationId, unitId, criterionId)))
    throw notFound('Criterion');
  const removedMappings = await runInTransaction(async (tx) => {
    const n = await countEvidenceMappingsForCriteria([criterionId], tx);
    await deleteApprCriterion(criterionId, tx);
    await recomputeProgramme(tx, programmeId);
    return n;
  });
  await audit(actor, 'appr.criterion.deleted', 'appr_criterion', criterionId, { programmeId, removedMappings });
  return { removedMappings };
}

// ── Reorder ──

/** parentId is the programme (qualifications), a qualification (units) or a unit (criteria). */
export async function reorderChildren(actor: Actor, programmeId: string, input: ReorderInput) {
  await getProgrammeForActor(actor, programmeId);

  // The parent must sit inside THIS programme.
  if (input.kind === 'qualification') {
    if (input.parentId !== programmeId) throw notFound('Programme');
  } else if (input.kind === 'unit') {
    if (!(await getApprQualificationInProgramme(programmeId, input.parentId))) throw notFound('Qualification');
  } else {
    const structure = await getApprProgrammeStructure(programmeId);
    if (!structure.units.some((u) => u.id === input.parentId)) throw notFound('Unit');
  }

  const items = reindexOrder(input.orderedIds);
  await runInTransaction(async (tx) => {
    const children = new Set(await listChildIds(input.kind, input.parentId, tx));
    if (items.some((i) => !children.has(i.id))) throw notFound('Item');
    await writeSortOrder(input.kind, items, tx);
  });
  await audit(actor, 'appr.structure.reordered', 'appr_programme', programmeId, {
    kind: input.kind,
    count: items.length
  });
  return { reordered: items.length };
}

// ── CSV import ──

export async function importStructureCsv(actor: Actor, programmeId: string, body: ImportBody) {
  await getProgrammeForActor(actor, programmeId);
  if (Buffer.byteLength(body.csv, 'utf8') > APPR_IMPORT_MAX_BYTES) {
    throw new AppError('CSV is larger than 2 MB', ErrorCodes.VALIDATION_ERROR, 413);
  }

  const { qualifications, units, criteria } = await getApprProgrammeStructure(programmeId);
  const plan = planStructureImport({ qualifications, units, criteria }, body.csv);
  if (body.mode === 'preview') return { ...plan.summary, errors: plan.errors };

  await runInTransaction(async (tx) => {
    await insertApprUnits(
      tx,
      plan.newUnits.map((u) => ({
        id: u.id,
        qualificationId: u.qualificationId,
        code: u.code,
        title: u.title,
        externalRef: u.externalRef,
        sort: u.sort
      }))
    );
    await insertApprCriteria(tx, plan.newCriteria);
    for (const u of plan.unitUpdates) await updateApprUnit(u.id, u.patch, tx);
    for (const c of plan.criterionUpdates) await updateApprCriterion(c.id, c.patch, tx);
    await recomputeProgramme(tx, programmeId);
  });
  await audit(actor, 'appr.structure.imported', 'appr_programme', programmeId, {
    ...plan.summary,
    skippedRows: plan.errors.length
  });
  return { ...plan.summary, errors: plan.errors };
}
