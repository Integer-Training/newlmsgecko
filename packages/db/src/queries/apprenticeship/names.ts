import * as schema from '@db/schema';

import { db, inArray, sql, type DbOrTxClient } from '@db/drizzle';

// Display name for a profile row in apprenticeship screens: the account's full name (user.name, e.g. "Amy Apprentice")
// when set, else profile.fullname (often just a short handle). Use where "profile" is in the FROM list unaliased.
export const profileDisplayName = sql<string>`coalesce(nullif((select u.name from "user" u where u.id = "profile"."id"), ''), "profile"."fullname")`;

/** id → display name (same rule as profileDisplayName) for a set of profile ids, in one statement. */
export async function listProfileDisplayNames(ids: string[], client: DbOrTxClient = db) {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await client
    .select({ id: schema.profile.id, name: profileDisplayName })
    .from(schema.profile)
    .where(inArray(schema.profile.id, ids));
  for (const r of rows) if (r.name) out.set(r.id, r.name);
  return out;
}
