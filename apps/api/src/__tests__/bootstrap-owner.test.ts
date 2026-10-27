import { createRequire } from 'node:module';
import { getTableName } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BCRYPT_COST,
  BootstrapError,
  bootstrapOwner,
  parseBootstrapEnv,
  redact,
  type BootstrapInput
} from '../../../../packages/db/src/scripts/bootstrap-owner';

// bcrypt is a dependency of @cio/db, not @cio/api: resolve it from the db package (the same copy the script uses).
const bcrypt: typeof import('bcrypt') = createRequire(new URL('../../../../packages/db/package.json', import.meta.url))(
  'bcrypt'
);

const goodEnv = {
  BOOT_EMAIL: 'owner@example.com',
  BOOT_NAME: 'Jane Owner',
  BOOT_PASSWORD: 'Sup3r-secret-pw!',
  BOOT_ORG_NAME: 'Gecko Programmes',
  BOOT_SITE_NAME: 'gecko-programmes'
};

const goodInput: BootstrapInput = parseBootstrapEnv(goodEnv);

type Call = { op: string; table?: string; values?: any };

/** Mock db: records every tx operation in order; `existingOrg` / `existingUser` drive the guard selects. */
function makeMockDb(opts: { existingOrg?: boolean; existingUser?: boolean } = {}) {
  const calls: Call[] = [];
  const state = { transactions: 0, committed: false };
  const ids: Record<string, any> = { organization: { id: 'org-1' }, organizationmember: { id: 42 } };

  const tx = {
    execute: vi.fn(async () => {
      calls.push({ op: 'lock' });
    }),
    select: vi.fn(() => ({
      from: (table: any) => {
        const name = getTableName(table);
        calls.push({ op: 'select', table: name });
        const rows =
          name === 'organization' ? (opts.existingOrg ? [{ id: 'x' }] : []) : opts.existingUser ? [{ id: 'u' }] : [];
        const chain: any = { where: () => chain, limit: async () => rows };
        return chain;
      }
    })),
    insert: vi.fn((table: any) => ({
      values: (values: any) => {
        const name = getTableName(table);
        calls.push({ op: 'insert', table: name, values });
        return { returning: async () => [ids[name]] };
      }
    }))
  };

  const database = {
    transaction: vi.fn(async (fn: (t: any) => Promise<any>) => {
      state.transactions++;
      const result = await fn(tx); // a throw here = rollback (no commit)
      state.committed = true;
      return result;
    })
  };
  return { database: database as any, calls, state, tx };
}

afterEach(() => vi.restoreAllMocks());

