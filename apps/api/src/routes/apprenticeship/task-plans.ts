import {
  ZTaskPlanAssign,
  ZTaskPlanCreate,
  ZTaskPlanIdParam,
  ZTaskPlanItemCreate,
  ZTaskPlanItemParam,
  ZTaskPlanItemUpdate,
  ZTaskPlanListQuery,
  ZTaskPlanPresign,
  ZTaskPlanReorder,
  ZTaskPlanUpdate
} from '@cio/utils/validation/apprenticeship';
import {
  assignPlan,
  createPlan,
  createPlanItem,
  deletePlan,
  deletePlanItemById,
  getPlanDetail,
  listPlans,
  presignPlanUploads,
  reorderPlanItems,
  setPlanArchived,
  syncPlan,
  unassignPlan,
  updatePlan,
  updatePlanItemById
} from '@api/services/apprenticeship/task-plans';

import { Hono } from '@api/utils/hono';
import type { Actor } from '@cio/db/actor';
import { handleError } from '@api/utils/errors';
import { requireAdmin } from '@api/middlewares/guards';
import { zValidator } from '@hono/zod-validator';

// Gecko Apprenticeships — task plans (templates). ADMIN only on every route (tutors and learners meet plans only as
// the tasks assigned from them). The services re-check the org on every id (another org's plan 404s). Static paths are
// registered before '/:id'. Mounted at /apprenticeship/task-plans.
export const taskPlansRouter = new Hono()
  .get('/', requireAdmin, zValidator('query', ZTaskPlanListQuery), async (c) => {
    try {
      const data = await listPlans(c.get('actor') as Actor, c.req.valid('query'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to list task plans');
    }
  })
  .post('/', requireAdmin, zValidator('json', ZTaskPlanCreate), async (c) => {
    try {
      const data = await createPlan(c.get('actor') as Actor, c.req.valid('json'));
      return c.json({ success: true, data }, 201);
    } catch (error) {
      return handleError(c, error, 'Failed to create task plan');
    }
  })
  .post('/presign', requireAdmin, zValidator('json', ZTaskPlanPresign), async (c) => {
    try {
      const data = await presignPlanUploads(c.get('actor') as Actor, c.req.valid('json'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to prepare uploads');
    }
  })
  .get('/:id', requireAdmin, zValidator('param', ZTaskPlanIdParam), async (c) => {
    try {
      const data = await getPlanDetail(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load task plan');
    }
  })
  .patch(
    '/:id',
    requireAdmin,
    zValidator('param', ZTaskPlanIdParam),
    zValidator('json', ZTaskPlanUpdate),
    async (c) => {
      try {
        const data = await updatePlan(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to update task plan');
      }
    }
  )
  .delete('/:id', requireAdmin, zValidator('param', ZTaskPlanIdParam), async (c) => {
    try {
      const data = await deletePlan(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to delete task plan');
    }
  })
  .post('/:id/archive', requireAdmin, zValidator('param', ZTaskPlanIdParam), async (c) => {
    try {
      const data = await setPlanArchived(c.get('actor') as Actor, c.req.valid('param').id, true);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to archive task plan');
    }
  })
  .post('/:id/unarchive', requireAdmin, zValidator('param', ZTaskPlanIdParam), async (c) => {
    try {
      const data = await setPlanArchived(c.get('actor') as Actor, c.req.valid('param').id, false);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to restore task plan');
    }
  })
  .post(
    '/:id/items',
    requireAdmin,
    zValidator('param', ZTaskPlanIdParam),
    zValidator('json', ZTaskPlanItemCreate),
    async (c) => {
      try {
        const data = await createPlanItem(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 201);
      } catch (error) {
        return handleError(c, error, 'Failed to add task to plan');
      }
    }
  )
  .put(
    '/:id/items/reorder',
    requireAdmin,
    zValidator('param', ZTaskPlanIdParam),
    zValidator('json', ZTaskPlanReorder),
    async (c) => {
      try {
        const data = await reorderPlanItems(
          c.get('actor') as Actor,
          c.req.valid('param').id,
          c.req.valid('json').orderedIds
        );
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to reorder tasks');
      }
    }
  )
  .patch(
    '/:id/items/:itemId',
    requireAdmin,
    zValidator('param', ZTaskPlanItemParam),
    zValidator('json', ZTaskPlanItemUpdate),
    async (c) => {
      try {
        const { id, itemId } = c.req.valid('param');
        const data = await updatePlanItemById(c.get('actor') as Actor, id, itemId, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to update task');
      }
    }
  )
  .delete('/:id/items/:itemId', requireAdmin, zValidator('param', ZTaskPlanItemParam), async (c) => {
    try {
      const { id, itemId } = c.req.valid('param');
      const data = await deletePlanItemById(c.get('actor') as Actor, id, itemId);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to delete task');
    }
  })
  .post(
    '/:id/assign',
    requireAdmin,
    zValidator('param', ZTaskPlanIdParam),
    zValidator('json', ZTaskPlanAssign),
    async (c) => {
      try {
        const data = await assignPlan(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to assign task plan');
      }
    }
  )
  .post(
    '/:id/unassign',
    requireAdmin,
    zValidator('param', ZTaskPlanIdParam),
    zValidator('json', ZTaskPlanAssign),
    async (c) => {
      try {
        const data = await unassignPlan(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to unassign task plan');
      }
    }
  )
  .post('/:id/sync', requireAdmin, zValidator('param', ZTaskPlanIdParam), async (c) => {
    try {
      const data = await syncPlan(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to update assigned tasks');
    }
  });
