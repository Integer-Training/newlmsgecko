import {
  ZApprSettingsUpdate,
  ZEvidenceTypeCreate,
  ZEvidenceTypeParam,
  ZEvidenceTypeUpdate
} from '@cio/utils/validation/apprenticeship';
import {
  createEvidenceType,
  getSettingsBundle,
  patchEvidenceType,
  saveSettings
} from '@api/services/apprenticeship/settings';

import { Hono } from '@api/utils/hono';
import type { Actor } from '@cio/db/actor';
import { handleError } from '@api/utils/errors';
import { requireAdmin, requireRole } from '@api/middlewares/guards';
import { zValidator } from '@hono/zod-validator';

// Gecko Apprenticeships — org rules + evidence types. ADMIN only. Mounted at /apprenticeship/settings.
export const settingsRouter = new Hono()
  // Read by every apprenticeship screen (evidence types for the evidence form) — learners included (Phase C).
  .get('/', requireRole('ADMIN', 'TUTOR', 'LEARNER'), async (c) => {
    try {
      const data = await getSettingsBundle(c.get('actor') as Actor);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load settings');
    }
  })
  .put('/', requireAdmin, zValidator('json', ZApprSettingsUpdate), async (c) => {
    try {
      const data = await saveSettings(c.get('actor') as Actor, c.req.valid('json'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to save settings');
    }
  })
  .post('/evidence-types', requireAdmin, zValidator('json', ZEvidenceTypeCreate), async (c) => {
    try {
      const data = await createEvidenceType(c.get('actor') as Actor, c.req.valid('json').label);
      return c.json({ success: true, data }, 201);
    } catch (error) {
      return handleError(c, error, 'Failed to create evidence type');
    }
  })
  .patch(
    '/evidence-types/:id',
    requireAdmin,
    zValidator('param', ZEvidenceTypeParam),
    zValidator('json', ZEvidenceTypeUpdate),
    async (c) => {
      try {
        const data = await patchEvidenceType(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to update evidence type');
      }
    }
  );
