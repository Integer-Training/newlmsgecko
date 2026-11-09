import { randomUUID } from 'node:crypto';

import { AppError, ErrorCodes } from '@api/utils/errors';
import {
  assertStaff,
  canAccessLearner,
  getEnrolmentForActor,
  isStaff,
  requireAuthed
} from '@api/services/apprenticeship/access';
import {
  notifyEvidenceReviewed,
  notifyEvidenceSubmitted,
  notifySafely
} from '@api/services/apprenticeship/notifications';
import { toProgressSummary } from '@api/services/apprenticeship/enrolment';
import { recomputeEnrolment } from '@api/services/apprenticeship/progress';
import { assertActiveType, assertAllowedFile, assertCriteriaInProgramme } from '@api/services/apprenticeship/checks';
import { assertTaskForEvidence, syncTaskStatuses } from '@api/services/apprenticeship/tasks';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import { runInTransaction } from '@cio/db/drizzle';
import {
  filterCriterionIdsInProgramme,
  filterUploadKeysInOrg,
  getApprEnrolmentByProgrammeLearner,
  getApprEvidence,
  insertApprEvidence,
  insertApprUploads,
  insertEvidenceNote,
  listApprEvidenceTypes,
  listEvidenceCriteriaDetail,
  listEvidenceForCriterion,
  listEvidenceForLearner,
  listEvidenceNotes,
  listToMark,
  markUploadsAttached,
  markUploadsRemoved,
  replaceEvidenceCriteria,
  updateApprEvidence,
  type ApprEvidenceFile,
  type ApprEvidenceRow
} from '@cio/db/queries/apprenticeship';
import { apprenticeshipEvidenceKeyPrefix, generateApprenticeshipEvidenceFileKey } from '@cio/core/utils/upload';
import { generateDocumentDownloadPresignedUrls, generateDocumentUploadPresignedUrl } from '@cio/core/utils/s3';
import {
  APPR_EVIDENCE_STATUS_LABELS,
  type ApprEvidenceStatus,
  type ApprNoteKind
} from '@cio/utils/constants/apprenticeship';
import { isUniqueConstraintViolation } from '@cio/utils/errors';
import type {
  EvidenceCreateInput,
  EvidenceFileInput,
  EvidenceNoteCreateInput,
  EvidencePresignInput,
  EvidenceReviewInput,
  EvidenceUpdateInput
} from '@cio/utils/validation/apprenticeship';

// Gecko Apprenticeships — evidence. State machine:
//   create            → SUBMITTED (learner, or staff by default) or ACCEPTED (staff may add it already accepted)
//   SUBMITTED         → ACCEPTED | REFERRED     (review by ADMIN or the allocated TUTOR)
//   REFERRED          → SUBMITTED               (the learner edits and resubmits; no staff review while it waits)
//   ACCEPTED          → REFERRED                (reopen — ADMIN only, via review REFER)
// Only ACCEPTED counts towards progress, so every write recomputes the learner's cache in the SAME transaction.
// Visibility is the enrolment access rule (access.ts); a learner may only edit their own SUBMITTED/REFERRED evidence.
// Files go to the private bucket under apprenticeship/{programmeId}/{learnerId}/{evidenceId}/ — presign issues the
// keys (and the evidence id), create/update verify every key is under that exact prefix before saving it.

const notFound = () => new AppError('Evidence not found', ErrorCodes.NOT_FOUND, 404);
const badRequest = (message: string, field?: string) => new AppError(message, ErrorCodes.VALIDATION_ERROR, 400, field);

// ── State machine (pure) ──

/** The status a review moves evidence to, or the error explaining why that review is not allowed. */
export function reviewTransition(
  current: ApprEvidenceStatus,
  decision: 'ACCEPT' | 'REFER',
  role: 'ADMIN' | 'TUTOR' | string
): ApprEvidenceStatus {
  if (current === 'SUBMITTED') return decision === 'ACCEPT' ? 'ACCEPTED' : 'REFERRED';
  if (current === 'ACCEPTED') {
    if (decision === 'ACCEPT') throw new AppError('This evidence is already accepted', ErrorCodes.CONFLICT, 409);
    if (role !== 'ADMIN') {
      throw new AppError('Only an admin can reopen accepted evidence', ErrorCodes.FORBIDDEN, 403);
    }
    return 'REFERRED';
  }
  throw new AppError('This evidence is waiting for the learner to resubmit', ErrorCodes.CONFLICT, 409);
}

