import { ZEnrolmentIdParam, ZSummaryQuery } from '@cio/utils/validation/apprenticeship';
import { getPortfolioReport } from '@api/services/apprenticeship/report';
import { getSummary } from '@api/services/apprenticeship/summary';

import { Hono } from '@api/utils/hono';
import type { Actor } from '@cio/db/actor';
import { handleError } from '@api/utils/errors';
import { requireRole, requireStaff } from '@api/middlewares/guards';
import { zValidator } from '@hono/zod-validator';

// Gecko Apprenticeships — the Summary dashboard (ADMIN: org, TUTOR: their reach) and the PDF portfolio report data
// (the portfolio's own readers: admin, tutor in reach, the apprentice). Mounted at /apprenticeship.
export const summaryRouter = new Hono()
  .get('/summary', requireStaff, zValidator('query', ZSummaryQuery), async (c) => {
    try {
      const data = await getSummary(c.get('actor') as Actor, c.req.valid('query'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load summary');
    }
  })
  .get(
    '/enrolments/:id/portfolio-report',
    requireRole('ADMIN', 'TUTOR', 'LEARNER'),
    zValidator('param', ZEnrolmentIdParam),
    async (c) => {
      try {
        const data = await getPortfolioReport(c.get('actor') as Actor, c.req.valid('param').id);
        c.header('Cache-Control', 'no-store');
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to build portfolio report');
      }
    }
  );
