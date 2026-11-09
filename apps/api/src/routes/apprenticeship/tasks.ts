import {
  ZEnrolmentIdParam,
  ZTaskCreate,
  ZTaskDownload,
  ZTaskIdParam,
  ZTaskOverdueQuery,
  ZTaskPresign,
  ZTaskUpdate
} from '@cio/utils/validation/apprenticeship';
import {
  createTask,
  deleteTask,
  listEnrolmentTasks,
  listOverdue,
  presignTaskUploads,
  signTaskDownloads,
  updateTask
} from '@api/services/apprenticeship/tasks';
import { signPlanDownloads } from '@api/services/apprenticeship/task-plans';

import { Hono } from '@api/utils/hono';
import type { Actor } from '@cio/db/actor';
import { handleError } from '@api/utils/errors';
import { requireRole, requireStaff } from '@api/middlewares/guards';
import { zValidator } from '@hono/zod-validator';

// Gecko Apprenticeships — learner tasks. Readable by ADMIN, the allocated TUTOR and the apprentice themselves (the
// services scope every call through access.ts; anything else 404s); created / edited / deleted by staff only.
// Static paths are registered before '/:id'. Mounted at /apprenticeship/tasks.
const requireApprMember = requireRole('ADMIN', 'TUTOR', 'LEARNER');

export const tasksRouter = new Hono()
  .get('/enrolments/:id/tasks', requireApprMember, zValidator('param', ZEnrolmentIdParam), async (c) => {
    try {
      const data = await listEnrolmentTasks(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to list tasks');
    }
  })
  .post(
    '/enrolments/:id/tasks',
    requireStaff,
    zValidator('param', ZEnrolmentIdParam),
    zValidator('json', ZTaskCreate),
    async (c) => {
      try {
        const data = await createTask(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 201);
      } catch (error) {
        return handleError(c, error, 'Failed to add task');
      }
    }
  )
  .get('/overdue', requireStaff, zValidator('query', ZTaskOverdueQuery), async (c) => {
    try {
      const data = await listOverdue(c.get('actor') as Actor, c.req.valid('query'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load overdue tasks');
    }
  })
  .post('/presign', requireStaff, zValidator('json', ZTaskPresign), async (c) => {
    try {
      const data = await presignTaskUploads(c.get('actor') as Actor, c.req.valid('json'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to prepare uploads');
    }
  })
  .post('/download', requireApprMember, zValidator('json', ZTaskDownload), async (c) => {
    try {
      const actor = c.get('actor') as Actor;
      const { taskId, planId, keys } = c.req.valid('json');
      // A task brief: ADMIN / allocated TUTOR / the apprentice. A plan brief: staff of the org.
      const data = taskId
        ? await signTaskDownloads(actor, taskId, keys)
        : await signPlanDownloads(actor, planId!, keys);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to prepare downloads');
    }
  })
  .patch('/:id', requireStaff, zValidator('param', ZTaskIdParam), zValidator('json', ZTaskUpdate), async (c) => {
    try {
      const data = await updateTask(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to update task');
    }
  })
  .delete('/:id', requireStaff, zValidator('param', ZTaskIdParam), async (c) => {
    try {
      const data = await deleteTask(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to delete task');
    }
  });