describe('parseBootstrapEnv', () => {
  it('accepts valid input and trims non-secret fields', () => {
    const out = parseBootstrapEnv({ ...goodEnv, BOOT_NAME: '  Jane Owner ', BOOT_ORG_NAME: ' Gecko ' });
    expect(out).toMatchObject({
      email: 'owner@example.com',
      name: 'Jane Owner',
      orgName: 'Gecko',
      siteName: 'gecko-programmes'
    });
    expect(out.password).toBe(goodEnv.BOOT_PASSWORD);
  });

  it.each(Object.keys(goodEnv))('rejects a missing %s', (key) => {
    const env: Record<string, string | undefined> = { ...goodEnv };
    delete env[key];
    expect(() => parseBootstrapEnv(env)).toThrow(new RegExp(`${key} is required`));
    expect(() => parseBootstrapEnv({ ...goodEnv, [key]: '   ' })).toThrow(BootstrapError);
  });

  it('rejects malformed and non-lowercase emails', () => {
    expect(() => parseBootstrapEnv({ ...goodEnv, BOOT_EMAIL: 'not-an-email' })).toThrow(/not a valid email/);
    expect(() => parseBootstrapEnv({ ...goodEnv, BOOT_EMAIL: 'Owner@Example.com' })).toThrow(/lowercase/);
  });

  it('enforces the app password policy (8..128 chars)', () => {
    expect(() => parseBootstrapEnv({ ...goodEnv, BOOT_PASSWORD: 'short' })).toThrow(/8-128/);
    expect(() => parseBootstrapEnv({ ...goodEnv, BOOT_PASSWORD: 'x'.repeat(129) })).toThrow(/8-128/);
    expect(parseBootstrapEnv({ ...goodEnv, BOOT_PASSWORD: 'x'.repeat(128) }).password).toHaveLength(128);
    expect(parseBootstrapEnv({ ...goodEnv, BOOT_PASSWORD: '12345678' }).password).toBe('12345678');
  });

  it.each(['Gecko', 'has space', '-lead', 'trail-', 'dou--ble', 'under_score', 'a'.repeat(64)])(
    'rejects non-slug site name %j',
    (siteName) => {
      expect(() => parseBootstrapEnv({ ...goodEnv, BOOT_SITE_NAME: siteName })).toThrow(/BOOT_SITE_NAME/);
    }
  );

  it('does not echo the password in validation errors', () => {
    let message = '';
    try {
      parseBootstrapEnv({ ...goodEnv, BOOT_PASSWORD: 'tiny', BOOT_EMAIL: 'bad' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/Invalid bootstrap input/);
    expect(message).not.toContain('tiny');
  });
});

describe('bootstrapOwner', () => {
  it('aborts (no inserts, no commit) when any organization already exists', async () => {
    const { database, calls, state } = makeMockDb({ existingOrg: true });
    await expect(bootstrapOwner(database, goodInput)).rejects.toThrow(/organization already exists/);
    expect(calls.filter((c) => c.op === 'insert')).toHaveLength(0);
    expect(state.committed).toBe(false);
  });

  it('aborts when the email is already a user', async () => {
    const { database, calls, state } = makeMockDb({ existingUser: true });
    await expect(bootstrapOwner(database, goodInput)).rejects.toThrow(/already exists/);
    expect(calls.filter((c) => c.op === 'insert')).toHaveLength(0);
    expect(state.committed).toBe(false);
  });

  it('locks the organization table, then checks emptiness, inside the single transaction', async () => {
    const { database, calls, state } = makeMockDb();
    await bootstrapOwner(database, goodInput);
    expect(state.transactions).toBe(1);
    expect(state.committed).toBe(true);
    expect(calls[0]).toEqual({ op: 'lock' });
    expect(calls[1]).toEqual({ op: 'select', table: 'organization' });
  });

  it('inserts user -> account -> profile -> organization -> organizationmember -> organization_plan with the expected values', async () => {
    const { database, calls } = makeMockDb();
    const result = await bootstrapOwner(database, goodInput);

    const inserts = calls.filter((c) => c.op === 'insert');
    expect(inserts.map((c) => c.table)).toEqual([
      'user',
      'account',
      'profile',
      'organization',
      'organizationmember',
      'organization_plan'
    ]);
    const [u, a, p, o, m, plan] = inserts.map((c) => c.values);
    const id = u.id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result).toMatchObject({ userId: id, organizationId: 'org-1', memberId: 42, email: 'owner@example.com' });

    expect(u).toMatchObject({
      name: 'Jane Owner',
      email: 'owner@example.com',
      emailVerified: true,
      banned: false,
      role: null
    });
    expect(a).toMatchObject({ userId: id, providerId: 'credential', accountId: id });
    expect(p).toMatchObject({
      id,
      fullname: 'Jane Owner',
      email: 'owner@example.com',
      status: 'ACTIVE',
      isEmailVerified: true,
      settings: { mustChangePassword: true }
    });
    expect(p.username).toMatch(/^owner-[0-9a-f]{6}$/);
    expect(new Date(p.verifiedAt).toString()).not.toBe('Invalid Date');
    expect(o).toEqual({ name: 'Gecko Programmes', siteName: 'gecko-programmes' });
    expect(m).toEqual({
      organizationId: 'org-1',
      roleId: 1,
      profileId: id,
      email: 'owner@example.com',
      verified: true
    });
    expect(plan).toEqual({
      orgId: 'org-1',
      planName: 'ENTERPRISE',
      isActive: true,
      provider: 'selfhosted',
      subscriptionId: 'selfhosted-org-1',
      triggeredBy: 42,
      payload: {}
    });
  });

  it('stores a bcrypt (cost 10) hash that the app verify function accepts, and never the plaintext', async () => {
    const { database, calls } = makeMockDb();
    await bootstrapOwner(database, goodInput);
    const hash = calls.find((c) => c.table === 'account')!.values.password as string;

    expect(hash).not.toContain(goodInput.password);
    expect(hash).toMatch(new RegExp(`^\\$2[aby]\\$${BCRYPT_COST}\\$`));
    expect(BCRYPT_COST).toBe(10);
    // Exactly what packages/db/src/auth/email-password.ts does: bcrypt.compare(password, hash).
    const appVerify = ({ hash: h, password }: { hash: string; password: string }) => bcrypt.compare(password, h);
    expect(await appVerify({ hash, password: goodInput.password })).toBe(true);
    expect(await appVerify({ hash, password: 'wrong-password' })).toBe(false);

    // The plaintext appears in no other inserted row.
    const others = JSON.stringify(calls.filter((c) => c.table !== 'account').map((c) => c.values));
    expect(others).not.toContain(goodInput.password);
  });

  it('propagates a mid-transaction failure without committing', async () => {
    const { database, tx, state } = makeMockDb();
    const realInsert = tx.insert.getMockImplementation()!;
    tx.insert.mockImplementation(((table: any) => {
      if (getTableName(table) === 'organization_plan') throw new Error('boom');
      return realInsert(table);
    }) as any);
    await expect(bootstrapOwner(database, goodInput)).rejects.toThrow('boom');
    expect(state.committed).toBe(false);
  });

  it('logs nothing (no console output) during a successful run', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => {})
    );
    const { database } = makeMockDb();
    await bootstrapOwner(database, goodInput);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe('redact', () => {
  it('removes the password and any bcrypt hash from error text', () => {
    const hash = bcrypt.hashSync('Sup3r-secret-pw!', 4);
    const text = `Failed query: insert ... params: owner@example.com,Sup3r-secret-pw!,${hash}`;
    const out = redact(text, ['Sup3r-secret-pw!']);
    expect(out).not.toContain('Sup3r-secret-pw!');
    expect(out).not.toContain(hash);
  });
});