/** What editing does to the status: a learner editing REFERRED evidence resubmits it; everything else stays. */
export function statusAfterEdit(current: ApprEvidenceStatus, editorIsLearner: boolean): ApprEvidenceStatus {
  return editorIsLearner && current === 'REFERRED' ? 'SUBMITTED' : current;
}

function asStatus(value: string): ApprEvidenceStatus {
  return value as ApprEvidenceStatus;
}

// ── Loading + checks ──

async function loadEvidenceForActor(actor: Actor, evidenceId: string): Promise<ApprEvidenceRow> {
  requireAuthed(actor);
  const evidence = await getApprEvidence(evidenceId);
  if (!evidence || !(await canAccessLearner(actor, evidence.organizationId, evidence.learnerId))) throw notFound();
  return evidence;
}

/** Staff (already scoped by access) may edit anything; a learner only their own SUBMITTED/REFERRED evidence. */
function assertCanEdit(actor: Actor, evidence: ApprEvidenceRow): void {
  if (isStaff(actor)) return;
  const a = requireAuthed(actor);
  if (a.userId !== evidence.learnerId || !['SUBMITTED', 'REFERRED'].includes(evidence.status)) {
    throw new AppError('This evidence can no longer be edited', ErrorCodes.FORBIDDEN, 403);
  }
}

function canReview(actor: Actor, evidence: ApprEvidenceRow): boolean {
  if (!isStaff(actor)) return false;
  if (evidence.status === 'SUBMITTED') return true;
  return evidence.status === 'ACCEPTED' && actor.authenticated && actor.role === 'ADMIN';
}

/** Keys must sit under this evidence's own prefix (or already be on the row) — blocks key injection across learners. */
async function assertFileKeys(
  files: EvidenceFileInput[],
  prefix: string,
  scope: { organizationId: string; learnerId: string },
  existing: ApprEvidenceFile[] = []
): Promise<void> {
  const owned = new Set(existing.map((f) => f.key));
  for (const f of files) {
    if (!owned.has(f.key) && !f.key.startsWith(prefix))
      throw badRequest('Invalid file reference for this evidence', 'files');
    assertAllowedFile(f);
  }
  // NEW keys must still be a live upload issued to this learner (the clean-up job may have collected an old one).
  const fresh = files.filter((f) => !owned.has(f.key)).map((f) => f.key);
  if (fresh.length === 0) return;
  const live = new Set(
    await filterUploadKeysInOrg(scope.organizationId, fresh, { learnerId: scope.learnerId, notRemoved: true })
  );
  if (fresh.some((k) => !live.has(k))) {
    throw badRequest('This file upload has expired — please upload it again', 'files');
  }
}

function toStoredFiles(
  files: EvidenceFileInput[],
  existing: ApprEvidenceFile[],
  uploadedBy: string
): ApprEvidenceFile[] {
  const byKey = new Map(existing.map((f) => [f.key, f]));
  const now = new Date().toISOString();
  return files.map(
    (f) => byKey.get(f.key) ?? { key: f.key, name: f.name, size: f.size, type: f.type, uploadedBy, uploadedAt: now }
  );
}

function noteKindFor(actor: Actor, requested: ApprNoteKind | undefined): ApprNoteKind {
  // AUDIT is the system trail; only staff may write one by hand.
  return isStaff(actor) ? (requested ?? 'GENERAL') : 'GENERAL';
}

// ── Reads ──

export async function listEvidence(actor: Actor, enrolmentId: string, filter: { status?: string; typeKey?: string }) {
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  return listEvidenceForLearner(enrolment.organizationId, enrolment.programmeId, enrolment.learnerId, filter);
}

