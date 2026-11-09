import {
  ZCriterionCreate,
  ZCriterionParam,
  ZCriterionUpdate,
  ZImportBody,
  ZProgrammeCreate,
  ZProgrammeIdParam,
  ZProgrammeListQuery,
  ZProgrammeUpdate,
  ZQualificationCreate,
  ZQualificationParam,
  ZQualificationUpdate,
  ZReorder,
  ZUnitCreate,
  ZUnitParam,
  ZUnitUpdate
} from '@cio/utils/validation/apprenticeship';
import {
  createCriterion,
  createProgramme,
  createQualification,
  createUnit,
  deleteCriterion,
  deleteQualification,
  deleteUnit,
  getProgrammeTree,
  importStructureCsv,
  listProgrammes,
  reorderChildren,
  updateCriterion,
  updateProgramme,
  updateQualification,
  updateUnit
} from '@api/services/apprenticeship/programme';

import { Hono } from '@api/utils/hono';
import type { Actor } from '@cio/db/actor';
import { handleError } from '@api/utils/errors';
import { requireAdmin, requireStaff } from '@api/middlewares/guards';
import { zValidator } from '@hono/zod-validator';

// Gecko Apprenticeships Phase A1 — programme catalogue + structure + CSV import. ADMIN only on every route
// (requireAdmin, actor-based). The org comes from the RESOLVED actor inside the service, never a header, and every
// nested id is verified through the programme chain (404 otherwise). Mounted at /apprenticeship/programmes.
export const programmesRouter = new Hono()
  .get('/', requireStaff, zValidator('query', ZProgrammeListQuery), async (c) => {
    try {
      const data = await listProgrammes(c.get('actor') as Actor, c.req.valid('query').status);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to list programmes');
    }
  })
  .post('/', requireAdmin, zValidator('json', ZProgrammeCreate), async (c) => {
    try {
      const data = await createProgramme(c.get('actor') as Actor, c.req.valid('json'));
      return c.json({ success: true, data }, 201);
    } catch (error) {
      return handleError(c, error, 'Failed to create programme');
    }
  })
  // Read-only structure: tutors need it for the criteria picker when marking from To mark (org-scoped in the service).
  .get('/:id', requireStaff, zValidator('param', ZProgrammeIdParam), async (c) => {
    try {
      const data = await getProgrammeTree(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load programme');
    }
  })
  .patch(
    '/:id',
    requireAdmin,
    zValidator('param', ZProgrammeIdParam),
    zValidator('json', ZProgrammeUpdate),
    async (c) => {
      try {
        const data = await updateProgramme(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to update programme');
      }
    }
  )
  .put(
    '/:id/reorder',
    requireAdmin,
    zValidator('param', ZProgrammeIdParam),
    zValidator('json', ZReorder),
    async (c) => {
      try {
        const data = await reorderChildren(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to reorder');
      }
    }
  )
  .post(
    '/:id/import',
    requireAdmin,
    zValidator('param', ZProgrammeIdParam),
    zValidator('json', ZImportBody),
    async (c) => {
      try {
        const data = await importStructureCsv(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to import structure');
      }
    }
  )
  // ── Qualifications ──
  .post(
    '/:id/qualifications',
    requireAdmin,
    zValidator('param', ZProgrammeIdParam),
    zValidator('json', ZQualificationCreate),
    async (c) => {
      try {
        const data = await createQualification(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 201);
      } catch (error) {
        return handleError(c, error, 'Failed to create qualification');
      }
    }
  )
  .patch(
    '/:id/qualifications/:qid',
    requireAdmin,
    zValidator('param', ZQualificationParam),
    zValidator('json', ZQualificationUpdate),
    async (c) => {
      try {
        const { id, qid } = c.req.valid('param');
        const data = await updateQualification(c.get('actor') as Actor, id, qid, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to update qualification');
      }
    }
  )
  .delete('/:id/qualifications/:qid', requireAdmin, zValidator('param', ZQualificationParam), async (c) => {
    try {
      const { id, qid } = c.req.valid('param');
      const data = await deleteQualification(c.get('actor') as Actor, id, qid);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to delete qualification');
    }
  })
  // ── Units ──
  .post(
    '/:id/qualifications/:qid/units',
    requireAdmin,
    zValidator('param', ZQualificationParam),
    zValidator('json', ZUnitCreate),
    async (c) => {
      try {
        const { id, qid } = c.req.valid('param');
        const data = await createUnit(c.get('actor') as Actor, id, qid, c.req.valid('json'));
        return c.json({ success: true, data }, 201);
      } catch (error) {
        return handleError(c, error, 'Failed to create unit');
      }
    }
  )
  .patch(
    '/:id/qualifications/:qid/units/:uid',
    requireAdmin,
    zValidator('param', ZUnitParam),
    zValidator('json', ZUnitUpdate),
    async (c) => {
      try {
        const { id, qid, uid } = c.req.valid('param');
        const data = await updateUnit(c.get('actor') as Actor, id, qid, uid, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to update unit');
      }
    }
  )
  .delete('/:id/qualifications/:qid/units/:uid', requireAdmin, zValidator('param', ZUnitParam), async (c) => {
    try {
      const { id, qid, uid } = c.req.valid('param');
      const data = await deleteUnit(c.get('actor') as Actor, id, qid, uid);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to delete unit');
    }
  })
  // ── Criteria ──
  .post(
    '/:id/qualifications/:qid/units/:uid/criteria',
    requireAdmin,
    zValidator('param', ZUnitParam),
    zValidator('json', ZCriterionCreate),
    async (c) => {
      try {
        const { id, qid, uid } = c.req.valid('param');
        const data = await createCriterion(c.get('actor') as Actor, id, qid, uid, c.req.valid('json'));
        return c.json({ success: true, data }, 201);
      } catch (error) {
        return handleError(c, error, 'Failed to create criterion');
      }
    }
  )
  .patch(
    '/:id/qualifications/:qid/units/:uid/criteria/:cid',
    requireAdmin,
    zValidator('param', ZCriterionParam),
    zValidator('json', ZCriterionUpdate),
    async (c) => {
      try {
        const { id, qid, uid, cid } = c.req.valid('param');
        const data = await updateCriterion(c.get('actor') as Actor, id, qid, uid, cid, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to update criterion');
      }
    }
  )
  .delete(
    '/:id/qualifications/:qid/units/:uid/criteria/:cid',
    requireAdmin,
    zValidator('param', ZCriterionParam),
    async (c) => {
      try {
        const { id, qid, uid, cid } = c.req.valid('param');
        const data = await deleteCriterion(c.get('actor') as Actor, id, qid, uid, cid);
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to delete criterion');
      }
    }
  );
