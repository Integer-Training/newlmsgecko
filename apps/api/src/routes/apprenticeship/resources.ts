import { Readable } from 'node:stream';
import * as z from 'zod';

import { APPR_RESOURCE_KINDS } from '@cio/utils/constants/apprenticeship';
import { ZEnrolmentIdParam } from '@cio/utils/validation/apprenticeship';
import {
  contentDispositionInline,
  createResource,
  deleteResourceById,
  downloadResource,
  listProgrammeResources,
  listResourcesForEnrolment,
  notifyProgrammeResources,
  openResourceContent,
  presignResourceUpload,
  reorderProgrammeResources,
  setResourceArchived,
  updateResourceById
} from '@api/services/apprenticeship/resources';

import { Hono } from '@api/utils/hono';
import type { Actor } from '@cio/db/actor';
import { handleError } from '@api/utils/errors';
import { requireAdmin, requireRole, requireStaff } from '@api/middlewares/guards';
import { zValidator } from '@hono/zod-validator';

// Gecko Apprenticeships — resources (learning resources + workbooks). Mounted at /apprenticeship/resources.
// Admin writes; staff list a programme's resources; learners (and staff viewing a learner) read through the enrolment.
// The services re-check org/learner/programme scope on every id (anything not visible is a 404).
const requireApprMember = requireRole('ADMIN', 'TUTOR', 'LEARNER');

const ZIdParam = z.object({ id: z.uuid() });
const ZProgrammeParam = z.object({ programmeId: z.uuid() });
const file = z.object({
  key: z.string().trim().min(1).max(1024),
  name: z.string().trim().min(1).max(255),
  size: z.number().int().min(0),
  type: z.string().trim().min(1).max(150)
});
const title = z.string().trim().min(1).max(256);
const description = z.string().trim().max(2000);
const typeKey = z.string().trim().min(1).max(100);

