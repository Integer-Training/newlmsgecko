import { AppError, ErrorCodes } from '@api/utils/errors';
import { filterCriterionIdsInProgramme, listApprEvidenceTypes } from '@cio/db/queries/apprenticeship';
import { getUploadLimits } from '@cio/core/config/upload-limits';
import { ALLOWED_CONTENT_TYPES, ALLOWED_DOCUMENT_TYPES, ALLOWED_IMAGE_TYPES } from '@cio/utils/validation/constants';

// Gecko Apprenticeships — checks shared by the evidence and task services (file type + size, active evidence type,
// criteria belonging to the programme). Kept apart so evidence.ts and tasks.ts never import each other.

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

/** Every criterion must belong to the programme (chain join); a foreign id is a client error, never silently dropped. */
export async function assertCriteriaInProgramme(programmeId: string, criterionIds: string[]): Promise<string[]> {
  const unique = [...new Set(criterionIds)];
  const found = await filterCriterionIdsInProgramme(programmeId, unique);
  if (found.length !== unique.length)
    throw badRequest('One or more criteria are not part of this programme', 'criterionIds');
  return unique;
}
