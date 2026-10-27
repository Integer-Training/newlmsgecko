import 'dotenv/config';

import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import bcrypt from 'bcrypt';
import { eq, sql } from 'drizzle-orm';
import { MEMBER_STATUS, ROLE } from '@cio/utils/constants/roles';
import type { DbClient } from '../drizzle';
import { account, organization, organizationmember, organizationPlan, profile, user } from '../schema';

/**
 * Gecko — bootstrap the FIRST admin + organization on an EMPTY database (docs/REPLICATION.md Phase 3 item 1,
 * Appendix D §3.7). Public sign-up is closed (`disableSignUp:true`) and `POST /onboarding/create-org` needs an
 * already-logged-in user, so nothing else can create the permanent super admin on a fresh DB.
 *
 *   BOOT_EMAIL="owner@example.com" BOOT_NAME="Jane Owner" BOOT_PASSWORD="a-strong-password" \
 *   BOOT_ORG_NAME="Gecko Programmes" BOOT_SITE_NAME="gecko" \
 *     pnpm --filter @cio/db bootstrap:owner
 *
 * Point DATABASE_URL at the target database. Writes user → account → profile → organization →
 * organizationmember → organization_plan in ONE transaction and ABORTS (exit 1) if ANY organization already
 * exists. The organizationmember row created here is the lowest admin member id, which the app derives as the
 * permanent super admin. The password (and its hash) is never logged. Recovery later:
 * `set-password.ts` (SET_PW_EMAIL / SET_PW_PASSWORD).
 *
 * Code-vs-spec notes: the app's password policy is length 8..128 only (`auth/email-password.ts`); hashing is
 * `bcrypt.hash(pw, 10)` / `bcrypt.compare` — mirrored here. The forced-change flag is `profile.settings
 * .mustChangePassword` (read by the dashboard `init.svelte.ts`, cleared by `POST /account/change-password`).
 */

/** Same limits as Better Auth `emailAndPassword` in `packages/db/src/auth/email-password.ts`. */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
/** Same cost as `emailAndPassword.password.hash` in `packages/db/src/auth/email-password.ts`. */
export const BCRYPT_COST = 10;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SITE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface BootstrapInput {
  email: string;
  name: string;
  password: string;
  orgName: string;
  siteName: string;
}

export interface BootstrapResult {
  userId: string;
  organizationId: string;
  memberId: number;
  username: string;
  email: string;
  siteName: string;
}

/** Raised for operator-fixable problems; `main()` prints the message (never a stack/params) and exits 1. */
export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

/** Validate + normalise the BOOT_* env vars. Throws BootstrapError listing every problem. */
export function parseBootstrapEnv(env: Record<string, string | undefined>): BootstrapInput {
  const problems: string[] = [];
  const required = ['BOOT_EMAIL', 'BOOT_NAME', 'BOOT_PASSWORD', 'BOOT_ORG_NAME', 'BOOT_SITE_NAME'] as const;
  for (const key of required) {
    if (!env[key] || !env[key]!.trim()) problems.push(`${key} is required`);
  }

  const email = (env.BOOT_EMAIL ?? '').trim();
  const name = (env.BOOT_NAME ?? '').trim();
  const orgName = (env.BOOT_ORG_NAME ?? '').trim();
  const siteName = (env.BOOT_SITE_NAME ?? '').trim();
  const password = env.BOOT_PASSWORD ?? ''; // deliberately NOT trimmed — whitespace is part of the secret

  if (email && !EMAIL_RE.test(email)) problems.push('BOOT_EMAIL is not a valid email address');
  else if (email && email !== email.toLowerCase()) problems.push('BOOT_EMAIL must be lowercase');

  if (password && (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH)) {
    problems.push(
      `BOOT_PASSWORD must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters (app password policy)`
    );
  }

  if (siteName && (siteName.length > 63 || !SITE_NAME_RE.test(siteName))) {
    problems.push(
      'BOOT_SITE_NAME must be a lowercase slug (a-z, 0-9, single hyphens between, max 63 chars) — it becomes /org/<siteName>'
    );
  }

  if (problems.length) {
    throw new BootstrapError(`Invalid bootstrap input:\n - ${problems.join('\n - ')}`);
  }
  return { email, name, password, orgName, siteName };
}

/** Username from the email prefix + random suffix (profile.username is globally unique). */
function makeUsername(email: string): string {
  const prefix =
    email
      .split('@')[0]
      .replace(/[^a-z0-9._-]/g, '')
      .slice(0, 30) || 'owner';
  return `${prefix}-${randomBytes(3).toString('hex')}`;
}

