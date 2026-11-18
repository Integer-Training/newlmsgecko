import { AppError, ErrorCodes } from '@api/utils/errors';
import { countedHalves } from '@api/services/apprenticeship/withdrawn';
import {
  filterCriterionIdsInProgramme,
  getLinkedEnrolment,
  listApprEvidenceTypes
} from '@cio/db/queries/apprenticeship';
import type { DbOrTxClient } from '@cio/db/drizzle';
import { getUploadLimits } from '@cio/core/config/upload-limits';
import { ALLOWED_CONTENT_TYPES, ALLOWED_DOCUMENT_TYPES, ALLOWED_IMAGE_TYPES } from '@cio/utils/validation/constants';

// Gecko Apprenticeships — checks shared by the evidence and task services (file type + size, active evidence type,
// criteria belonging to the programme / its linked pair). Kept apart so evidence.ts and tasks.ts never import each other.

const badRequest = (message: string, field?: string) => new AppError(message, ErrorCodes.VALIDATION_ERROR, 400, field);

const ALLOWED_TYPES = new Set<string>([...ALLOWED_DOCUMENT_TYPES, ...ALLOWED_IMAGE_TYPES, ...ALLOWED_CONTENT_TYPES]);
const IMAGE_TYPES = new Set<string>(ALLOWED_IMAGE_TYPES);
const VIDEO_TYPES = new Set<string>(ALLOWED_CONTENT_TYPES);

export function assertAllowedFile(f: { name: string; type?: string; size?: number }): void {
  if (f.type !== undefined && !ALLOWED_TYPES.has(f.type)) {
    throw badRequest(`"${f.name}" is not an accepted file type (documents, images or video).`, 'files');
  }
  if (f.size === undefined) return;
  const limits = getUploadLimits();
  const max = IMAGE_TYPES.has(f.type ?? '')
    ? limits.imageBytes
    : VIDEO_TYPES.has(f.type ?? '')
      ? limits.videoBytes
      : limits.documentBytes;
  if (f.size > max) {
    throw new AppError(
      `"${f.name}" is too large. The maximum size is ${Math.round(max / 1024 / 1024)}MB.`,
      'FILE_TOO_LARGE',
      413
    );
  }
}

export async function assertActiveType(organizationId: string, typeKey: string): Promise<void> {
  const types = await listApprEvidenceTypes(organizationId);
  if (!types.some((t) => t.key === typeKey && t.active)) throw badRequest('Choose a valid evidence type', 'typeKey');
}

/**
 * Every criterion must belong to one of the programmes (chain join); a foreign id is a client error, never silently
 * dropped. Pass [programmeId] for an unlinked enrolment (identical to the old single-programme rule) or
 * [programmeId, linkedProgrammeId] for one half of a Diploma + Standard pair: evidence and tasks may then map to the
 * criteria of either qualification.
 */
export async function assertCriteriaInProgrammes(
  programmeIds: (string | null | undefined)[],
  criterionIds: string[]
): Promise<string[]> {
  const unique = [...new Set(criterionIds)];
  let remaining = unique;
  for (const programmeId of new Set(programmeIds.filter((p): p is string => !!p))) {
    if (remaining.length === 0) break;
    const found = new Set(await filterCriterionIdsInProgramme(programmeId, remaining));
    remaining = remaining.filter((id) => !found.has(id));
  }
  if (remaining.length > 0) throw badRequest('One or more criteria are not part of this programme', 'criterionIds');
  return unique;
}

/** Single-programme form (task plans are per programme). Same as assertCriteriaInProgrammes([programmeId], ids). */
export function assertCriteriaInProgramme(programmeId: string, criterionIds: string[]): Promise<string[]> {
  return assertCriteriaInProgrammes([programmeId], criterionIds);
}

/**
 * A NEW evidence / task may not map to the criteria of a WITHDRAWN qualification (they are hidden from the picker; existing
 * mappings are kept). `pairProgrammeIds` is getPairProgrammes().programmeIds. A 400 when any chosen criterion belongs to
 * a withdrawn half. Unlinked / not withdrawn: a no-op.
 */
export async function assertCriteriaMappable(
  enrolment: { id: string; programmeId: string; withdrawnAt?: string | null },
  pairProgrammeIds: string[],
  criterionIds: string[]
): Promise<void> {
  if (pairProgrammeIds.length < 2 && !enrolment.withdrawnAt) return;
  const linked = pairProgrammeIds.length > 1 ? await getLinkedEnrolment(enrolment.id) : null;
  const halves = countedHalves(!!enrolment.withdrawnAt, linked ? !!linked.withdrawnAt : null);
  const blocked: string[] = [];
  if (!halves.own) blocked.push(enrolment.programmeId);
  if (linked && !halves.linked) blocked.push(linked.programmeId);
  for (const programmeId of blocked) {
    const found = await filterCriterionIdsInProgramme(programmeId, criterionIds);
    if (found.length > 0) {
      throw badRequest('One or more criteria belong to a withdrawn qualification', 'criterionIds');
    }
  }
}

/**
 * The programme ids an enrolment's evidence / tasks may map to: its own, plus the linked counterpart's when it is one
 * half of a pair. `linked` is returned too so callers can reuse it without a second read.
 */
export async function getPairProgrammes(
  enrolment: { id: string; programmeId: string },
  client?: DbOrTxClient
): Promise<{ programmeIds: string[]; linked: Awaited<ReturnType<typeof getLinkedEnrolment>> }> {
  const linked = await getLinkedEnrolment(enrolment.id, client);
  return { programmeIds: linked ? [enrolment.programmeId, linked.programmeId] : [enrolment.programmeId], linked };
}
