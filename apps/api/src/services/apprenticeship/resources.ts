import { randomUUID } from 'node:crypto';

import { AppError, ErrorCodes } from '@api/utils/errors';
import {
  assertStaff,
  getEnrolmentForActor,
  getProgrammeForActor,
  requireAuthed
} from '@api/services/apprenticeship/access';
import { assertActiveType, assertCriteriaInProgramme } from '@api/services/apprenticeship/checks';
import { notifyResourcesAdded, notifySafely } from '@api/services/apprenticeship/notifications';
import { redis } from '@cio/core/utils/redis/redis';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import { runInTransaction } from '@cio/db/drizzle';
import {
  countEvidenceForResource,
  countResourcesByScope,
  deleteResource,
  filterUploadKeysInOrg,
  getApprEnrolmentByProgrammeLearner,
  getApprProgramme,
  getLinkedEnrolment,
  getResource,
  insertApprUploads,
  insertResource,
  isProgrammeTutor,
  latestEvidenceByResource,
  listApprEnrolmentsByIds,
  listEnrolmentIdsForProgramme,
  listProgrammeUnits,
  listResourceActivityForLearner,
  listResourcesForProgrammes,
  markUploadsAttached,
  markUploadsRemoved,
  nextResourceSort,
  recordResourceActivity,
  reorderResources,
  replaceResourceFile,
  setSuggestedCriteria,
  updateResource,
  type ApprResourceListItem
} from '@cio/db/queries/apprenticeship';
import { getStorageConfig } from '@cio/core/config/storage';
import { getUploadLimits } from '@cio/core/config/upload-limits';
import { apprenticeshipResourceKeyPrefix, generateApprenticeshipResourceFileKey } from '@cio/core/utils/upload';
import {
  generateAttachmentPresignedUrl,
  generateDocumentUploadPresignedUrl,
  getS3ObjectStream
} from '@cio/core/utils/s3';
import { apprResourceMimeForFile, type ApprResourceKind } from '@cio/utils/constants/apprenticeship';

// Gecko Apprenticeships — resources (learning resources + workbooks). Access rules (plan §Access matrix, owner answer 6a):
//   ADMIN   → manage everything in their org (writes are admin-only), read/download/preview anything.
//   TUTOR   → read + download resources of a programme they tutor, or of a programme of a learner they reach (pair).
//   LEARNER → ACTIVE resources of their own non-withdrawn halves only (a withdrawn half = no access, 404). WORKBOOK can
//             be downloaded; LEARNING is view-only (download 403; content streamed inline through the API, no S3 URL).
// Anything not visible is a 404 so ids of other orgs/learners/programmes cannot be probed. A file key is only accepted
// from the client on create/replace, where it must sit under the resource's own prefix AND match an appr_upload row
// issued to the org; content/download always use the key stored on the resource.

const notFound = () => new AppError('Resource not found', ErrorCodes.NOT_FOUND, 404);
const badRequest = (message: string, field?: string) => new AppError(message, ErrorCodes.VALIDATION_ERROR, 400, field);

export const RESOURCE_ENTITY = 'appr_resource';

function assertAdmin(actor: Actor) {
  const a = requireAuthed(actor);
  if (a.role !== 'ADMIN') throw new AppError('You do not have access to this action', ErrorCodes.FORBIDDEN, 403);
  return a;
}

const audit = (actor: Actor, action: string, entityId: string, metadata: Record<string, unknown> = {}) =>
  recordAudit({ actor, action, entityType: RESOURCE_ENTITY, entityId, metadata });

// ── File checks ──

/** Extension must be allowed for the kind; size within the document limit. Returns the canonical (server-derived) MIME. */
function assertResourceFile(kind: ApprResourceKind, f: { name: string; size?: number }): string {
  const mime = apprResourceMimeForFile(kind, f.name);
  if (!mime) {
    const ext = f.name.split('.').pop()?.toLowerCase();
    if (kind === 'LEARNING') {
      throw badRequest(
        ext === 'doc'
          ? `"${f.name}" is an old Word format. Save it as .docx or PDF and upload again.`
          : `"${f.name}" is not accepted. Learning resources must be PDF or Word (.docx).`,
        'file'
      );
    }
    throw badRequest(`"${f.name}" is not accepted. Workbooks can be PDF, Word, Excel or PowerPoint.`, 'file');
  }
  if (f.size !== undefined) {
    const max = getUploadLimits().documentBytes;
    if (f.size > max) {
      throw new AppError(
        `"${f.name}" is too large. The maximum size is ${Math.round(max / 1024 / 1024)}MB.`,
        'FILE_TOO_LARGE',
        413
      );
    }
  }
  return mime;
}

