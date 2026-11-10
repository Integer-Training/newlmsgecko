import { randomUUID } from 'node:crypto';

import { AppError, ErrorCodes } from '@api/utils/errors';
import { canAccessLearner, requireAuthed } from '@api/services/apprenticeship/access';
import { assertAllowedFile } from '@api/services/apprenticeship/checks';
import { ENROLMENT_ENTITY, notifySafely } from '@api/services/apprenticeship/notifications';
import { emitNotification } from '@api/services/comms/notify';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import { runInTransaction, sql, type DbOrTxClient } from '@cio/db/drizzle';
import { listTutorsForLearnerInOrg } from '@cio/db/queries/allocation';
import {
  countOnboardingTypes,
  deleteOnboardingDoc,
  deleteOnboardingType,
  filterProgrammeIdsInOrg,
  filterUploadKeysInOrg,
  getApprEnrolment,
  getOnboardingDoc,
  getOnboardingType,
  insertApprUploads,
  insertOnboardingTypes,
  isOnboardingTypeInUse,
  listOnboardingDocs,
  listOnboardingFileKeysForEnrolments,
  listOnboardingTypes,
  lockApprEnrolment,
  listOrgAdminIds,
  markUploadsAttached,
  markUploadsRemoved,
  reorderOnboardingTypes,
  reviewOnboardingDoc,
  updateOnboardingType,
  upsertOnboardingDoc,
  type ApprOnboardingCounts,
  type ApprOnboardingDocRow,
  type ApprOnboardingDocTypeRow
} from '@cio/db/queries/apprenticeship';
import { apprenticeshipOnboardingKeyPrefix, generateApprenticeshipOnboardingFileKey } from '@cio/core/utils/upload';
import { generateDocumentDownloadPresignedUrls, generateDocumentUploadPresignedUrl } from '@cio/core/utils/s3';
import { APPR_DEFAULT_ONBOARDING_DOC_TYPES, APPR_ONBOARDING_TYPES_MAX } from '@cio/utils/constants/apprenticeship';
import type {
  OnboardingDocReviewInput,
  OnboardingDocSaveInput,
  OnboardingPresignInput,
  OnboardingTypeCreateInput,
  OnboardingTypeUpdateInput
} from '@cio/utils/validation/apprenticeship';

// Gecko Apprenticeships — onboarding documents (photo ID, NI proof…). One slot per (enrolment, document type); the
// types are admin-configured per org (seeded with defaults on first read). Access:
//   ADMIN   → everything in their org, including the files.
//   LEARNER → their own enrolment, including the files; may upload / replace / withdraw until a slot is APPROVED.
//   TUTOR   → STATUS ONLY for learners they reach (canAccessLearner): never the files (photo ID is sensitive), never writes.
// Anything else is a 404 so ids cannot be probed. "Complete" = every active, required, applicable type has an APPROVED
// doc — computed on read, never stored.

type AuthedActor = Extract<Actor, { authenticated: true }>;
type Enrolment = NonNullable<Awaited<ReturnType<typeof getApprEnrolment>>>;
type Viewer = 'ADMIN' | 'LEARNER' | 'TUTOR';

const notFound = (what = 'Learner portfolio') => new AppError(`${what} not found`, ErrorCodes.NOT_FOUND, 404);
const badRequest = (message: string, field?: string) => new AppError(message, ErrorCodes.VALIDATION_ERROR, 400, field);
const conflict = (message: string) => new AppError(message, ErrorCodes.CONFLICT, 409);

function assertAdmin(actor: Actor): AuthedActor {
  const a = requireAuthed(actor);
  if (a.role !== 'ADMIN')
    throw new AppError('Only an admin can manage onboarding documents', ErrorCodes.FORBIDDEN, 403);
  return a;
}

/** Load the enrolment and say how the actor sees it. Not visible at all → 404. */
async function resolveViewer(
  actor: Actor,
  enrolmentId: string
): Promise<{ a: AuthedActor; enrolment: Enrolment; viewer: Viewer }> {
  const a = requireAuthed(actor);
  const enrolment = await getApprEnrolment(enrolmentId);
  if (!enrolment || enrolment.organizationId !== a.orgId) throw notFound();
  if (a.role === 'ADMIN') return { a, enrolment, viewer: 'ADMIN' };
  if (a.role === 'LEARNER' && a.userId === enrolment.learnerId) return { a, enrolment, viewer: 'LEARNER' };
  if (
    a.role === 'TUTOR' &&
    (await canAccessLearner(a, enrolment.organizationId, enrolment.learnerId, enrolment.programmeId))
  ) {
    return { a, enrolment, viewer: 'TUTOR' };
  }
  throw notFound();
}