export async function getEvidenceDetail(actor: Actor, evidenceId: string) {
  const evidence = await loadEvidenceForActor(actor, evidenceId);
  const [criteriaRows, notes, types, enrolment] = await Promise.all([
    listEvidenceCriteriaDetail(evidenceId),
    listEvidenceNotes(evidenceId),
    listApprEvidenceTypes(evidence.organizationId),
    getApprEnrolmentByProgrammeLearner(evidence.programmeId, evidence.learnerId)
  ]);

  // qualification → unit → criteria, in programme order (rows arrive ordered).
  const qualifications: {
    id: string;
    title: string;
    units: {
      id: string;
      code: string | null;
      title: string;
      criteria: { id: string; code: string; text: string; groupLabel: string | null; source: string }[];
    }[];
  }[] = [];
  for (const r of criteriaRows) {
    let q = qualifications.find((x) => x.id === r.qualificationId);
    if (!q) qualifications.push((q = { id: r.qualificationId, title: r.qualificationTitle, units: [] }));
    let u = q.units.find((x) => x.id === r.unitId);
    if (!u) q.units.push((u = { id: r.unitId, code: r.unitCode, title: r.unitTitle, criteria: [] }));
    u.criteria.push({ id: r.criterionId, code: r.code, text: r.text, groupLabel: r.groupLabel, source: r.source });
  }

  return {
    evidence: {
      ...evidence,
      status: asStatus(evidence.status),
      statusLabel: APPR_EVIDENCE_STATUS_LABELS[asStatus(evidence.status)] ?? evidence.status,
      typeLabel: types.find((t) => t.key === evidence.typeKey)?.label ?? evidence.typeKey
    },
    criteria: qualifications,
    notes,
    // Lets a sheet opened without a portfolio (To mark, a notification) still presign file uploads.
    enrolmentId: enrolment?.id ?? null,
    permissions: {
      canEdit:
        isStaff(actor) ||
        (actor.authenticated &&
          actor.userId === evidence.learnerId &&
          ['SUBMITTED', 'REFERRED'].includes(evidence.status)),
      canReview: canReview(actor, evidence)
    }
  };
}

export async function listCriterionEvidence(actor: Actor, criterionId: string, enrolmentId: string) {
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  const found = await filterCriterionIdsInProgramme(enrolment.programmeId, [criterionId]);
  if (found.length === 0) throw new AppError('Criterion not found', ErrorCodes.NOT_FOUND, 404);
  return listEvidenceForCriterion(enrolment.programmeId, enrolment.learnerId, criterionId);
}

/** The marking queue: ADMIN → the org; TUTOR → allocated learners only (joined in the query). */
export async function listToMarkQueue(actor: Actor, query: { programmeId?: string; page: number; pageSize: number }) {
  const a = assertStaff(actor);
  const rows = await listToMark(
    {
      organizationId: a.orgId,
      programmeId: query.programmeId,
      restrictToTutorId: a.role === 'TUTOR' ? a.userId : undefined
    },
    { limit: query.pageSize, offset: (query.page - 1) * query.pageSize }
  );
  return {
    items: rows.map(({ total: _total, ...row }) => row),
    total: rows[0]?.total ?? 0,
    page: query.page,
    pageSize: query.pageSize
  };
}

// ── Uploads ──