/** The key must sit under this resource's own prefix and have been issued to this org by a presign (and not removed). */
async function assertResourceKey(organizationId: string, programmeId: string, resourceId: string, key: string) {
  if (!key.startsWith(apprenticeshipResourceKeyPrefix(programmeId, resourceId))) {
    throw badRequest('Invalid file reference', 'file');
  }
  const known = await filterUploadKeysInOrg(organizationId, [key], { notRemoved: true });
  if (!known.includes(key)) throw badRequest('Upload the file before saving', 'file');
}

async function assertUnitInProgramme(programmeId: string, unitId: string) {
  const units = await listProgrammeUnits(programmeId);
  if (!units.some((u) => u.unitId === unitId)) throw badRequest('Unit not found in this programme', 'unitId');
}

// ── Shaping ──

export function shapeResource(r: ApprResourceListItem, evidenceCount = 0) {
  return {
    id: r.id,
    programmeId: r.programmeId,
    unitId: r.unitId,
    unitTitle: r.unitTitle,
    unitCode: r.unitCode,
    kind: r.kind as ApprResourceKind,
    title: r.title,
    description: r.description || null,
    file: { name: r.file.name, size: r.file.size, type: r.file.type },
    version: r.version,
    sort: r.sort,
    status: r.status as 'ACTIVE' | 'ARCHIVED',
    evidenceTypeKey: r.evidenceTypeKey,
    criterionIds: r.criterionIds,
    evidenceCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  };
}

async function loadResource(actor: Actor, resourceId: string): Promise<ApprResourceListItem> {
  const a = requireAuthed(actor);
  const resource = await getResource(resourceId, a.orgId);
  if (!resource) throw notFound();
  return resource;
}

// ── Staff reads ──

export async function listProgrammeResources(
  actor: Actor,
  programmeId: string,
  query: { status?: 'ACTIVE' | 'ARCHIVED' | 'ALL'; kind?: ApprResourceKind } = {}
) {
  const a = assertStaff(actor);
  const programme = await getProgrammeForActor(a, programmeId);
  const status = query.status === 'ALL' || !query.status ? undefined : query.status;
  const items = await listResourcesForProgrammes({
    organizationId: a.orgId,
    programmeIds: [programme.id],
    status,
    kind: query.kind
  });
  const counts = await Promise.all(items.map((i) => countEvidenceForResource(i.id)));
  return {
    resources: items.map((i, idx) => shapeResource(i, counts[idx])),
    counts: await countResourcesByScope(programme.id, a.orgId)
  };
}

// ── Uploads ──

export async function presignResourceUpload(
  actor: Actor,
  input: {
    programmeId: string;
    resourceId?: string;
    kind: ApprResourceKind;
    fileName: string;
    contentType: string;
    size: number;
  }
) {
  const a = assertAdmin(actor);
  const programme = await getProgrammeForActor(a, input.programmeId);
  let resourceId = input.resourceId;
  if (resourceId) {
    // Replacing a file: the resource must exist in this programme.
    const existing = await getResource(resourceId, a.orgId);
    if (!existing || existing.programmeId !== programme.id) throw notFound();
  } else {
    resourceId = randomUUID();
  }
  const mime = assertResourceFile(input.kind, { name: input.fileName, size: input.size });
  let key: string;
  try {
    key = generateApprenticeshipResourceFileKey(programme.id, resourceId, input.fileName);
  } catch {
    throw badRequest(`"${input.fileName}" needs a file extension`, 'fileName');
  }
  const uploadUrl = await generateDocumentUploadPresignedUrl(key, mime);
  await insertApprUploads([{ organizationId: a.orgId, learnerId: null, ownerId: resourceId, key }]);
  return { resourceId, key, uploadUrl };
}

// ── Staff writes ──

