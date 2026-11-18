import { ZEnrolmentIdParam } from '@cio/utils/validation/apprenticeship';
import { getOverview } from '@api/services/apprenticeship/overview';

import { Hono } from '@api/utils/hono';
import type { Actor } from '@cio/db/actor';
import { handleError } from '@api/utils/errors';
import { requireRole } from '@api/middlewares/guards';
import { zValidator } from '@hono/zod-validator';

// Gecko Apprenticeships — the learner overview of an apprenticeship (pair). Same readers as the portfolio: admin, a tutor
// in reach, the learner themself (others 404 from the service; managers 403). Mounted at /apprenticeship.
export const overviewRouter = new Hono().get(
  '/enrolments/:id/overview',
  requireRole('ADMIN', 'TUTOR', 'LEARNER'),
  zValidator('param', ZEnrolmentIdParam),
  async (c) => {
    try {
      const data = await getOverview(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load overview');
    }
  }
);