export async function presignEvidenceUploads(actor: Actor, input: EvidencePresignInput) {
  const enrolment = await getEnrolmentForActor(actor, input.enrolmentId);

  let evidenceId = input.evidenceId;
  if (evidenceId) {
    const existing = await getApprEvidence(evidenceId);
    if (existing) {
      // Adding files to an existing piece: it must be this learner's, on this programme, and editable by the caller.
      if (existing.learnerId !== enrolment.learnerId || existing.programmeId !== enrolment.programmeId)
        throw notFound();
      assertCanEdit(actor, existing);
    }
  } else {
    evidenceId = randomUUID();
  }

  for (const f of input.files) assertAllowedFile(f);
  const files = await Promise.all(
    input.files.map(async (f) => {
      let key: string;
      try {
        key = generateApprenticeshipEvidenceFileKey(enrolment.programmeId, enrolment.learnerId, evidenceId!, f.name);
      } catch {
        throw badRequest(`"${f.name}" needs a file extension`, 'files');
      }
      return { name: f.name, key, uploadUrl: await generateDocumentUploadPresignedUrl(key, f.type) };
    })
  );
  // Track every issued key so the daily clean-up can delete the ones that never reach a saved record.
  await insertApprUploads(
    files.map((f) => ({
      organizationId: enrolment.organizationId,
      learnerId: enrolment.learnerId,
      ownerId: actor.authenticated ? actor.userId : null,
      key: f.key
    }))
  );
  return { evidenceId, files };
}

/** Signed download URLs. Every key must be listed on THIS evidence row, which the caller can already see. */
export async function signEvidenceDownloads(actor: Actor, evidenceId: string, keys: string[]) {
  const evidence = await loadEvidenceForActor(actor, evidenceId);
  const owned = new Set(evidence.files.map((f) => f.key));
  if (!keys.every((k) => owned.has(k))) {
    throw new AppError('You do not have access to these files', ErrorCodes.FORBIDDEN, 403);
  }
  return generateDocumentDownloadPresignedUrls(keys);
}

// ── Writes ──

function audit(actor: Actor, action: string, entityId: string, metadata: Record<string, unknown> = {}) {
  return recordAudit({ actor, action, entityType: 'appr_evidence', entityId, metadata });
}

