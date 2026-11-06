import { Hono } from '@api/utils/hono';
import { programmesRouter } from '@api/routes/apprenticeship/programmes';
import { settingsRouter } from '@api/routes/apprenticeship/settings';

// Gecko Apprenticeships API, mounted at /apprenticeship in app.ts.
export const apprenticeshipRouter = new Hono()
  .route('/programmes', programmesRouter)
  .route('/settings', settingsRouter);