export interface ResourceCreateBody {
  id: string;
  programmeId: string;
  unitId?: string | null;
  kind: ApprResourceKind;
  title: string;
  description?: string;
  file: { key: string; name: string; size: number; type: string };
  evidenceTypeKey?: string | null;
  criterionIds?: string[];
}

export async function createResource(actor: Actor, input: ResourceCreateBody) {
  const a = assertAdmin(actor);
  const programme = await getProgrammeForActor(a, input.programmeId);
  if (programme.status !== 'ACTIVE') throw badRequest('This programme is archived', 'programmeId');
  if (await getResource(input.id, a.orgId)) {
    throw new AppError('This resource has already been saved', ErrorCodes.CONFLICT, 409);
  }
  const mime = assertResourceFile(input.kind, input.file);
  await assertResourceKey(a.orgId, programme.id, input.id, input.file.key);
  const unitId = input.unitId ?? null;
  if (unitId) await assertUnitInProgramme(programme.id, unitId);
  if (input.evidenceTypeKey) await assertActiveType(a.orgId, input.evidenceTypeKey);
  const criterionIds = await assertCriteriaInProgramme(programme.id, input.criterionIds ?? []);

  const sort = await nextResourceSort(programme.id, unitId);
  await runInTransaction(async (tx) => {
    await insertResource(
      {
        id: input.id,
        organizationId: a.orgId,
        programmeId: programme.id,
        unitId,
        kind: input.kind,
        title: input.title,
        description: input.description ?? '',
        file: { key: input.file.key, name: input.file.name, size: input.file.size, type: mime },
        sort,
        evidenceTypeKey: input.evidenceTypeKey ?? null,
        createdBy: a.userId
      },
      tx
    );
    await setSuggestedCriteria(input.id, criterionIds, tx);
    await markUploadsAttached([input.file.key], tx);
  });
  await audit(actor, 'appr.resource.created', input.id, { programmeId: programme.id, kind: input.kind, unitId });
  const created = await getResource(input.id, a.orgId);
  return shapeResource(created!, 0);
}

export interface ResourceUpdateBody {
  title?: string;
  description?: string;
  unitId?: string | null;
  kind?: ApprResourceKind;
  evidenceTypeKey?: string | null;
  criterionIds?: string[];
  file?: { key: string; name: string; size: number; type: string };
}

export async function updateResourceById(actor: Actor, resourceId: string, input: ResourceUpdateBody) {
  const a = assertAdmin(actor);
  const resource = await loadResource(actor, resourceId);
  const kind = input.kind ?? (resource.kind as ApprResourceKind);
  if (resource.kind === 'WORKBOOK' && kind === 'LEARNING' && (await countEvidenceForResource(resource.id)) > 0) {
    throw new AppError(
      'This workbook is used as evidence — archive it and add a new learning resource instead',
      ErrorCodes.CONFLICT,
      409
    );
  }

  let mime: string | null = null;
  const replacing = !!input.file && input.file.key !== resource.file.key;
  if (input.file) {
    mime = assertResourceFile(kind, input.file);
    if (replacing) await assertResourceKey(a.orgId, resource.programmeId, resource.id, input.file.key);
  } else if (input.kind && input.kind !== resource.kind) {
    // Changing kind keeps the file: it must still be allowed for the new kind (an .xlsx workbook cannot become learning).
    assertResourceFile(kind, resource.file);
  }
  if (input.unitId && input.unitId !== resource.unitId) await assertUnitInProgramme(resource.programmeId, input.unitId);
  if (input.evidenceTypeKey) await assertActiveType(a.orgId, input.evidenceTypeKey);
  const criterionIds = input.criterionIds
    ? await assertCriteriaInProgramme(resource.programmeId, input.criterionIds)
    : undefined;

  const unitChanged = input.unitId !== undefined && input.unitId !== resource.unitId;
  const sort = unitChanged ? await nextResourceSort(resource.programmeId, input.unitId ?? null) : undefined;

  await runInTransaction(async (tx) => {
    const patch: Parameters<typeof updateResource>[2] = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.evidenceTypeKey !== undefined) patch.evidenceTypeKey = input.evidenceTypeKey;
    if (unitChanged) {
      patch.unitId = input.unitId ?? null;
      patch.sort = sort;
    }
    await updateResource(resource.id, a.orgId, patch, tx);
    if (criterionIds) await setSuggestedCriteria(resource.id, criterionIds, tx);
    if (replacing && input.file) {
      // version + 1: learners see an "Updated" badge; earlier submissions are untouched.
      await replaceResourceFile(
        resource.id,
        a.orgId,
        { key: input.file.key, name: input.file.name, size: input.file.size, type: mime! },
        tx
      );
      await markUploadsAttached([input.file.key], tx);
      await markUploadsRemoved([resource.file.key], tx);
    }
  });
  await audit(actor, 'appr.resource.updated', resource.id, { fields: Object.keys(input), replaced: replacing });
  const fresh = await getResource(resource.id, a.orgId);
  return shapeResource(fresh!, await countEvidenceForResource(resource.id));
}

