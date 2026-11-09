import { Hono } from '@api/utils/hono';
import { enrolmentsRouter } from '@api/routes/apprenticeship/enrolments';
import { evidenceRouter } from '@api/routes/apprenticeship/evidence';
import { programmesRouter } from '@api/routes/apprenticeship/programmes';
import { reviewsRouter } from '@api/routes/apprenticeship/reviews';
import { settingsRouter } from '@api/routes/apprenticeship/settings';
import { taskPlansRouter } from '@api/routes/apprenticeship/task-plans';
import { tasksRouter } from '@api/routes/apprenticeship/tasks';

// Gecko Apprenticeships API, mounted at /apprenticeship in app.ts.
export const apprenticeshipRouter = new Hono()
  .route('/programmes', programmesRouter)
  .route('/settings', settingsRouter)
  .route('/enrolments', enrolmentsRouter)
  .route('/evidence', evidenceRouter)
  .route('/task-plans', taskPlansRouter)
  .route('/tasks', tasksRouter)
  .route('/reviews', reviewsRouter);