/** Admin or the learner themselves; a tutor (who may only view status) gets the same 404 as a stranger. */
async function resolveOwnerOrAdmin(actor: Actor, enrolmentId: string) {
  const r = await resolveViewer(actor, enrolmentId);
  if (r.viewer === 'TUTOR') throw notFound();
  return r;
}

const applies = (type: Pick<ApprOnboardingDocTypeRow, 'programmeId'>, programmeId: string) =>
  type.programmeId === null || type.programmeId === programmeId;

// ── Seeding ──

/**
 * The first time an org's types are read, give it the defaults. The advisory lock + re-check inside the transaction means
 * two concurrent first reads never duplicate them.
 */
export async function ensureOnboardingTypes(organizationId: string): Promise<void> {
  if ((await countOnboardingTypes(organizationId)) > 0) return;
  await runInTransaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`appr_onboarding_seed:${organizationId}`}))`);
    if ((await countOnboardingTypes(organizationId, tx)) > 0) return;
    await insertOnboardingTypes(
      APPR_DEFAULT_ONBOARDING_DOC_TYPES.map((d, i) => ({
        organizationId,
        programmeId: null,
        label: d.label,
        description: d.description,
        required: d.required,
        allowNotHeld: d.allowNotHeld,
        sequence: i,
        active: true
      })),
      tx
    );
  });
}

// ── Completion (shared by the view and the "just became complete" check) ──

function summarise(types: ApprOnboardingDocTypeRow[], docs: ApprOnboardingDocRow[], programmeId: string) {
  const byType = new Map(docs.map((d) => [d.docTypeId, d]));
  const counts: ApprOnboardingCounts = { required: 0, approved: 0, submitted: 0, rejected: 0 };
  for (const t of types) {
    if (!t.active || !t.required || !applies(t, programmeId)) continue;
    counts.required += 1;
    const status = byType.get(t.id)?.status;
    if (status === 'APPROVED') counts.approved += 1;
    else if (status === 'SUBMITTED') counts.submitted += 1;
    else if (status === 'REJECTED') counts.rejected += 1;
  }
  return { counts, complete: counts.approved >= counts.required, byType };
}

async function isCompleteNow(enrolment: Enrolment, client: DbOrTxClient) {
  const [types, docRows] = await Promise.all([
    listOnboardingTypes(enrolment.organizationId, client),
    listOnboardingDocs(enrolment.id, client)
  ]);
  return summarise(
    types,
    docRows.map((r) => r.doc),
    enrolment.programmeId
  ).complete;
}

// ── Reads ──

export async function getOnboarding(actor: Actor, enrolmentId: string) {
  const { enrolment, viewer } = await resolveViewer(actor, enrolmentId);
  await ensureOnboardingTypes(enrolment.organizationId);
  const [types, docRows] = await Promise.all([
    listOnboardingTypes(enrolment.organizationId),
    listOnboardingDocs(enrolment.id)
  ]);
  const docs = docRows.map((r) => r.doc);
  const { counts, complete, byType } = summarise(types, docs, enrolment.programmeId);
  const extras = new Map(docRows.map((r) => [r.doc.id, r]));
  const canSeeFiles = viewer !== 'TUTOR';

  const items = types
    .filter((t) => (t.active && applies(t, enrolment.programmeId)) || byType.has(t.id))
    .map((t) => {
      const doc = byType.get(t.id);
      const x = doc ? extras.get(doc.id) : undefined;
      return {
        type: {
          id: t.id,
          label: t.label,
          description: t.description,
          required: t.required,
          allowNotHeld: t.allowNotHeld,
          // No longer applicable counts as inactive: it never counts toward complete.
          active: t.active && applies(t, enrolment.programmeId)
        },
        doc: doc
          ? {
              id: doc.id,
              status: doc.status,
              notHeld: doc.notHeld,
              learnerNote: doc.learnerNote,
              reviewNote: doc.reviewNote,
              reviewedByName: x?.reviewedByName ?? null,
              reviewedAt: doc.reviewedAt,
              submittedByName: x?.submittedByName ?? null,
              submittedAt: doc.submittedAt,
              files: canSeeFiles
                ? doc.files.map((f) => ({ key: f.key, name: f.name, size: f.size, type: f.type }))
                : [],
              fileCount: doc.files.length
            }
          : null
      };
    });

  return { enrolmentId: enrolment.id, complete, counts, canSeeFiles, items };
}

// ── Learner / admin writes ──

/** The type must exist in the org, apply to this enrolment's programme and (for writes) be active. */
async function loadWritableType(enrolment: Enrolment, docTypeId: string) {
  const type = await getOnboardingType(enrolment.organizationId, docTypeId);
  if (!type || !applies(type, enrolment.programmeId)) throw notFound('Document type');
  if (!type.active) throw badRequest('This document is no longer requested', 'docTypeId');
  return type;
}

function assertLearnerMayChange(viewer: Viewer, doc: ApprOnboardingDocRow | null) {
  if (viewer === 'LEARNER' && doc?.status === 'APPROVED') {
    throw conflict('This document is already approved — ask your provider if it needs to change');
  }
}

export async function presignOnboardingUploads(actor: Actor, enrolmentId: string, input: OnboardingPresignInput) {
  const { a, enrolment, viewer } = await resolveOwnerOrAdmin(actor, enrolmentId);
  await loadWritableType(enrolment, input.docTypeId);
  assertLearnerMayChange(viewer, await getOnboardingDoc(enrolment.id, input.docTypeId));

  for (const f of input.files) assertAllowedFile(f);
  const files = await Promise.all(
    input.files.map(async (f) => {
      let key: string;
      try {
        key = generateApprenticeshipOnboardingFileKey(
          enrolment.programmeId,
          enrolment.learnerId,
          enrolment.id,
          input.docTypeId,
          f.name
        );
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
      ownerId: a.userId,
      key: f.key
    }))
  );
  return { files };
}

export async function saveOnboardingDoc(
  actor: Actor,
  enrolmentId: string,
  docTypeId: string,
  input: OnboardingDocSaveInput
) {
  const { a, enrolment, viewer } = await resolveOwnerOrAdmin(actor, enrolmentId);
  const type = await loadWritableType(enrolment, docTypeId);
  if (input.notHeld && !type.allowNotHeld) {
    throw badRequest('This document must be uploaded', 'notHeld');
  }
  const previous = await getOnboardingDoc(enrolment.id, docTypeId);
  assertLearnerMayChange(viewer, previous);

  // "I don't have this" replaces any files.
  const incoming = input.notHeld ? [] : input.files;
  const prefix = apprenticeshipOnboardingKeyPrefix(enrolment.programmeId, enrolment.learnerId, enrolment.id, docTypeId);
  const owned = new Map((previous?.files ?? []).map((f) => [f.key, f]));
  for (const f of incoming) {
    if (!owned.has(f.key) && !f.key.startsWith(prefix)) throw badRequest('Invalid file reference', 'files');
    assertAllowedFile(f);
  }
  // NEW keys must still be a live upload issued to this learner (the clean-up job may have collected an old one).
  const fresh = incoming.filter((f) => !owned.has(f.key)).map((f) => f.key);
  if (fresh.length > 0) {
    const live = new Set(
      await filterUploadKeysInOrg(enrolment.organizationId, fresh, { learnerId: enrolment.learnerId, notRemoved: true })
    );
    if (fresh.some((k) => !live.has(k))) {
      throw badRequest('This file upload has expired — please upload it again', 'files');
    }
  }

  const now = new Date().toISOString();
  const files = incoming.map(
    (f) =>
      owned.get(f.key) ?? {
        key: f.key,
        name: f.name,
        size: f.size,
        type: f.type,
        uploadedBy: a.userId,
        uploadedAt: now
      }
  );
  const keptKeys = files.map((f) => f.key);
  const droppedKeys = [...owned.keys()].filter((k) => !keptKeys.includes(k));

  const doc = await runInTransaction(async (tx) => {
    const saved = await upsertOnboardingDoc(
      {
        organizationId: enrolment.organizationId,
        enrolmentId: enrolment.id,
        learnerId: enrolment.learnerId,
        docTypeId,
        files,
        notHeld: input.notHeld,
        learnerNote: input.learnerNote ?? null,
        submittedBy: a.userId
      },
      tx
    );
    await markUploadsAttached(keptKeys, tx);
    await markUploadsRemoved(droppedKeys, tx);
    return saved;
  });

  await recordAudit({
    actor: a,
    action: 'appr.onboarding.submit',
    entityType: 'appr_onboarding_doc',
    entityId: doc.id,
    metadata: { enrolmentId: enrolment.id, docTypeId, files: files.length, notHeld: input.notHeld }
  });
  // One alert per save, to the org's admins; not when an admin did it themselves.
  if (viewer === 'LEARNER') {
    await notifySafely('onboarding submitted', async () => {
      const admins = await listOrgAdminIds(enrolment.organizationId);
      if (admins.length === 0) return;
      await emitNotification({
        type: 'appr.onboarding.submitted',
        recipients: admins.map((userId) => ({ userId })),
        entityType: ENROLMENT_ENTITY,
        entityId: enrolment.id
      });
    });
  }
  return { id: doc.id, status: doc.status };
}

export async function withdrawOnboardingDoc(actor: Actor, enrolmentId: string, docTypeId: string) {
  const { a, enrolment, viewer } = await resolveOwnerOrAdmin(actor, enrolmentId);
  const doc = await getOnboardingDoc(enrolment.id, docTypeId);
  if (!doc) throw notFound('Document');
  assertLearnerMayChange(viewer, doc);
  await runInTransaction(async (tx) => {
    await markUploadsRemoved(
      doc.files.map((f) => f.key),
      tx
    );
    await deleteOnboardingDoc(doc.id, tx);
  });
  await recordAudit({
    actor: a,
    action: 'appr.onboarding.withdraw',
    entityType: 'appr_onboarding_doc',
    entityId: doc.id,
    metadata: { enrolmentId: enrolment.id, docTypeId }
  });
  return { id: doc.id };
}

// ── Review (admin) ──

export async function reviewOnboardingDocument(
  actor: Actor,
  enrolmentId: string,
  docTypeId: string,
  input: OnboardingDocReviewInput
) {
  // A tutor (status-only) or stranger sees a 404; the learner reaches it but may not review (403).
  const { a, enrolment } = await resolveOwnerOrAdmin(actor, enrolmentId);
  assertAdmin(a);
  const existing = await getOnboardingDoc(enrolment.id, docTypeId);
  if (!existing) throw notFound('Document');
  const status = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';

  const { reviewed, becameComplete } = await runInTransaction(async (tx) => {
    // Serialise reviews of one enrolment so exactly one of them sees the incomplete → complete transition.
    await lockApprEnrolment(tx, enrolment.id);
    const before = await isCompleteNow(enrolment, tx);
    const row = await reviewOnboardingDoc(
      existing.id,
      input.expectedStatus,
      { status, reviewNote: input.decision === 'REJECT' ? (input.note ?? null) : null, reviewedBy: a.userId },
      tx
    );
    if (!row) throw conflict('This document changed — reload');
    const after = await isCompleteNow(enrolment, tx);
    return { reviewed: row, becameComplete: !before && after };
  });

  await recordAudit({
    actor: a,
    action: 'appr.onboarding.review',
    entityType: 'appr_onboarding_doc',
    entityId: reviewed.id,
    metadata: { enrolmentId: enrolment.id, docTypeId, decision: input.decision }
  });
  await notifySafely('onboarding reviewed', () =>
    emitNotification({
      type: 'appr.onboarding.reviewed',
      recipients: [{ userId: enrolment.learnerId }],
      entityType: 'appr_onboarding_doc',
      entityId: reviewed.id
    })
  );
  if (becameComplete) {
    await notifySafely('onboarding complete', async () => {
      const [tutors, admins] = await Promise.all([
        listTutorsForLearnerInOrg(enrolment.learnerId, enrolment.organizationId),
        listOrgAdminIds(enrolment.organizationId)
      ]);
      const recipients = [...new Set([...tutors.map((t) => t.tutorId), ...admins])];
      if (recipients.length === 0) return;
      await emitNotification({
        type: 'appr.onboarding.complete',
        recipients: recipients.map((userId) => ({ userId })),
        entityType: ENROLMENT_ENTITY,
        entityId: enrolment.id
      });
    });
  }
  return { id: reviewed.id, status: reviewed.status, becameComplete };
}

// ── Downloads ──

/** Signed short-lived URLs. Admin or the learner only; every key must be on THIS doc. */
export async function signOnboardingDownloads(actor: Actor, enrolmentId: string, docTypeId: string, keys: string[]) {
  const { a, enrolment } = await resolveOwnerOrAdmin(actor, enrolmentId);
  const doc = await getOnboardingDoc(enrolment.id, docTypeId);
  if (!doc) throw notFound('Document');
  const owned = new Set(doc.files.map((f) => f.key));
  if (!keys.every((k) => owned.has(k))) {
    throw new AppError('You do not have access to these files', ErrorCodes.FORBIDDEN, 403);
  }
  const urls = await generateDocumentDownloadPresignedUrls(keys);
  await recordAudit({
    actor: a,
    action: 'appr.onboarding.download',
    entityType: 'appr_onboarding_doc',
    entityId: doc.id,
    metadata: { enrolmentId: enrolment.id, files: keys.length }
  });
  return urls;
}

// ── Types admin ──

export async function listOnboardingTypesAdmin(actor: Actor) {
  const a = assertAdmin(actor);
  await ensureOnboardingTypes(a.orgId);
  const types = await listOnboardingTypes(a.orgId);
  return Promise.all(types.map(async (t) => ({ ...t, inUse: await isOnboardingTypeInUse(t.id) })));
}

async function assertProgrammeInOrg(orgId: string, programmeId: string | null | undefined) {
  if (!programmeId) return;
  const valid = await filterProgrammeIdsInOrg(orgId, [programmeId]);
  if (valid.length !== 1) throw badRequest('Programme not found', 'programmeId');
}

export async function createOnboardingType(actor: Actor, input: OnboardingTypeCreateInput) {
  const a = assertAdmin(actor);
  await ensureOnboardingTypes(a.orgId);
  if ((await countOnboardingTypes(a.orgId)) >= APPR_ONBOARDING_TYPES_MAX) {
    throw badRequest(`You can have at most ${APPR_ONBOARDING_TYPES_MAX} document types`);
  }
  await assertProgrammeInOrg(a.orgId, input.programmeId);
  const existing = await listOnboardingTypes(a.orgId);
  const [row] = await insertOnboardingTypes([
    {
      id: randomUUID(),
      organizationId: a.orgId,
      programmeId: input.programmeId ?? null,
      label: input.label,
      description: input.description ?? null,
      required: input.required,
      allowNotHeld: input.allowNotHeld,
      active: input.active,
      sequence: existing.reduce((m, t) => Math.max(m, t.sequence + 1), 0)
    }
  ]);
  await recordAudit({
    actor: a,
    action: 'appr.onboarding_type.create',
    entityType: 'appr_onboarding_doc_type',
    entityId: row!.id
  });
  return row!;
}

export async function updateOnboardingTypeAdmin(actor: Actor, typeId: string, input: OnboardingTypeUpdateInput) {
  const a = assertAdmin(actor);
  const type = await getOnboardingType(a.orgId, typeId);
  if (!type) throw notFound('Document type');
  if (input.programmeId !== undefined) await assertProgrammeInOrg(a.orgId, input.programmeId);
  const row = await updateOnboardingType(a.orgId, typeId, input);
  await recordAudit({
    actor: a,
    action: 'appr.onboarding_type.update',
    entityType: 'appr_onboarding_doc_type',
    entityId: typeId,
    metadata: { fields: Object.keys(input) }
  });
  return row!;
}

export async function reorderOnboardingTypesAdmin(actor: Actor, typeIds: string[]) {
  const a = assertAdmin(actor);
  const mine = new Set((await listOnboardingTypes(a.orgId)).map((t) => t.id));
  if (new Set(typeIds).size !== typeIds.length || !typeIds.every((id) => mine.has(id))) {
    throw badRequest('One or more document types were not found', 'typeIds');
  }
  await runInTransaction((tx) => reorderOnboardingTypes(a.orgId, typeIds, tx));
  await recordAudit({
    actor: a,
    action: 'appr.onboarding_type.reorder',
    entityType: 'appr_onboarding_doc_type',
    metadata: { types: typeIds.length }
  });
  return listOnboardingTypesAdmin(a);
}

export async function deleteOnboardingTypeAdmin(actor: Actor, typeId: string) {
  const a = assertAdmin(actor);
  const type = await getOnboardingType(a.orgId, typeId);
  if (!type) throw notFound('Document type');
  if (await isOnboardingTypeInUse(typeId)) throw conflict('In use — deactivate it instead');
  await deleteOnboardingType(a.orgId, typeId);
  await recordAudit({
    actor: a,
    action: 'appr.onboarding_type.delete',
    entityType: 'appr_onboarding_doc_type',
    entityId: typeId
  });
  return { id: typeId };
}

// ── Enrolment deletion hook ──

/**
 * Call inside the enrolment-deletion transaction, BEFORE the enrolment rows are deleted (the docs cascade away with
 * them): marks every onboarding file as removed so the clean-up job collects it from storage.
 */
export async function markOnboardingFilesRemovedForEnrolments(enrolmentIds: string[], tx: DbOrTxClient) {
  const keys = await listOnboardingFileKeysForEnrolments(enrolmentIds, tx);
  await markUploadsRemoved(keys, tx);
}