export async function setResourceArchived(actor: Actor, resourceId: string, archived: boolean) {
  const a = assertAdmin(actor);
  const resource = await loadResource(actor, resourceId);
  await updateResource(resource.id, a.orgId, { status: archived ? 'ARCHIVED' : 'ACTIVE' });
  await audit(actor, archived ? 'appr.resource.archived' : 'appr.resource.restored', resource.id);
  const fresh = await getResource(resource.id, a.orgId);
  return shapeResource(fresh!, await countEvidenceForResource(resource.id));
}

export async function deleteResourceById(actor: Actor, resourceId: string) {
  const a = assertAdmin(actor);
  const resource = await loadResource(actor, resourceId);
  if ((await countEvidenceForResource(resource.id)) > 0) {
    throw new AppError(
      'Learners have submitted evidence for this resource. Archive it instead.',
      ErrorCodes.CONFLICT,
      409
    );
  }
  await runInTransaction(async (tx) => {
    await deleteResource(resource.id, a.orgId, tx);
    await markUploadsRemoved([resource.file.key], tx);
  });
  await audit(actor, 'appr.resource.deleted', resource.id, { programmeId: resource.programmeId });
  return { id: resource.id };
}

export async function reorderProgrammeResources(
  actor: Actor,
  programmeId: string,
  input: { unitId?: string | null; ids: string[] }
) {
  const a = assertAdmin(actor);
  const programme = await getProgrammeForActor(a, programmeId);
  const scope = await listResourcesForProgrammes({
    organizationId: a.orgId,
    programmeIds: [programme.id],
    unitId: input.unitId ?? null
  });
  const inScope = new Set(scope.map((r) => r.id));
  const ids = [...new Set(input.ids)];
  if (ids.some((id) => !inScope.has(id))) throw badRequest('One or more resources are not in this section', 'ids');
  await reorderResources(programme.id, a.orgId, ids);
  return { ids };
}

/** One in-app notification per active (non-withdrawn) learner of the programme, per save batch. */
export async function notifyProgrammeResources(actor: Actor, programmeId: string, resourceIds: string[]) {
  const a = assertAdmin(actor);
  const programme = await getProgrammeForActor(a, programmeId);
  const unique = [...new Set(resourceIds)].slice(0, 100);
  const items = await listResourcesForProgrammes({
    organizationId: a.orgId,
    programmeIds: [programme.id],
    status: 'ACTIVE'
  });
  const valid = new Set(items.map((r) => r.id));
  if (unique.some((id) => !valid.has(id))) throw badRequest('One or more resources are not available', 'resourceIds');

  // Cooldown: a resource already announced in the last 24h is not announced again (fails open if Redis is down).
  const fresh: string[] = [];
  for (const id of unique) {
    try {
      if ((await redis.set(`appr:resnotify:${id}`, '1', { NX: true, EX: 86400 })) === 'OK') fresh.push(id);
    } catch {
      fresh.push(id);
    }
  }
  if (fresh.length === 0) return { notified: 0 };

  // A Diploma + Standard pair is ONE learner holding an enrolment on each half, so the learners of a paired
  // diploma / standard are reached through their own enrolment on this programme. A withdrawn half loses access to
  // the programme's resources, so it is not told. Deduped by learner.
  const enrolments = await listApprEnrolmentsByIds(await listEnrolmentIdsForProgramme(programme.id));
  const learnerIds = [...new Set(enrolments.filter((e) => !e.withdrawnAt).map((e) => e.learnerId))];
  if (learnerIds.length === 0) return { notified: 0 };
  await notifySafely('resources added', () => notifyResourcesAdded({ resourceId: fresh[0], learnerIds }));
  await audit(actor, 'appr.resource.notified', fresh[0], { programmeId: programme.id, count: fresh.length });
  return { notified: learnerIds.length };
}