/**
 * Create the owner in ONE transaction. `database` only needs `.transaction` so tests can pass a mock.
 * Order: user → account → profile → organization → organizationmember → organization_plan.
 */
export async function bootstrapOwner(
  database: Pick<DbClient, 'transaction'>,
  input: BootstrapInput
): Promise<BootstrapResult> {
  // Hash outside the transaction (CPU-bound; keeps the lock window short). Same lib/cost the app verifies with.
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

  return database.transaction(async (tx) => {
    // Serialise concurrent runs: SHARE ROW EXCLUSIVE conflicts with itself and with writers, so a second
    // run blocks here until the first commits, then sees the organization and aborts below.
    await tx.execute(sql`LOCK TABLE ${organization} IN SHARE ROW EXCLUSIVE MODE`);

    const [existingOrg] = await tx.select({ id: organization.id }).from(organization).limit(1);
    if (existingOrg) {
      throw new BootstrapError(
        'Refusing to bootstrap: an organization already exists. This script only runs once, on an empty database. ' +
          'To recover a login use set-password.ts; to add people use the admin screens.'
      );
    }

    const [existingUser] = await tx.select({ id: user.id }).from(user).where(eq(user.email, input.email)).limit(1);
    if (existingUser) {
      throw new BootstrapError(`Refusing to bootstrap: a user with email ${input.email} already exists.`);
    }

    const userId = randomUUID();
    const username = makeUsername(input.email);
    const now = new Date().toISOString();

    await tx.insert(user).values({
      id: userId,
      name: input.name,
      email: input.email,
      emailVerified: true,
      image: null,
      role: null, // Better Auth admin-plugin role is unused for authz
      banned: false,
      isAnonymous: false
    });

    await tx.insert(account).values({
      userId,
      providerId: 'credential',
      accountId: userId,
      password: passwordHash
    });

    await tx.insert(profile).values({
      id: userId,
      fullname: input.name,
      username,
      email: input.email,
      status: MEMBER_STATUS.ACTIVE,
      isEmailVerified: true,
      verifiedAt: now,
      settings: { mustChangePassword: true }
    });

    const [org] = await tx
      .insert(organization)
      .values({ name: input.orgName, siteName: input.siteName })
      .returning({ id: organization.id });

    const [member] = await tx
      .insert(organizationmember)
      .values({
        organizationId: org.id,
        roleId: ROLE.ADMIN,
        profileId: userId,
        email: input.email,
        verified: true
      })
      .returning({ id: organizationmember.id });

    await tx.insert(organizationPlan).values({
      orgId: org.id,
      planName: 'ENTERPRISE',
      isActive: true,
      provider: 'selfhosted',
      subscriptionId: `selfhosted-${org.id}`,
      triggeredBy: member.id,
      payload: {}
    });

    return {
      userId,
      organizationId: org.id,
      memberId: member.id,
      username,
      email: input.email,
      siteName: input.siteName
    };
  });
}

/** Strip secrets from any text before it is printed (drizzle errors embed query params, incl. the hash). */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  // Any bcrypt hash that slipped through.
  return out.replace(/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, '[redacted]');
}

async function main() {
  let input: BootstrapInput;
  try {
    input = parseBootstrapEnv(process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    console.error(
      '\nUsage: BOOT_EMAIL=… BOOT_NAME=… BOOT_PASSWORD=… BOOT_ORG_NAME=… BOOT_SITE_NAME=… pnpm --filter @cio/db bootstrap:owner'
    );
    process.exit(1);
  }

  const { db } = await import('../drizzle');
  try {
    const result = await bootstrapOwner(db, input);
    console.log('Bootstrap complete (password not logged).');
    console.log(`  user:         ${result.email} (${result.userId})`);
    console.log(`  organization: ${input.orgName} (${result.organizationId}), site_name=${result.siteName}`);
    console.log(`  admin member: ${result.memberId} — the permanent super admin`);
    console.log('  The owner must change the password on first login (settings.mustChangePassword=true).');
    process.exit(0);
  } catch (e) {
    const err = e as Error & { cause?: Error };
    const raw = e instanceof BootstrapError ? err.message : (err.cause?.message ?? err.message ?? String(e));
    console.error(`bootstrap-owner failed (transaction rolled back): ${redact(raw, [input.password])}`);
    process.exit(1);
  }
}

// Only run when executed directly (so tests can import the helpers without touching a database).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
