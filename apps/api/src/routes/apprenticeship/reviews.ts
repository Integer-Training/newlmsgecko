import {
  ZEnrolmentIdParam,
  ZReviewCreate,
  ZReviewIdParam,
  ZReviewSign,
  ZReviewUpdate
} from '@cio/utils/validation/apprenticeship';
import {
  cancelReview,
  createReview,
  listReviews,
  signReview,
  updateReview
} from '@api/services/apprenticeship/reviews';

import { Hono } from '@api/utils/hono';
import type { Actor } from '@cio/db/actor';
import { handleError } from '@api/utils/errors';
import { requireRole, requireStaff } from '@api/middlewares/guards';
import { zValidator } from '@hono/zod-validator';

// Gecko Apprenticeships — progress reviews. ADMIN, the allocated TUTOR and the apprentice themselves can read; staff
// schedule / edit / cancel; the apprentice may add only their own comment and sign only as themselves (the service
// enforces both; anything outside their own enrolment 404s). Mounted at /apprenticeship/reviews.
const requireApprMember = requireRole('ADMIN', 'TUTOR', 'LEARNER');

export const reviewsRouter = new Hono()
  .get('/enrolments/:id/reviews', requireApprMember, zValidator('param', ZEnrolmentIdParam), async (c) => {
    try {
      const data = await listReviews(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to list reviews');
    }
  })
  .post(
    '/enrolments/:id/reviews',
    requireStaff,
    zValidator('param', ZEnrolmentIdParam),
    zValidator('json', ZReviewCreate),
    async (c) => {
      try {
        const data = await createReview(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 201);
      } catch (error) {
        return handleError(c, error, 'Failed to schedule review');
      }
    }
  )
  .patch(
    '/:id',
    requireApprMember,
    zValidator('param', ZReviewIdParam),
    zValidator('json', ZReviewUpdate),
    async (c) => {
      try {
        const data = await updateReview(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to update review');
      }
    }
  )
  .post(
    '/:id/sign',
    requireApprMember,
    zValidator('param', ZReviewIdParam),
    zValidator('json', ZReviewSign),
    async (c) => {
      try {
        const data = await signReview(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to sign review');
      }
    }
  )
  .post('/:id/cancel', requireStaff, zValidator('param', ZReviewIdParam), async (c) => {
    try {
      const data = await cancelReview(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to cancel review');
    }
  });
