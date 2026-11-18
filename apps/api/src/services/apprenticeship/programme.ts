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
  getApprProgramme,
  getApprProgrammeStructure,
  getApprQualificationInProgramme,
  getApprUnitInProgramme,
  insertApprCriteria,
  insertApprCriterion,
  insertApprProgrammeWithQualification,
  insertApprQualification,
  insertApprUnit,
  insertApprUnits,
  listActiveStandards,
  listApprProgrammesWithCounts,
  countOpenLinkedPairs,
  listApprQualificationIds,
  listChildIds,
  listCriterionIdsForQualification,
  listCriterionIdsForUnit,
  listDiplomasPairedTo,
  listEnrolmentIdsForProgramme,
  updateApprCriterion,
  updateApprProgramme,
  updateApprQualification,
  updateApprUnit,
  writeSortOrder
} from '@cio/db/queries/apprenticeship';
import { apprLevelNumber, pairingError } from '@cio/utils/functions/apprenticeship-pairing';
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

const badRequest = (message: string) => new AppError(message, ErrorCodes.VALIDATION_ERROR, 400);

export async function listProgrammes(
  actor: Actor,
  status: 'ACTIVE' | 'ARCHIVED' | 'ALL',
  type: 'DIPLOMA' | 'STANDARD' | 'ALL' = 'ALL'
) {
  const a = requireAuthed(actor);
  const rows = await listApprProgrammesWithCounts(a.orgId, status, type);
  return rows.map((r) => ({ ...r, levelNumber: apprLevelNumber(r.level) }));
}

/** The Standard a diploma is paired to, and the diplomas paired to a Standard (for the tree). */
async function pairingFields(programme: { id: string; pairedProgrammeId: string | null; level: string | null }) {
  const [standard, diplomas] = await Promise.all([
    programme.pairedProgrammeId ? getApprProgramme(programme.pairedProgrammeId) : Promise.resolve(null),
    listDiplomasPairedTo(programme.id)
  ]);
  return {
    levelNumber: apprLevelNumber(programme.level),
    pairedProgramme: standard ? { id: standard.id, title: standard.title, level: standard.level } : null,
    pairedDiplomas: diplomas.map((d) => ({ id: d.id, title: d.title }))
  };
}

/** Diploma-only: ACTIVE Standards in the org at the same level number. Standards have no candidates. */
export async function listPairCandidates(actor: Actor, programmeId: string) {
  const a = requireAuthed(actor);
  const programme = await getProgrammeForActor(actor, programmeId);
  if (programme.type !== 'DIPLOMA') return [];
  const levelNumber = apprLevelNumber(programme.level);
  if (levelNumber === null) return [];
  const standards = await listActiveStandards(a.orgId);
  return standards
    .filter((s) => apprLevelNumber(s.level) === levelNumber)
    .map((s) => ({ id: s.id, title: s.title, level: s.level, reference: s.reference }));
}

export async function createProgramme(actor: Actor, input: ProgrammeCreateInput) {
  const a = requireAuthed(actor);
  const type = input.type ?? 'DIPLOMA';
  const pairedProgrammeId = input.pairedProgrammeId ?? null;
  if (pairedProgrammeId) {
    if (type !== 'DIPLOMA') throw badRequest('Only a diploma can be paired to a Standard');
    const standard = await getApprProgramme(pairedProgrammeId);
    const problem = pairingError({ type, level: input.level, status: 'ACTIVE', organizationId: a.orgId }, standard);
    if (problem) throw badRequest(problem);
  }
  const { programme, qualification } = await runInTransaction((tx) =>
    insertApprProgrammeWithQualification(tx, {
      organizationId: a.orgId,
      createdBy: a.userId,
      title: input.title,
      description: input.description,
      reference: input.reference,
      awardingBody: input.awardingBody,
      level: input.level,
      type,
      pairedProgrammeId
    })
  );
  await audit(actor, 'appr.programme.created', 'appr_programme', programme.id, {
    qualificationId: qualification.id,
    type
  });
  return {
    ...programme,
    ...(await pairingFields(programme)),
    unitCount: 0,
    criterionCount: 0,
    qualifications: [{ ...qualification, units: [] }]
  };
}

/** Programme + qualifications → units → criteria, in display order (programme lookup + 3 structure queries). */
export async function getProgrammeTree(actor: Actor, programmeId: string) {
  const programme = await getProgrammeForActor(actor, programmeId);
  const [{ qualifications, units, criteria }, pairing] = await Promise.all([
    getApprProgrammeStructure(programmeId),
    pairingFields(programme)
  ]);

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
    ...pairing,
    unitCount: units.length,
    criterionCount: criteria.length,
    qualifications: qualifications.map((q) => ({ ...q, units: unitsByQualification.get(q.id) ?? [] }))
  };
}

