import {
  ZEnrolmentIdParam,
  ZOtjListQuery,
  ZOtjLogCreate,
  ZOtjLogReview,
  ZOtjLogUpdate
} from '@cio/utils/validation/apprenticeship';
import {
  createOtjLog,
  deleteOtjLogEntry,
  getOtj,
  listOtjQueue,
  reviewOtjLog,
  updateOtjLogEntry
} from '@api/services/apprenticeship/otj';

import { Hono } from '@api/utils/hono';
import type { Actor } from '@cio/db/actor';
import { handleError } from '@api/utils/errors';
import { requireRole, requireStaff } from '@api/middlewares/guards';
import { zValidator } from '@hono/zod-validator';
import * as z from 'zod';

// Gecko Apprenticeships Deploy 3 — off-the-job training log. ADMIN + TUTOR + LEARNER pass the route guard (review is
// staff-only); the service scopes every call through access.ts (tutor reach incl. the linked pair, learner = own) and
// owns the status rules. Mounted at /apprenticeship, so the paths below are full: /enrolments/:id/otj, /otj-logs/:logId.
const requireApprMember = requireRole('ADMIN', 'TUTOR', 'LEARNER');
const ZQueueQuery = z.object({ status: z.enum(['SUBMITTED', 'VALIDATED', 'REJECTED']).default('SUBMITTED') });
const ZLogIdParam = z.object({ logId: z.uuid() });

export const otjRouter = new Hono()
  .get('/otj-logs', requireStaff, zValidator('query', ZQueueQuery), async (c) => {
    try {
      const data = await listOtjQueue(c.get('actor') as Actor, c.req.valid('query'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load the off-the-job queue');
    }
  })
  .get(
    '/enrolments/:id/otj',
    requireApprMember,
    zValidator('param', ZEnrolmentIdParam),
    zValidator('query', ZOtjListQuery),
    async (c) => {
      try {
        const data = await getOtj(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('query'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to load off-the-job training');
      }
    }
  )
  .post(
    '/enrolments/:id/otj-logs',
    requireApprMember,
    zValidator('param', ZEnrolmentIdParam),
    zValidator('json', ZOtjLogCreate),
    async (c) => {
      try {
        const data = await createOtjLog(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 201);
      } catch (error) {
        return handleError(c, error, 'Failed to add the log');
      }
    }
  )
  .patch(
    '/otj-logs/:logId',
    requireApprMember,
    zValidator('param', ZLogIdParam),
    zValidator('json', ZOtjLogUpdate),
    async (c) => {
      try {
        const data = await updateOtjLogEntry(c.get('actor') as Actor, c.req.valid('param').logId, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to update the log');
      }
    }
  )
  .post(
    '/otj-logs/:logId/review',
    requireStaff,
    zValidator('param', ZLogIdParam),
    zValidator('json', ZOtjLogReview),
    async (c) => {
      try {
        const data = await reviewOtjLog(c.get('actor') as Actor, c.req.valid('param').logId, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to review the log');
      }
    }
  )
  .delete('/otj-logs/:logId', requireApprMember, zValidator('param', ZLogIdParam), async (c) => {
    try {
      const data = await deleteOtjLogEntry(c.get('actor') as Actor, c.req.valid('param').logId);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to delete the log');
    }
  });
