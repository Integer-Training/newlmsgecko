import {
  ZCriterionEvidenceQuery,
  ZCriterionIdParam,
  ZEnrolmentIdParam,
  ZEvidenceCreate,
  ZEvidenceDownload,
  ZEvidenceIdParam,
  ZEvidenceListQuery,
  ZEvidenceNoteCreate,
  ZEvidencePresign,
  ZEvidenceReview,
  ZEvidenceUpdate,
  ZToMarkQuery
} from '@cio/utils/validation/apprenticeship';
import {
  addEvidenceNote,
  createEvidence,
  getEvidenceDetail,
  listCriterionEvidence,
  listEvidence,
  listToMarkQueue,
  presignEvidenceUploads,
  reviewEvidence,
  signEvidenceDownloads,
  updateEvidence
} from '@api/services/apprenticeship/evidence';

import { Hono } from '@api/utils/hono';
import type { Actor } from '@cio/db/actor';
import { handleError } from '@api/utils/errors';
import { requireAdmin } from '@api/middlewares/guards';
import { zValidator } from '@hono/zod-validator';

// Gecko Apprenticeships — evidence, review and the marking queue. ADMIN only for now (requireAdmin); the services
// scope every call through access.ts and hold the state machine + the learner edit rules, so the tutor and learner
// phases only open routes. Static paths are registered before '/:id'. Mounted at /apprenticeship/evidence.
export const evidenceRouter = new Hono()
  .get(
    '/enrolments/:id/evidence',
    requireAdmin,
    zValidator('param', ZEnrolmentIdParam),
    zValidator('query', ZEvidenceListQuery),
    async (c) => {
      try {
        const data = await listEvidence(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('query'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to list evidence');
      }
    }
  )
  .post(
    '/enrolments/:id/evidence',
    requireAdmin,
    zValidator('param', ZEnrolmentIdParam),
    zValidator('json', ZEvidenceCreate),
    async (c) => {
      try {
        const data = await createEvidence(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 201);
      } catch (error) {
        return handleError(c, error, 'Failed to add evidence');
      }
    }
  )
  .post('/presign', requireAdmin, zValidator('json', ZEvidencePresign), async (c) => {
    try {
      const data = await presignEvidenceUploads(c.get('actor') as Actor, c.req.valid('json'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to prepare uploads');
    }
  })
  .post('/download', requireAdmin, zValidator('json', ZEvidenceDownload), async (c) => {
    try {
      const { evidenceId, keys } = c.req.valid('json');
      const data = await signEvidenceDownloads(c.get('actor') as Actor, evidenceId, keys);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to prepare downloads');
    }
  })
  .get('/to-mark', requireAdmin, zValidator('query', ZToMarkQuery), async (c) => {
    try {
      const data = await listToMarkQueue(c.get('actor') as Actor, c.req.valid('query'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load the marking queue');
    }
  })
  .get(
    '/criteria/:criterionId/evidence',
    requireAdmin,
    zValidator('param', ZCriterionIdParam),
    zValidator('query', ZCriterionEvidenceQuery),
    async (c) => {
      try {
        const data = await listCriterionEvidence(
          c.get('actor') as Actor,
          c.req.valid('param').criterionId,
          c.req.valid('query').enrolmentId
        );
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to list evidence for criterion');
      }
    }
  )
  .get('/:id', requireAdmin, zValidator('param', ZEvidenceIdParam), async (c) => {
    try {
      const data = await getEvidenceDetail(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load evidence');
    }
  })
  .patch(
    '/:id',
    requireAdmin,
    zValidator('param', ZEvidenceIdParam),
    zValidator('json', ZEvidenceUpdate),
    async (c) => {
      try {
        const data = await updateEvidence(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to update evidence');
      }
    }
  )
  .post(
    '/:id/review',
    requireAdmin,
    zValidator('param', ZEvidenceIdParam),
    zValidator('json', ZEvidenceReview),
    async (c) => {
      try {
        const data = await reviewEvidence(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to review evidence');
      }
    }
  )
  .post(
    '/:id/notes',
    requireAdmin,
    zValidator('param', ZEvidenceIdParam),
    zValidator('json', ZEvidenceNoteCreate),
    async (c) => {
      try {
        const data = await addEvidenceNote(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 201);
      } catch (error) {
        return handleError(c, error, 'Failed to add note');
      }
    }
  );