/** Pair rules for a PATCH: pairing validity, level changes that would break a pair, archiving a paired Standard. */
async function checkPairChange(
  existing: NonNullable<Awaited<ReturnType<typeof getApprProgramme>>>,
  patch: ProgrammeUpdateInput
) {
  const levelChanged = patch.level !== undefined && apprLevelNumber(patch.level) !== apprLevelNumber(existing.level);
  const newLevel = patch.level !== undefined ? patch.level : existing.level;

  const brokenMessage = 'Changing the level would break an existing pair — unpair them first';
  if (patch.pairedProgrammeId !== undefined && existing.type !== 'DIPLOMA') {
    throw badRequest('Only a diploma can be paired to a Standard');
  }

  if (existing.type === 'DIPLOMA') {
    const finalPair = patch.pairedProgrammeId !== undefined ? patch.pairedProgrammeId : existing.pairedProgrammeId;
    const changing = finalPair !== existing.pairedProgrammeId;
    // Changing or clearing the pair is blocked while learners hold a linked (Diploma + Standard) enrolment pair on it.
    if (changing && existing.pairedProgrammeId) {
      const linkedLearners = await countOpenLinkedPairs(existing.id, existing.pairedProgrammeId);
      if (linkedLearners > 0) {
        throw new AppError(
          `${linkedLearners} learner${linkedLearners === 1 ? ' is' : 's are'} on both — unlink or finish them first`,
          ErrorCodes.CONFLICT,
          409
        );
      }
    }
    // Validate the FINAL pairing whenever the pair or the level changes (a same-pair PATCH with a new level must not
    // slip through and leave a Level 4 diploma paired to a Level 3 standard).
    if (finalPair && (changing || levelChanged)) {
      const standard = await getApprProgramme(finalPair);
      const problem = pairingError(
        { type: existing.type, level: newLevel, status: existing.status, organizationId: existing.organizationId },
        standard
      );
      if (problem) throw badRequest(changing ? problem : brokenMessage);
    }
  }

  if (levelChanged && existing.type === 'STANDARD') {
    const diplomas = await listDiplomasPairedTo(existing.id);
    const n = apprLevelNumber(newLevel);
    if (diplomas.some((d) => n === null || n !== apprLevelNumber(d.level))) throw badRequest(brokenMessage);
  }

  if (patch.status === 'ARCHIVED' && existing.status !== 'ARCHIVED' && existing.type === 'STANDARD') {
    const diplomas = await listDiplomasPairedTo(existing.id);
    if (diplomas.length > 0) {
      throw new AppError(
        `Unpair these diplomas first: ${diplomas.map((d) => d.title).join(', ')}`,
        ErrorCodes.CONFLICT,
        409
      );
    }
  }
}

export async function updateProgramme(actor: Actor, programmeId: string, patch: ProgrammeUpdateInput) {
  const existing = await getProgrammeForActor(actor, programmeId);
  await checkPairChange(existing, patch);
  const row = await runInTransaction(async (tx) => {
    const updated = await updateApprProgramme(programmeId, patch, tx);
    // One programme = one course: a programme's only qualification mirrors its title / reference / level / awarding body.
    const { title, reference, awardingBody, level } = patch;
    const qualificationPatch = Object.fromEntries(
      Object.entries({ title, reference, awardingBody, level }).filter(([, v]) => v !== undefined)
    );
    if (updated && Object.keys(qualificationPatch).length > 0) {
      const qualificationIds = await listApprQualificationIds(programmeId, tx);
      if (qualificationIds.length === 1) await updateApprQualification(qualificationIds[0], qualificationPatch, tx);
    }
    return updated;
  });
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
  // Unit GLH feeds every learner's GLH target / done, so changing it re-derives the cache in the same transaction.
  const row = await runInTransaction(async (tx) => {
    const updated = await updateApprUnit(unitId, patch, tx);
    if (patch.glh !== undefined) await recomputeProgramme(tx, programmeId);
    return updated;
  });
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
  const hasEnrolments = (await listEnrolmentIdsForProgramme(programmeId)).length > 0;
  const plan = planStructureImport({ qualifications, units, criteria, hasEnrolments }, body.csv);
  if (body.mode === 'preview')
    return { ...plan.summary, errors: plan.errors, warnings: plan.warnings ?? [], units: plan.unitPreview ?? [] };

  await runInTransaction(async (tx) => {
    await insertApprUnits(
      tx,
      plan.newUnits.map((u) => ({
        id: u.id,
        qualificationId: u.qualificationId,
        code: u.code,
        title: u.title,
        externalRef: u.externalRef,
        glh: u.glh,
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
  return { ...plan.summary, errors: plan.errors, warnings: plan.warnings ?? [], units: plan.unitPreview ?? [] };
}