// ── Pair halves ──

interface Half {
  enrolmentId: string;
  programmeId: string;
  title: string;
  type: 'DIPLOMA' | 'STANDARD';
  withdrawn: boolean;
}

/** The enrolment's own half plus its linked counterpart (a Diploma + Standard pair), each with a withdrawn flag. */
async function getHalves(enrolment: { id: string; programmeId: string; withdrawnAt?: string | null }): Promise<Half[]> {
  const linked = await getLinkedEnrolment(enrolment.id);
  const rows = [enrolment, ...(linked ? [linked] : [])];
  const out: Half[] = [];
  for (const e of rows) {
    const programme = await getApprProgramme(e.programmeId);
    if (!programme) continue;
    out.push({
      enrolmentId: e.id,
      programmeId: e.programmeId,
      title: programme.title,
      type: programme.type as 'DIPLOMA' | 'STANDARD',
      withdrawn: !!e.withdrawnAt
    });
  }
  return out;
}

// ── Learner / staff-viewing-learner list ──

export async function listResourcesForEnrolment(actor: Actor, enrolmentId: string) {
  const a = requireAuthed(actor);
  const enrolment = await getEnrolmentForActor(actor, enrolmentId);
  const halves = await getHalves(enrolment);
  // Withdrawn = no access for the learner (owner answer 6a); staff see the withdrawn half flagged.
  const visible = a.role === 'LEARNER' ? halves.filter((h) => !h.withdrawn) : halves;
  const programmes = visible.map((h) => ({
    enrolmentId: h.enrolmentId,
    programmeId: h.programmeId,
    title: h.title,
    type: h.type,
    withdrawn: h.withdrawn
  }));
  if (visible.length === 0) return { programmes, resources: [] };

  const items = await listResourcesForProgrammes({
    organizationId: enrolment.organizationId,
    programmeIds: visible.map((h) => h.programmeId),
    status: 'ACTIVE'
  });
  const ids = items.map((i) => i.id);
  const [activityRows, latest] = await Promise.all([
    ids.length ? listResourceActivityForLearner(enrolment.learnerId, ids) : [],
    ids.length ? latestEvidenceByResource(enrolment.learnerId, ids) : new Map<string, { id: string; status: string }>()
  ]);
  const activityByKey = new Map(activityRows.map((r) => [`${r.resourceId}:${r.enrolmentId}`, r]));
  const halfByProgramme = new Map(visible.map((h) => [h.programmeId, h]));

  const resources = items.map((i) => {
    const half = halfByProgramme.get(i.programmeId)!;
    const { evidenceCount: _evidenceCount, ...rest } = shapeResource(i);
    const act = activityByKey.get(`${i.id}:${half.enrolmentId}`) ?? null;
    const ev = latest.get(i.id) ?? null;
    let status: 'NOT_STARTED' | 'VIEWED' | 'DOWNLOADED' | 'SUBMITTED' | 'REFERRED' | 'ACCEPTED' = 'NOT_STARTED';
    if (ev && (ev.status === 'SUBMITTED' || ev.status === 'REFERRED' || ev.status === 'ACCEPTED')) status = ev.status;
    else if (act?.firstDownloadedAt) status = 'DOWNLOADED';
    else if (act?.firstViewedAt) status = 'VIEWED';
    return {
      ...rest,
      enrolmentId: half.enrolmentId,
      programmeTitle: i.programmeTitle,
      programmeType: half.type,
      downloadable: a.role === 'LEARNER' ? i.kind === 'WORKBOOK' : true,
      activity: act
        ? {
            firstViewedAt: act.firstViewedAt,
            lastDownloadedAt: act.lastDownloadedAt,
            downloadCount: act.downloadCount,
            lastVersion: act.lastVersion
          }
        : null,
      updatedSinceDownload: !!act && !!act.firstDownloadedAt && act.lastVersion < i.version,
      status,
      latestEvidenceId: ev?.id ?? null
    };
  });
  return { programmes, resources };
}

