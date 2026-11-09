import {
  ZEnrolmentCreate,
  ZEnrolmentIdParam,
  ZEnrolmentListQuery,
  ZEnrolmentUpdate,
  ZExportQuery,
  ZUnitDatesSpread,
  ZUnitDatesUpdate
} from '@cio/utils/validation/apprenticeship';
import {
  createEnrolment,
  exportPortfolioCsv,
  getPortfolio,
  listEnrolments,
  getEnrolmentPickerOptions,
  setUnitDates,
  spreadEnrolmentUnitDates,
  updateEnrolment
} from '@api/services/apprenticeship/enrolment';

import { Hono } from '@api/utils/hono';
import type { Actor } from '@cio/db/actor';
import { handleError } from '@api/utils/errors';
import { requireAdmin, requireRole, requireStaff } from '@api/middlewares/guards';
import { zValidator } from '@hono/zod-validator';

// Gecko Apprenticeships — learners table, enrolment, portfolio, dates and CSV export. Phase B: ADMIN + TUTOR
// (requireStaff) on the learners table, portfolio, unit dates and export — the services scope a tutor to allocated
// learners (404 otherwise). Enrolling a learner and the programme dates / hours stay admin-only. Mounted at
// /apprenticeship/enrolments.
// Phase C: the apprentice themselves may use the routes guarded by this; the services scope them to their own
// enrolment and evidence (anything else 404s). Managers have no apprenticeship access.
const requireApprMember = requireRole('ADMIN', 'TUTOR', 'LEARNER');

export const enrolmentsRouter = new Hono()
  .get('/', requireApprMember, zValidator('query', ZEnrolmentListQuery), async (c) => {
    try {
      const data = await listEnrolments(c.get('actor') as Actor, c.req.valid('query'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to list learners');
    }
  })
  .get('/options', requireAdmin, async (c) => {
    try {
      const data = await getEnrolmentPickerOptions(c.get('actor') as Actor);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load tutors and learners');
    }
  })
  .post('/', requireAdmin, zValidator('json', ZEnrolmentCreate), async (c) => {
    try {
      const data = await createEnrolment(c.get('actor') as Actor, c.req.valid('json'));
      return c.json({ success: true, data }, 201);
    } catch (error) {
      return handleError(c, error, 'Failed to enrol learner');
    }
  })
  .patch(
    '/:id',
    requireAdmin,
    zValidator('param', ZEnrolmentIdParam),
    zValidator('json', ZEnrolmentUpdate),
    async (c) => {
      try {
        const data = await updateEnrolment(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to update enrolment');
      }
    }
  )
  .put(
    '/:id/unit-dates',
    requireStaff,
    zValidator('param', ZEnrolmentIdParam),
    zValidator('json', ZUnitDatesUpdate),
    async (c) => {
      try {
        const data = await setUnitDates(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to save unit dates');
      }
    }
  )
  .post(
    '/:id/unit-dates/spread',
    requireStaff,
    zValidator('param', ZEnrolmentIdParam),
    zValidator('json', ZUnitDatesSpread),
    async (c) => {
      try {
        const data = await spreadEnrolmentUnitDates(
          c.get('actor') as Actor,
          c.req.valid('param').id,
          c.req.valid('json')
        );
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to spread unit dates');
      }
    }
  )
  .get('/:id/portfolio', requireApprMember, zValidator('param', ZEnrolmentIdParam), async (c) => {
    try {
      const data = await getPortfolio(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load portfolio');
    }
  })
  .get(
    '/:id/export.csv',
    requireApprMember,
    zValidator('param', ZEnrolmentIdParam),
    zValidator('query', ZExportQuery),
    async (c) => {
      try {
        const { csv, filename } = await exportPortfolioCsv(
          c.get('actor') as Actor,
          c.req.valid('param').id,
          c.req.valid('query').unitId
        );
        return c.body(csv, 200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store'
        });
      } catch (error) {
        return handleError(c, error, 'Failed to export portfolio');
      }
    }
  );
