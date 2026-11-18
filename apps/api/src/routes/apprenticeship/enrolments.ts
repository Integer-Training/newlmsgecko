import * as z from 'zod';
import {
  ZApprenticeshipCreate,
  ZEnrolmentCreate,
  ZEnrolmentIdParam,
  ZEnrolmentLink,
  ZEnrolmentListQuery,
  ZEnrolmentReinstate,
  ZEnrolmentUpdate,
  ZEnrolmentWithdraw,
  ZExportQuery,
  ZUnitDatesSpread,
  ZUnitDatesUpdate
} from '@cio/utils/validation/apprenticeship';
import {
  checkLearner,
  createApprenticeship,
  createEnrolment,
  exportPortfolioCsv,
  getPortfolio,
  linkEnrolment,
  listEnrolments,
  getEnrolmentPickerOptions,
  reinstateEnrolment,
  setUnitDates,
  spreadEnrolmentUnitDates,
  unlinkEnrolment,
  updateEnrolment,
  withdrawEnrolment
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

// GET /learner-check: exactly one of learnerId / email.
const ZLearnerCheckQuery = z
  .object({ learnerId: z.uuid().optional(), email: z.email().max(254).optional() })
  .refine((v) => Boolean(v.learnerId) !== Boolean(v.email), { message: 'Pass either learnerId or email' });

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
  .get('/learner-check', requireAdmin, zValidator('query', ZLearnerCheckQuery), async (c) => {
    try {
      const data = await checkLearner(c.get('actor') as Actor, c.req.valid('query'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to check the learner');
    }
  })
  .post('/apprenticeship', requireAdmin, zValidator('json', ZApprenticeshipCreate), async (c) => {
    try {
      const data = await createApprenticeship(c.get('actor') as Actor, c.req.valid('json'));
      return c.json({ success: true, data }, 201);
    } catch (error) {
      return handleError(c, error, 'Failed to enrol apprentice');
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
  .post(
    '/:id/link',
    requireAdmin,
    zValidator('param', ZEnrolmentIdParam),
    zValidator('json', ZEnrolmentLink),
    async (c) => {
      try {
        const data = await linkEnrolment(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to link enrolments');
      }
    }
  )
  .delete('/:id/link', requireAdmin, zValidator('param', ZEnrolmentIdParam), async (c) => {
    try {
      const data = await unlinkEnrolment(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to unlink enrolments');
    }
  })
  .post(
    '/:id/withdraw',
    requireAdmin,
    zValidator('param', ZEnrolmentIdParam),
    zValidator('json', ZEnrolmentWithdraw),
    async (c) => {
      try {
        const data = await withdrawEnrolment(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to withdraw enrolment');
      }
    }
  )
  // The body is optional ({ scope?: 'THIS' | 'BOTH' }, default THIS).
  .post('/:id/reinstate', requireAdmin, zValidator('param', ZEnrolmentIdParam), async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const parsed = ZEnrolmentReinstate.safeParse(body ?? {});
      if (!parsed.success) return c.json({ success: false, error: 'Invalid request body' }, 400);
      const data = await reinstateEnrolment(c.get('actor') as Actor, c.req.valid('param').id, parsed.data);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to reinstate enrolment');
    }
  })
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
