import {
  ZEnrolmentIdParam,
  ZEnrolmentTutorAdd,
  ZEnrolmentTutorParam,
  ZTutorIdParam,
  ZTutorProgrammesPut
} from '@cio/utils/validation/apprenticeship';
import {
  addNamedTutor,
  getEnrolmentTutors,
  getTutorProgrammes,
  removeNamedTutor,
  setTutorProgrammes
} from '@api/services/apprenticeship/tutors';

import { Hono } from '@api/utils/hono';
import type { Actor } from '@cio/db/actor';
import { handleError } from '@api/utils/errors';
import { requireAdmin, requireRole } from '@api/middlewares/guards';
import { zValidator } from '@hono/zod-validator';

// Gecko Apprenticeships — programme tutors (per tutor, from Tutor Management) and an apprentice's named tutors (per
// enrolment, from the portfolio). Mounted at /apprenticeship. Reading an enrolment's tutors follows the portfolio
// access rule; every write is ADMIN only. Managers have no access.
const requireApprMember = requireRole('ADMIN', 'TUTOR', 'LEARNER');

export const tutorsRouter = new Hono()
  .get('/tutors/:tutorId/programmes', requireAdmin, zValidator('param', ZTutorIdParam), async (c) => {
    try {
      const data = await getTutorProgrammes(c.get('actor') as Actor, c.req.valid('param').tutorId);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load tutor programmes');
    }
  })
  .put(
    '/tutors/:tutorId/programmes',
    requireAdmin,
    zValidator('param', ZTutorIdParam),
    zValidator('json', ZTutorProgrammesPut),
    async (c) => {
      try {
        const data = await setTutorProgrammes(
          c.get('actor') as Actor,
          c.req.valid('param').tutorId,
          c.req.valid('json').programmeIds
        );
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to save tutor programmes');
      }
    }
  )
  .get('/enrolments/:id/tutors', requireApprMember, zValidator('param', ZEnrolmentIdParam), async (c) => {
    try {
      const data = await getEnrolmentTutors(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load tutors');
    }
  })
  .post(
    '/enrolments/:id/tutors',
    requireAdmin,
    zValidator('param', ZEnrolmentIdParam),
    zValidator('json', ZEnrolmentTutorAdd),
    async (c) => {
      try {
        const data = await addNamedTutor(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json').tutorId);
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to add tutor');
      }
    }
  )
  .delete('/enrolments/:id/tutors/:tutorId', requireAdmin, zValidator('param', ZEnrolmentTutorParam), async (c) => {
    try {
      const { id, tutorId } = c.req.valid('param');
      const data = await removeNamedTutor(c.get('actor') as Actor, id, tutorId);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to remove tutor');
    }
  });
