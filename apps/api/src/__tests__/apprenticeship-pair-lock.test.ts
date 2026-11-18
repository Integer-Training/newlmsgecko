import { beforeEach, describe, expect, it, vi } from 'vitest';

// Gecko Apprenticeships Deploy 3 — the ONE lock order for a linked pair: enrolments by ascending id (carrier +
// component), whichever half the caller names, and always BEFORE the log / evidence row. DB mocked.

vi.mock('@cio/db/queries/apprenticeship', () => ({
  getLinkedEnrolment: vi.fn(),
  lockApprEnrolment: vi.fn()
}));

import * as q from '@cio/db/queries/apprenticeship';
import { lockApprenticeshipPair, lockEnrolmentsInOrder } from '@api/services/apprenticeship/pair-lock';

const tx = { tx: true } as never;
const CARRIER = { id: 'bbbb', primaryEnrolmentId: null, gatewayPassedAt: null };
const COMPONENT = { id: 'aaaa', primaryEnrolmentId: 'bbbb', gatewayPassedAt: null };
const byId = (id: string) => (id === 'bbbb' ? CARRIER : id === 'aaaa' ? COMPONENT : null);
const lockedIds = () => vi.mocked(q.lockApprEnrolment).mock.calls.map((c) => c[1]);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(q.lockApprEnrolment).mockImplementation((async (_tx: unknown, id: string) => byId(id)) as never);
});

describe('lockEnrolmentsInOrder', () => {
  it('locks ascending by id regardless of the order given, once per id', async () => {
    await lockEnrolmentsInOrder(tx, ['c', 'a', 'b', 'a']);
    expect(lockedIds()).toEqual(['a', 'b', 'c']);
  });
});

describe('lockApprenticeshipPair', () => {
  it('from the carrier or the component, both rows are locked in the SAME (id) order', async () => {
    vi.mocked(q.getLinkedEnrolment).mockImplementation((async (id: string) =>
      id === 'bbbb' ? COMPONENT : CARRIER) as never);
    await lockApprenticeshipPair(tx, 'bbbb');
    const fromCarrier = lockedIds();
    vi.mocked(q.lockApprEnrolment).mockClear();
    await lockApprenticeshipPair(tx, 'aaaa');
    expect(fromCarrier).toEqual(['aaaa', 'bbbb']);
    expect(lockedIds()).toEqual(fromCarrier);
  });

  it('returns the locked carrier and component rows', async () => {
    vi.mocked(q.getLinkedEnrolment).mockResolvedValue(COMPONENT as never);
    const { carrier, component } = await lockApprenticeshipPair(tx, 'bbbb');
    expect(carrier?.id).toBe('bbbb');
    expect(component?.id).toBe('aaaa');
  });

  it('a standalone enrolment locks only itself', async () => {
    vi.mocked(q.getLinkedEnrolment).mockResolvedValue(null);
    const { carrier, component } = await lockApprenticeshipPair(tx, 'bbbb');
    expect(lockedIds()).toEqual(['bbbb']);
    expect(carrier?.id).toBe('bbbb');
    expect(component).toBeNull();
  });
});
