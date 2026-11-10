import {
  ZOnboardingDocParam,
  ZOnboardingDocReview,
  ZOnboardingDocSave,
  ZOnboardingDownload,
  ZOnboardingEnrolmentParam,
  ZOnboardingPresign,
  ZOnboardingTypeCreate,
  ZOnboardingTypeParam,
  ZOnboardingTypeReorder,
  ZOnboardingTypeUpdate
} from '@cio/utils/validation/apprenticeship';
import {
  createOnboardingType,
  deleteOnboardingTypeAdmin,
  getOnboarding,
  listOnboardingTypesAdmin,
  presignOnboardingUploads,
  reorderOnboardingTypesAdmin,
  reviewOnboardingDocument,
  saveOnboardingDoc,
  signOnboardingDownloads,
  updateOnboardingTypeAdmin,
  withdrawOnboardingDoc
} from '@api/services/apprenticeship/onboarding';

import { Hono } from '@api/utils/hono';
import type { Actor } from '@cio/db/actor';
import { handleError } from '@api/utils/errors';
import { requireAdmin, requireRole } from '@api/middlewares/guards';
import { zValidator } from '@hono/zod-validator';

// Gecko Apprenticeships — onboarding documents (photo ID, NI proof…). Mounted at /apprenticeship. Who may do what is
// decided in the service (admin / the learner themselves / a tutor sees status only); the route only needs a member.
// The document-type settings are ADMIN only. Managers have no access.
const requireApprMember = requireRole('ADMIN', 'TUTOR', 'LEARNER');

export const onboardingRouter = new Hono()
  .get('/onboarding-types', requireAdmin, async (c) => {
    try {
      const data = await listOnboardingTypesAdmin(c.get('actor') as Actor);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load document types');
    }
  })
  .post('/onboarding-types', requireAdmin, zValidator('json', ZOnboardingTypeCreate), async (c) => {
    try {
      const data = await createOnboardingType(c.get('actor') as Actor, c.req.valid('json'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to add document type');
    }
  })
  .put('/onboarding-types/order', requireAdmin, zValidator('json', ZOnboardingTypeReorder), async (c) => {
    try {
      const data = await reorderOnboardingTypesAdmin(c.get('actor') as Actor, c.req.valid('json').typeIds);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to reorder document types');
    }
  })
  .patch(
    '/onboarding-types/:typeId',
    requireAdmin,
    zValidator('param', ZOnboardingTypeParam),
    zValidator('json', ZOnboardingTypeUpdate),
    async (c) => {
      try {
        const data = await updateOnboardingTypeAdmin(
          c.get('actor') as Actor,
          c.req.valid('param').typeId,
          c.req.valid('json')
        );
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to update document type');
      }
    }
  )
  .delete('/onboarding-types/:typeId', requireAdmin, zValidator('param', ZOnboardingTypeParam), async (c) => {
    try {
      const data = await deleteOnboardingTypeAdmin(c.get('actor') as Actor, c.req.valid('param').typeId);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to delete document type');
    }
  })
  .get('/enrolments/:id/onboarding', requireApprMember, zValidator('param', ZOnboardingEnrolmentParam), async (c) => {
    try {
      const data = await getOnboarding(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load onboarding documents');
    }
  })
  .post(
    '/enrolments/:id/onboarding/presign',
    requireApprMember,
    zValidator('param', ZOnboardingEnrolmentParam),
    zValidator('json', ZOnboardingPresign),
    async (c) => {
      try {
        const data = await presignOnboardingUploads(
          c.get('actor') as Actor,
          c.req.valid('param').id,
          c.req.valid('json')
        );
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to prepare upload');
      }
    }
  )
  .put(
    '/enrolments/:id/onboarding/:docTypeId',
    requireApprMember,
    zValidator('param', ZOnboardingDocParam),
    zValidator('json', ZOnboardingDocSave),
    async (c) => {
      try {
        const { id, docTypeId } = c.req.valid('param');
        const data = await saveOnboardingDoc(c.get('actor') as Actor, id, docTypeId, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to save document');
      }
    }
  )
  .delete(
    '/enrolments/:id/onboarding/:docTypeId',
    requireApprMember,
    zValidator('param', ZOnboardingDocParam),
    async (c) => {
      try {
        const { id, docTypeId } = c.req.valid('param');
        const data = await withdrawOnboardingDoc(c.get('actor') as Actor, id, docTypeId);
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to withdraw document');
      }
    }
  )
  .post(
    '/enrolments/:id/onboarding/:docTypeId/review',
    requireApprMember,
    zValidator('param', ZOnboardingDocParam),
    zValidator('json', ZOnboardingDocReview),
    async (c) => {
      try {
        const { id, docTypeId } = c.req.valid('param');
        const data = await reviewOnboardingDocument(c.get('actor') as Actor, id, docTypeId, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to review document');
      }
    }
  )
  .post(
    '/enrolments/:id/onboarding/:docTypeId/download',
    requireApprMember,
    zValidator('param', ZOnboardingDocParam),
    zValidator('json', ZOnboardingDownload),
    async (c) => {
      try {
        const { id, docTypeId } = c.req.valid('param');
        const data = await signOnboardingDownloads(c.get('actor') as Actor, id, docTypeId, c.req.valid('json').keys);
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to prepare download');
      }
    }
  );