const ZListQuery = z.object({
  status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).optional(),
  kind: z.enum(APPR_RESOURCE_KINDS).optional()
});
const ZPresign = z.object({
  programmeId: z.uuid(),
  resourceId: z.uuid().optional(),
  kind: z.enum(APPR_RESOURCE_KINDS),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(150),
  size: z.number().int().min(0)
});
const ZCreate = z.object({
  id: z.uuid(),
  programmeId: z.uuid(),
  unitId: z.uuid().nullable().optional(),
  kind: z.enum(APPR_RESOURCE_KINDS),
  title,
  description: description.optional(),
  file,
  evidenceTypeKey: typeKey.nullable().optional(),
  criterionIds: z.array(z.uuid()).max(500).default([])
});
const ZUpdate = z
  .object({
    unitId: z.uuid().nullable(),
    kind: z.enum(APPR_RESOURCE_KINDS),
    title,
    description,
    file,
    evidenceTypeKey: typeKey.nullable(),
    criterionIds: z.array(z.uuid()).max(500)
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
const ZReorder = z.object({ unitId: z.uuid().nullable().optional(), ids: z.array(z.uuid()).min(1).max(500) });
const ZNotify = z.object({ resourceIds: z.array(z.uuid()).min(1).max(100) });
const ZContentQuery = z.object({ enrolmentId: z.uuid().optional() });
const ZDownload = z.object({ enrolmentId: z.uuid().optional() });

/** Read the optional download body leniently: none / empty = {}. */
async function readDownloadBody(request: Request) {
  const text = (await request.text()).trim();
  if (text === '') return {};
  try {
    return ZDownload.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

export const resourcesRouter = new Hono()
  .get(
    '/programme/:programmeId',
    requireStaff,
    zValidator('param', ZProgrammeParam),
    zValidator('query', ZListQuery),
    async (c) => {
      try {
        const data = await listProgrammeResources(
          c.get('actor') as Actor,
          c.req.valid('param').programmeId,
          c.req.valid('query')
        );
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to list resources');
      }
    }
  )
  .post('/presign', requireAdmin, zValidator('json', ZPresign), async (c) => {
    try {
      const data = await presignResourceUpload(c.get('actor') as Actor, c.req.valid('json'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to prepare upload');
    }
  })
  .post('/', requireAdmin, zValidator('json', ZCreate), async (c) => {
    try {
      const data = await createResource(c.get('actor') as Actor, c.req.valid('json'));
      return c.json({ success: true, data }, 201);
    } catch (error) {
      return handleError(c, error, 'Failed to create resource');
    }
  })
  .post(
    '/programme/:programmeId/reorder',
    requireAdmin,
    zValidator('param', ZProgrammeParam),
    zValidator('json', ZReorder),
    async (c) => {
      try {
        const data = await reorderProgrammeResources(
          c.get('actor') as Actor,
          c.req.valid('param').programmeId,
          c.req.valid('json')
        );
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to reorder resources');
      }
    }
  )
  .post(
    '/programme/:programmeId/notify',
    requireAdmin,
    zValidator('param', ZProgrammeParam),
    zValidator('json', ZNotify),
    async (c) => {
      try {
        const data = await notifyProgrammeResources(
          c.get('actor') as Actor,
          c.req.valid('param').programmeId,
          c.req.valid('json').resourceIds
        );
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to notify learners');
      }
    }
  )
  .get('/enrolment/:id', requireApprMember, zValidator('param', ZEnrolmentIdParam), async (c) => {
    try {
      const data = await listResourcesForEnrolment(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to list resources');
    }
  })
  .get(
    '/:id/content',
    requireApprMember,
    zValidator('param', ZIdParam),
    zValidator('query', ZContentQuery),
    async (c) => {
      try {
        const out = await openResourceContent(
          c.get('actor') as Actor,
          c.req.valid('param').id,
          c.req.valid('query').enrolmentId
        );
        const headers: Record<string, string> = {
          'Content-Type': out.contentType,
          'Content-Disposition': contentDispositionInline(out.fileName),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': 'sandbox'
        };
        if (out.contentLength != null) headers['Content-Length'] = String(out.contentLength);
        const body = out.body as unknown as { pipe?: unknown };
        const stream =
          typeof body.pipe === 'function'
            ? (Readable.toWeb(out.body as unknown as Readable) as unknown as ReadableStream)
            : (out.body as unknown as ReadableStream);
        return new Response(stream, { status: 200, headers });
      } catch (error) {
        return handleError(c, error, 'Failed to open resource');
      }
    }
  )
  .post('/:id/download', requireApprMember, zValidator('param', ZIdParam), async (c) => {
    try {
      const body = await readDownloadBody(c.req.raw);
      if (!body) return c.json({ success: false, error: 'Invalid request' }, 400);
      const data = await downloadResource(c.get('actor') as Actor, c.req.valid('param').id, body.enrolmentId);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to prepare download');
    }
  })
  .post('/:id/archive', requireAdmin, zValidator('param', ZIdParam), async (c) => {
    try {
      const data = await setResourceArchived(c.get('actor') as Actor, c.req.valid('param').id, true);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to archive resource');
    }
  })
  .post('/:id/restore', requireAdmin, zValidator('param', ZIdParam), async (c) => {
    try {
      const data = await setResourceArchived(c.get('actor') as Actor, c.req.valid('param').id, false);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to restore resource');
    }
  })
  .patch('/:id', requireAdmin, zValidator('param', ZIdParam), zValidator('json', ZUpdate), async (c) => {
    try {
      const data = await updateResourceById(c.get('actor') as Actor, c.req.valid('param').id, c.req.valid('json'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to update resource');
    }
  })
  .delete('/:id', requireAdmin, zValidator('param', ZIdParam), async (c) => {
    try {
      const data = await deleteResourceById(c.get('actor') as Actor, c.req.valid('param').id);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to delete resource');
    }
  });
