import {
  ZIqaAcknowledge,
  ZIqaDecide,
  ZIqaEvidenceParam,
  ZIqaQuery,
  ZIqaSampleCreate,
  ZIqaSampleParam,
  ZIqaSuggest,
  ZIqaTargetPut
} from '@cio/utils/validation/apprenticeship';
import {
  acknowledgeIqaOutcome,
  createIqaSample,
  decideIqaSampleOutcome,
  deleteIqaSample,
  getEvidenceIqa,
  getIqaCoverage,
  listIqaSamples,
  putIqaTarget,
  suggestIqaSamples
} from '@api/services/apprenticeship/iqa';

import { Hono } from '@api/utils/hono';
import type { Actor } from '@cio/db/actor';
import { handleError } from '@api/utils/errors';
import { requireAdmin, requireRole } from '@api/middlewares/guards';
import { zValidator } from '@hono/zod-validator';

// Gecko Apprenticeships — IQA sampling. Mounted at /apprenticeship. Sampling, deciding, coverage and the target are
// ADMIN only; a tutor reads their own IQA feedback (samples where they are the assessor) and acknowledges it. Learners
// and managers have no access. Fine-grained rules live in the service.
const requireIqaStaff = requireRole('ADMIN', 'TUTOR');

export const iqaRouter = new Hono()
  .get('/iqa/coverage', requireAdmin, zValidator('query', ZIqaQuery), async (c) => {
    try {
      const data = await getIqaCoverage(c.get('actor') as Actor, c.req.valid('query'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load IQA coverage');
    }
  })
  .get('/iqa/samples', requireIqaStaff, zValidator('query', ZIqaQuery), async (c) => {
    try {
      const data = await listIqaSamples(c.get('actor') as Actor, c.req.valid('query'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load IQA samples');
    }
  })
  .post('/iqa/samples', requireAdmin, zValidator('json', ZIqaSampleCreate), async (c) => {
    try {
      const data = await createIqaSample(c.get('actor') as Actor, c.req.valid('json'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to sample evidence');
    }
  })
  .post('/iqa/suggest', requireAdmin, zValidator('json', ZIqaSuggest), async (c) => {
    try {
      const data = await suggestIqaSamples(c.get('actor') as Actor, c.req.valid('json'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to suggest a sample');
    }
  })
  .put('/iqa/target', requireAdmin, zValidator('json', ZIqaTargetPut), async (c) => {
    try {
      const data = await putIqaTarget(c.get('actor') as Actor, c.req.valid('json'));
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to save the sampling target');
    }
  })
  .post(
    '/iqa/samples/:sampleId/decide',
    requireAdmin,
    zValidator('param', ZIqaSampleParam),
    zValidator('json', ZIqaDecide),
    async (c) => {
      try {
        const data = await decideIqaSampleOutcome(
          c.get('actor') as Actor,
          c.req.valid('param').sampleId,
          c.req.valid('json')
        );
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to record the IQA outcome');
      }
    }
  )
  .post(
    '/iqa/samples/:sampleId/acknowledge',
    requireIqaStaff,
    zValidator('param', ZIqaSampleParam),
    zValidator('json', ZIqaAcknowledge),
    async (c) => {
      try {
        const data = await acknowledgeIqaOutcome(
          c.get('actor') as Actor,
          c.req.valid('param').sampleId,
          c.req.valid('json')
        );
        return c.json({ success: true, data }, 200);
      } catch (error) {
        return handleError(c, error, 'Failed to acknowledge the IQA feedback');
      }
    }
  )
  .delete('/iqa/samples/:sampleId', requireAdmin, zValidator('param', ZIqaSampleParam), async (c) => {
    try {
      const data = await deleteIqaSample(c.get('actor') as Actor, c.req.valid('param').sampleId);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to remove the sample');
    }
  })
  .get('/evidence/:evidenceId/iqa', requireIqaStaff, zValidator('param', ZIqaEvidenceParam), async (c) => {
    try {
      const data = await getEvidenceIqa(c.get('actor') as Actor, c.req.valid('param').evidenceId);
      return c.json({ success: true, data }, 200);
    } catch (error) {
      return handleError(c, error, 'Failed to load the IQA sample');
    }
  });