export async function createEvidence(actor: Actor, enrolmentId: string, input: EvidenceCreateInput) {
  const a = requireAuthed(actor);
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  const staff = isStaff(a);
  const status: ApprEvidenceStatus = staff ? (input.status ?? 'SUBMITTED') : 'SUBMITTED';

  await assertActiveType(enrolment.organizationId, input.typeKey);
  const criterionIds = await assertCriteriaInProgramme(enrolment.programmeId, input.criterionIds);

  if (input.files.length > 0 && !input.evidenceId) throw badRequest('Upload the files before saving', 'files');
  const evidenceId = input.evidenceId ?? randomUUID();
  await assertFileKeys(
    input.files,
    apprenticeshipEvidenceKeyPrefix(enrolment.programmeId, enrolment.learnerId, evidenceId),
    enrolment
  );

  if (input.taskId) await assertTaskForEvidence(input.taskId, enrolment);

  const reviewedNow = status === 'ACCEPTED';
  let result: { evidence: ApprEvidenceRow; detail: Awaited<ReturnType<typeof recomputeEnrolment>> };
  try {
    result = await runInTransaction(async (tx) => {
      const evidence = await insertApprEvidence(tx, {
        id: evidenceId,
        organizationId: enrolment.organizationId,
        programmeId: enrolment.programmeId,
        learnerId: enrolment.learnerId,
        title: input.title,
        details: input.details,
        typeKey: input.typeKey,
        minutes: input.minutes,
        includeOtj: input.includeOtj,
        status,
        taskId: input.taskId ?? null,
        files: toStoredFiles(input.files, [], a.userId),
        createdBy: a.userId,
        reviewedBy: reviewedNow ? a.userId : null,
        reviewedAt: reviewedNow ? new Date().toISOString() : null
      });
      await replaceEvidenceCriteria(tx, evidenceId, criterionIds, staff ? 'STAFF' : 'LEARNER');
      await markUploadsAttached(
        input.files.map((f) => f.key),
        tx
      );
      await insertEvidenceNote(tx, {
        evidenceId,
        authorId: a.userId,
        kind: 'AUDIT',
        body: `Evidence added as ${APPR_EVIDENCE_STATUS_LABELS[status]}`,
        statusAtTime: status
      });
      if (input.note) {
        await insertEvidenceNote(tx, {
          evidenceId,
          authorId: a.userId,
          kind: noteKindFor(a, input.note.kind),
          body: input.note.body,
          statusAtTime: status
        });
      }
      await syncTaskStatuses(tx, [input.taskId]);
      return { evidence, detail: await recomputeEnrolment(tx, enrolment.id) };
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new AppError('This evidence has already been saved', ErrorCodes.CONFLICT, 409);
    }
    throw error;
  }

  await audit(actor, 'appr.evidence.created', evidenceId, {
    programmeId: enrolment.programmeId,
    learnerId: enrolment.learnerId,
    status,
    criteria: criterionIds.length,
    files: input.files.length
  });
  // The apprentice's own upload goes to their tutor(s) to mark; staff evidence added as Accepted tells the apprentice.
  if (!staff) {
    await notifySafely('evidence submitted', () =>
      notifyEvidenceSubmitted({ evidenceId, learnerId: enrolment.learnerId })
    );
  } else if (status === 'ACCEPTED') {
    await notifySafely('evidence accepted', () =>
      notifyEvidenceReviewed({ evidenceId, learnerId: enrolment.learnerId, outcome: 'ACCEPTED' })
    );
  }
  return { evidence: result.evidence, summary: result.detail ? toProgressSummary(result.detail) : null };
}

export async function updateEvidence(actor: Actor, evidenceId: string, input: EvidenceUpdateInput) {
  const a = requireAuthed(actor);
  const evidence = await loadEvidenceForActor(actor, evidenceId);
  assertCanEdit(actor, evidence);
  const staff = isStaff(a);

  if (input.typeKey !== undefined && input.typeKey !== evidence.typeKey) {
    await assertActiveType(evidence.organizationId, input.typeKey);
  }
  const criterionIds = input.criterionIds
    ? await assertCriteriaInProgramme(evidence.programmeId, input.criterionIds)
    : undefined;
  if (input.files) {
    await assertFileKeys(
      input.files,
      apprenticeshipEvidenceKeyPrefix(evidence.programmeId, evidence.learnerId, evidence.id),
      evidence,
      evidence.files
    );
  }

  const nextStatus = statusAfterEdit(asStatus(evidence.status), !staff);
  const resubmitted = nextStatus !== evidence.status;
  const { note, criterionIds: _ids, files, ...fields } = input;
  const patch = {
    ...fields,
    ...(files ? { files: toStoredFiles(files, evidence.files, a.userId) } : {}),
    status: nextStatus
  };

  const enrolment = await getApprEnrolmentByProgrammeLearner(evidence.programmeId, evidence.learnerId);
  // Linking to a (different) task: it must belong to this learner + programme. The old task is re-synced too.
  if (input.taskId) await assertTaskForEvidence(input.taskId, evidence);
  const keptKeys = files?.map((f) => f.key) ?? [];
  const droppedKeys = files ? evidence.files.map((f) => f.key).filter((k) => !keptKeys.includes(k)) : [];
  const result = await runInTransaction(async (tx) => {
    // Conditional on the status we read: a concurrent review makes this a 409 instead of a silent overwrite.
    const updated = await updateApprEvidence(tx, evidenceId, patch, evidence.status);
    if (!updated)
      throw new AppError('This evidence was just reviewed — reload and try again', ErrorCodes.CONFLICT, 409);
    if (criterionIds) await replaceEvidenceCriteria(tx, evidenceId, criterionIds, staff ? 'STAFF' : 'LEARNER');
    if (files) {
      await markUploadsAttached(keptKeys, tx);
      await markUploadsRemoved(droppedKeys, tx);
    }
    await insertEvidenceNote(tx, {
      evidenceId,
      authorId: a.userId,
      kind: 'AUDIT',
      body: 'Evidence edited',
      statusAtTime: nextStatus
    });
    if (resubmitted) {
      await insertEvidenceNote(tx, {
        evidenceId,
        authorId: a.userId,
        kind: 'AUDIT',
        body: 'Evidence resubmitted',
        statusAtTime: nextStatus
      });
    }
    if (note) {
      await insertEvidenceNote(tx, {
        evidenceId,
        authorId: a.userId,
        kind: noteKindFor(a, note.kind),
        body: note.body,
        statusAtTime: nextStatus
      });
    }
    // A resubmission (or a re-link) changes which evidence is the latest for its task(s): keep the cache in step.
    await syncTaskStatuses(tx, [evidence.taskId, updated.taskId]);
    return { evidence: updated, detail: enrolment ? await recomputeEnrolment(tx, enrolment.id) : null };
  });

  await audit(actor, 'appr.evidence.updated', evidenceId, {
    fields: Object.keys(input),
    resubmitted
  });
  // Referred evidence fixed by the apprentice is back in the tutor's queue — tell them.
  if (resubmitted) {
    await notifySafely('evidence resubmitted', () =>
      notifyEvidenceSubmitted({ evidenceId, learnerId: evidence.learnerId })
    );
  }
  return { evidence: result.evidence, summary: result.detail ? toProgressSummary(result.detail) : null };
}

export async function reviewEvidence(actor: Actor, evidenceId: string, input: EvidenceReviewInput) {
  const a = assertStaff(actor);
  const evidence = await loadEvidenceForActor(actor, evidenceId);
  const next = reviewTransition(asStatus(evidence.status), input.decision, a.role);

  if (input.decision === 'ACCEPT' && input.criterionIds.length === 0) {
    throw badRequest('Confirm at least one criterion before accepting', 'criterionIds');
  }
  const criterionIds = input.criterionIds.length
    ? await assertCriteriaInProgramme(evidence.programmeId, input.criterionIds)
    : undefined;

  const enrolment = await getApprEnrolmentByProgrammeLearner(evidence.programmeId, evidence.learnerId);
  const result = await runInTransaction(async (tx) => {
    const updated = await updateApprEvidence(
      tx,
      evidenceId,
      { status: next, reviewedBy: a.userId, reviewedAt: new Date().toISOString() },
      evidence.status
    );
    if (!updated) throw new AppError('This evidence was just reviewed by someone else', ErrorCodes.CONFLICT, 409);
    if (criterionIds) await replaceEvidenceCriteria(tx, evidenceId, criterionIds, 'STAFF');
    await insertEvidenceNote(tx, {
      evidenceId,
      authorId: a.userId,
      kind: 'AUDIT',
      body: next === 'ACCEPTED' ? 'Evidence accepted' : 'Evidence referred',
      statusAtTime: next
    });
    if (input.note) {
      await insertEvidenceNote(tx, {
        evidenceId,
        authorId: a.userId,
        kind: noteKindFor(a, input.note.kind),
        body: input.note.body,
        statusAtTime: next
      });
    }
    await syncTaskStatuses(tx, [updated.taskId]);
    return { evidence: updated, detail: enrolment ? await recomputeEnrolment(tx, enrolment.id) : null };
  });

  await audit(actor, 'appr.evidence.reviewed', evidenceId, {
    decision: input.decision,
    from: evidence.status,
    to: next,
    criteria: criterionIds?.length ?? 0
  });
  await notifySafely('evidence reviewed', () =>
    notifyEvidenceReviewed({
      evidenceId,
      learnerId: evidence.learnerId,
      outcome: next === 'ACCEPTED' ? 'ACCEPTED' : 'REFERRED'
    })
  );
  return { evidence: result.evidence, summary: result.detail ? toProgressSummary(result.detail) : null };
}

export async function addEvidenceNote(actor: Actor, evidenceId: string, input: EvidenceNoteCreateInput) {
  const a = requireAuthed(actor);
  const evidence = await loadEvidenceForActor(actor, evidenceId);
  // A note changes no progress value, so there is no recompute — the transaction is just the client handle.
  const note = await runInTransaction((tx) =>
    insertEvidenceNote(tx, {
      evidenceId,
      authorId: a.userId,
      kind: noteKindFor(a, input.kind),
      body: input.body,
      statusAtTime: evidence.status
    })
  );
  await audit(actor, 'appr.evidence.note_added', evidenceId, { kind: note.kind });
  return note;
}
