import { AppError, ErrorCodes } from '@api/utils/errors';
import { requireAuthed } from '@api/services/apprenticeship/access';
import type { Actor } from '@cio/db/actor';
import { recordAudit } from '@cio/db/audit';
import {
  getApprSettings,
  insertApprEvidenceType,
  listApprEvidenceTypes,
  updateApprEvidenceType,
  upsertApprSettings
} from '@cio/db/queries/apprenticeship';
import { generateSlug } from '@cio/utils/functions/slug';
import type { ApprSettingsUpdateInput } from '@cio/utils/validation/apprenticeship';

// Gecko Apprenticeships — org rules (RAG thresholds, OTJ) and the evidence-type list. Admin only at the route; org
// from the resolved actor. Status is computed on read, so saving settings needs no recompute.

export async function getSettingsBundle(actor: Actor) {
  const a = requireAuthed(actor);
  const [settings, evidenceTypes] = await Promise.all([getApprSettings(a.orgId), listApprEvidenceTypes(a.orgId)]);
  return { settings, evidenceTypes };
}

export async function saveSettings(actor: Actor, input: ApprSettingsUpdateInput) {
  const a = requireAuthed(actor);
  await upsertApprSettings(a.orgId, input);
  await recordAudit({ actor, action: 'appr.settings.updated', entityType: 'appr_settings', entityId: a.orgId });
  return getApprSettings(a.orgId);
}

export async function createEvidenceType(actor: Actor, label: string) {
  const a = requireAuthed(actor);
  const key = generateSlug(label, { fallback: '' });
  if (!key) throw new AppError('Label must contain letters or numbers', ErrorCodes.VALIDATION_ERROR, 400, 'label');
  // Read first so the defaults are seeded before the first custom type lands (the seed only runs on an empty list).
  const existing = await listApprEvidenceTypes(a.orgId);
  if (existing.some((t) => t.key === key)) {
    throw new AppError('An evidence type with this name already exists', ErrorCodes.CONFLICT, 409, 'label');
  }
  const row = await insertApprEvidenceType(a.orgId, key, label);
  await recordAudit({
    actor,
    action: 'appr.evidence_type.created',
    entityType: 'appr_evidence_type',
    entityId: row.id
  });
  return row;
}

export async function patchEvidenceType(
  actor: Actor,
  id: string,
  patch: Partial<{ label: string; active: boolean; sort: number }>
) {
  const a = requireAuthed(actor);
  const row = await updateApprEvidenceType(a.orgId, id, patch);
  if (!row) throw new AppError('Evidence type not found', ErrorCodes.NOT_FOUND, 404);
  await recordAudit({
    actor,
    action: 'appr.evidence_type.updated',
    entityType: 'appr_evidence_type',
    entityId: id,
    metadata: { fields: Object.keys(patch) }
  });
  return row;
}
