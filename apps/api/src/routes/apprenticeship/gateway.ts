import {
  ZEnrolmentIdParam,
  ZEpaUpdate,
  ZGatewayChecklistPut,
  ZGatewayItemParam,
  ZGatewayTick,
  ZGlhLogCreate,
  ZGlhLogIdParam,
  ZProgrammeIdParam
} from '@cio/utils/validation/apprenticeship';
import {
  confirmGateway,
  getGateway,
  getGatewayChecklist,
  putGatewayChecklist,
  reopenGateway,
  setGatewayItem,
  updateEpa
} from '@api/services/apprenticeship/gateway';
import { addGlhLog, listEnrolmentGlhLogs, removeGlhLog } from '@api/services/apprenticeship/glh';

import { Hono } from '@api/utils/hono';
import type { Actor } from '@cio/db/actor';
import { handleError } from '@api/utils/errors';
import { requireAdmin, requireRole, requireStaff } from '@api/middlewares/guards';
import { zValidator } from '@hono/zod-validator';

// Gecko Apprenticeships — GLH logs, the gateway checklist and the end-point assessment. Mounted at /apprenticeship
// (the paths below carry /enrolments and /programmes themselves). Readable by ADMIN, the allocated TUTOR and the
// apprentice themselves; every write is staff only (a tutor only for an allocated learner — anything else 404s),
// except programme checklist edits and reopening the gateway, which are ADMIN only. Managers have no access.
const requireApprMember = requireRole('ADMIN', 'TUTOR', 'LEARNER');

export const gatewayRouter = new Hono()
  // ── Programme setup ──
  .get('/programmes/:id/gateway-checklist', requireAdmin, zValidator('param', ZProgrammeIdParam), async (c) => {
    try {
      const data = await getGatewayChecklist(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load gateway checklist');
    }
  })
  .put(
    '/programmes/:id/gateway-checklist',
    requireAdmin,
    zValidator('param', ZProgrammeIdParam),
    zValidator('json', ZGatewayChecklistPut),
    async (c) => {
      try {
        const data = await putGatewayChecklist(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to save gateway checklist');
      }
    }
  )
  // ── GLH logs ──
  .get('/enrolments/:id/glh-logs', requireApprMember, zValidator('param', ZEnrolmentIdParam), async (c) => {
    try {
      const data = await listEnrolmentGlhLogs(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to list GLH entries');
    }
  })
  .post(
    '/enrolments/:id/glh-logs',
    requireStaff,
    zValidator('param', ZEnrolmentIdParam),
    zValidator('json', ZGlhLogCreate),
    async (c) => {
      try {
        const data = await addGlhLog(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 201);
      } catch (error) {
        return handleError(c, error, 'Failed to log GLH');
      }
    }
  )
  .delete('/enrolments/:id/glh-logs/:logId', requireStaff, zValidator('param', ZGlhLogIdParam), async (c) => {
    try {
      const { id, logId } = c.req.valid('param');
      const data = await removeGlhLog(c.get('actor') as Actor, id, logId);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to remove GLH entry');
    }
  })
  // ── Gateway + EPA ──
  .get('/enrolments/:id/gateway', requireApprMember, zValidator('param', ZEnrolmentIdParam), async (c) => {
    try {
      const data = await getGateway(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load gateway');
    }
  })
  .put(
    '/enrolments/:id/gateway/items/:key',
    requireStaff,
    zValidator('param', ZGatewayItemParam),
    zValidator('json', ZGatewayTick),
    async (c) => {
      try {
        const { id, key } = c.req.valid('param');
        const data = await setGatewayItem(c.get('actor') as Actor, id, key, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to update gateway item');
      }
    }
  )
  .post('/enrolments/:id/gateway/confirm', requireStaff, zValidator('param', ZEnrolmentIdParam), async (c) => {
    try {
      const data = await confirmGateway(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to confirm gateway');
    }
  })
  .post('/enrolments/:id/gateway/reopen', requireAdmin, zValidator('param', ZEnrolmentIdParam), async (c) => {
    try {
      const data = await reopenGateway(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to reopen gateway');
    }
  })
  .patch(
    '/enrolments/:id/epa',
    requireStaff,
    zValidator('param', ZEnrolmentIdParam),
    zValidator('json', ZEpaUpdate),
    async (c) => {
      try {
        const data = await updateEpa(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to update end-point assessment');
      }
    }
  );
