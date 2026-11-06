import { sql } from '@db/drizzle';

// Display name for a profile row in apprenticeship screens: the account's full name (user.name, e.g. "Amy Apprentice")
// when set, else profile.fullname (often just a short handle). Use where "profile" is in the FROM list unaliased.
export const profileDisplayName = sql<string>`coalesce(nullif((select u.name from "user" u where u.id = "profile"."id"), ''), "profile"."fullname")`;
