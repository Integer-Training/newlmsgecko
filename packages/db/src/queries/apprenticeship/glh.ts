import * as schema from '@db/schema';

import { and, db, desc, eq, sql, type DbOrTxClient } from '@db/drizzle';
import { profileDisplayName } from './names';

// Gecko Apprenticeships — staff-logged guided learning hours (appr_glh_log). No access control here (services scope the
// actor first). GLH done = GLH of completed units + the sum of these logs, cached on appr_enrolment.glh_minutes.

const g = schema.apprGlhLog;

export async function listGlhLogs(enrolmentId: string, client: DbOrTxClient = db) {
  return client
    .select({
      id: g.id,
      minutes: g.minutes,
      logDate: g.logDate,
      note: g.note,
      createdAt: g.createdAt,
      createdBy: g.createdBy,
      createdByName: profileDisplayName
    })
    .from(g)
    .leftJoin(schema.profile, eq(schema.profile.id, g.createdBy))
    .where(eq(g.enrolmentId, enrolmentId))
    .orderBy(desc(g.logDate), desc(g.createdAt));
}

export async function getGlhLog(logId: string, client: DbOrTxClient = db) {
  const [row] = await client.select().from(g).where(eq(g.id, logId)).limit(1);
  return row ?? null;
}

export async function insertGlhLog(tx: DbOrTxClient, values: typeof g.$inferInsert) {
  const [row] = await tx.insert(g).values(values).returning();
  return row;
}

export async function deleteGlhLog(tx: DbOrTxClient, logId: string, enrolmentId: string) {
  const rows = await tx
    .delete(g)
    .where(and(eq(g.id, logId), eq(g.enrolmentId, enrolmentId)))
    .returning({ id: g.id });
  return rows.length > 0;
}

/** Total logged minutes for one enrolment. */
export async function sumGlhLogMinutes(enrolmentId: string, client: DbOrTxClient = db): Promise<number> {
  const [row] = await client
    .select({ n: sql<number>`coalesce(sum(${g.minutes}), 0)::int` })
    .from(g)
    .where(eq(g.enrolmentId, enrolmentId));
  return row?.n ?? 0;
}