// ── Content + download ──

/**
 * Resolve who may open this resource, or 404. For a learner it also returns the half (enrolment on the resource's
 * programme) their views/downloads are recorded against.
 */
async function authorizeResource(actor: Actor, resourceId: string, enrolmentId?: string) {
  const a = requireAuthed(actor);
  const resource = await loadResource(actor, resourceId);
  const none = { resource, learnerEnrolmentId: null as string | null, learnerId: null as string | null };

  if (a.role === 'LEARNER') {
    if (resource.status !== 'ACTIVE') throw notFound();
    let half: Half | undefined;
    if (enrolmentId) {
      const enrolment = await getEnrolmentForActor(actor, enrolmentId);
      half = (await getHalves(enrolment)).find((h) => h.programmeId === resource.programmeId);
    } else {
      const own = await getApprEnrolmentByProgrammeLearner(resource.programmeId, a.userId);
      if (own) half = (await getHalves(own)).find((h) => h.programmeId === resource.programmeId);
    }
    if (!half || half.withdrawn) throw notFound();
    return { resource, learnerEnrolmentId: half.enrolmentId, learnerId: a.userId };
  }

  if (a.role === 'ADMIN' || a.role === 'TUTOR') {
    if (enrolmentId) {
      const enrolment = await getEnrolmentForActor(actor, enrolmentId);
      if (!(await getHalves(enrolment)).some((h) => h.programmeId === resource.programmeId)) throw notFound();
    } else if (a.role === 'TUTOR' && !(await isProgrammeTutor(resource.programmeId, a.userId))) {
      throw notFound();
    }
    return none;
  }
  throw notFound();
}

export function contentDispositionInline(fileName: string): string {
  // eslint-disable-next-line no-control-regex
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') || 'resource';
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Open the stored file for inline viewing. The key is always the resource's own current key (never from the client). */
export async function openResourceContent(actor: Actor, resourceId: string, enrolmentId?: string) {
  const { resource, learnerEnrolmentId, learnerId } = await authorizeResource(actor, resourceId, enrolmentId);
  const stream = await getS3ObjectStream(resource.file.key, getStorageConfig().bucketDocuments);
  if (!stream) throw notFound();
  if (learnerEnrolmentId && learnerId) {
    try {
      await recordResourceActivity({
        resourceId: resource.id,
        enrolmentId: learnerEnrolmentId,
        learnerId,
        type: 'view',
        version: resource.version
      });
      await audit(actor, 'appr.resource.view', resource.id, { version: resource.version });
    } catch (error) {
      console.error('[apprenticeship] resource view tracking failed (non-fatal):', error);
    }
  }
  return {
    body: stream.body,
    contentLength: stream.contentLength,
    contentType: apprResourceMimeForFile(resource.kind as ApprResourceKind, resource.file.name) ?? resource.file.type,
    fileName: resource.file.name
  };
}

export async function downloadResource(actor: Actor, resourceId: string, enrolmentId?: string) {
  const a = requireAuthed(actor);
  const { resource, learnerEnrolmentId, learnerId } = await authorizeResource(actor, resourceId, enrolmentId);
  if (a.role === 'LEARNER' && resource.kind === 'LEARNING') {
    throw new AppError('This resource is view only', ErrorCodes.FORBIDDEN, 403);
  }
  const url = await generateAttachmentPresignedUrl(
    resource.file.key,
    getStorageConfig().bucketDocuments,
    resource.file.name
  );
  if (!url) throw new AppError('Could not prepare the download', ErrorCodes.INTERNAL_ERROR, 500);
  if (learnerEnrolmentId && learnerId) {
    await recordResourceActivity({
      resourceId: resource.id,
      enrolmentId: learnerEnrolmentId,
      learnerId,
      type: 'download',
      version: resource.version
    });
  }
  await audit(actor, 'appr.resource.download', resource.id, {
    version: resource.version,
    enrolmentId: learnerEnrolmentId
  });
  return { url, fileName: resource.file.name };
}
