import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  getActiveSession: vi.fn(async () => ({
    sessionId: 'session-1',
    walletId: 'loop',
    partyId: 'alice::1220test',
    network: 'devnet',
  })),
}));

vi.mock('@partylayer/sdk', () => ({
  createPartyLayer: () => ({
    connect: mocks.connect,
    disconnect: vi.fn(async () => undefined),
    listWallets: vi.fn(async () => []),
    getAdapter: vi.fn(() => undefined),
    getActiveSession: mocks.getActiveSession,
    ledgerApi: vi.fn(async () => undefined),
    on: vi.fn(() => vi.fn()),
    destroy: vi.fn(),
  }),
}));

import { partyLayerWalletClient } from './partyLayerClient.js';

describe('PartyLayer Loop connection', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.connect.mockClear();
    mocks.getActiveSession.mockClear();
  });

  it('leaves ticket lifecycle management to the Loop SDK', async () => {
    const handshake = JSON.stringify({
      sessionId: 'session-1',
      ticketId: 'ticket-1',
    });
    localStorage.setItem('loop_connect', handshake);

    const result = await partyLayerWalletClient.connect('loop');

    expect(result.isConnected).toBe(true);
    expect(mocks.connect).toHaveBeenCalledWith({ walletId: 'loop' });
    expect(localStorage.getItem('loop_connect')).toBe(handshake);
  });
});
