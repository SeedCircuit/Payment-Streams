import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CantonStreamsApi, SupportedAsset } from '../api/client.js';
import {
  acceptReceivedViaWallet,
  listReceivedViaWallet,
  offerAcceptInstrument,
} from './receivedV1Wallet.js';
import { queryActiveContracts, submitAndWait } from './hostedWalletLedger.js';

vi.mock('./hostedWalletLedger.js', () => ({
  queryActiveContracts: vi.fn(),
  submitAndWait: vi.fn(),
}));

vi.mock('./settleV1Wallet.js', () => ({
  accountParty: (value: unknown) => {
    if (typeof value === 'string') return value;
    const owner =
      value && typeof value === 'object' ? (value as Record<string, unknown>)['owner'] : undefined;
    return typeof owner === 'string' ? owner : '';
  },
}));

const AMULET_TID = '#splice-amulet:Splice.AmuletTransferInstruction:AmuletTransferInstruction';
const OFFER_TID = '#utility-registry-app-v0:Utility.Registry.App.V0.Model.Transfer:TransferOffer';

const party = 'Recipient::1220aa';
const sender = 'Payer::1220bb';
const ccAdmin = 'DSO::1220cc';
const usdcxAdmin = 'decentralized-usdc-interchain-rep::1220dd';

const assets: SupportedAsset[] = [
  {
    key: 'cc',
    displayName: 'Canton Coin (Amulet)',
    instrumentAdmin: ccAdmin,
    instrumentId: 'Amulet',
    standard: 'CIP-56 Token Standard',
    offerTemplateId: '',
  },
  {
    key: 'usdcx',
    displayName: 'USDCx',
    instrumentAdmin: usdcxAdmin,
    instrumentId: 'USDCx',
    standard: 'CIP-56 Token Standard',
    offerTemplateId: OFFER_TID,
  },
];

function usdcxOffer(
  contractId: string,
  overrides: Record<string, unknown> = {},
): { contractId: string; templateId: string; createArguments: Record<string, unknown> } {
  return {
    contractId,
    templateId: OFFER_TID,
    createArguments: {
      operator: 'DigitalAsset-UtilityOperator::1220ee',
      provider: sender,
      transfer: {
        sender,
        receiver: party,
        amount: '0.5000000000',
        instrumentId: { admin: usdcxAdmin, id: 'USDCx' },
        requestedAt: '2026-10-16T13:39:44.47Z',
        executeBefore: '2999-10-16T14:39:49.47Z',
        inputHoldingCids: ['00696b'],
        meta: { values: {} },
        ...overrides,
      },
    },
  };
}

const ccInstruction = {
  contractId: 'cc-offer',
  templateId: AMULET_TID,
  createArguments: {
    transfer: {
      sender,
      receiver: party,
      amount: '12.0000000000',
      instrumentId: { admin: ccAdmin, id: 'Amulet' },
      requestedAt: '2026-10-16T10:00:00Z',
      executeBefore: '2000-01-01T00:00:00Z',
    },
  },
};

function mockAcs(byTemplate: Record<string, unknown>) {
  vi.mocked(queryActiveContracts).mockImplementation(async (templateIds) => {
    const v = byTemplate[templateIds[0]!];
    if (v instanceof Error) throw v;
    return (v ?? []) as Awaited<ReturnType<typeof queryActiveContracts>>;
  });
}

describe('listReceivedViaWallet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists a USDCx TransferOffer with its amount, sender and instrument', async () => {
    mockAcs({
      [AMULET_TID]: [],
      [OFFER_TID]: [
        usdcxOffer('usdcx-offer'),
        usdcxOffer('usdcx-expired', {
          sender: { owner: sender, provider: null, id: '' },
          receiver: { owner: party, provider: null, id: '' },
          executeBefore: '2000-01-01T00:00:00Z',
        }),
      ],
    });

    const view = await listReceivedViaWallet(party, assets);

    expect(queryActiveContracts).toHaveBeenCalledWith([AMULET_TID], party);
    expect(queryActiveContracts).toHaveBeenCalledWith([OFFER_TID], party);
    expect(view.pending).toEqual([
      {
        transferInstructionCid: 'usdcx-offer',
        amount: '0.5000000000',
        sender,
        instrumentId: 'USDCx',
        instrumentAdmin: usdcxAdmin,
        requestedAt: '2026-10-16T13:39:44.47Z',
        executeBefore: '2999-10-16T14:39:49.47Z',
        expired: false,
      },
      {
        transferInstructionCid: 'usdcx-expired',
        amount: '0.5000000000',
        sender,
        instrumentId: 'USDCx',
        instrumentAdmin: usdcxAdmin,
        requestedAt: '2026-10-16T13:39:44.47Z',
        executeBefore: '2000-01-01T00:00:00Z',
        expired: true,
      },
    ]);
  });

  it('drops offers to another receiver or for an unconfigured instrument', async () => {
    mockAcs({
      [OFFER_TID]: [
        usdcxOffer('other-receiver', { receiver: 'someone-else::1220ff' }),
        usdcxOffer('other-admin', { instrumentId: { admin: sender, id: 'USDCx' } }),
        usdcxOffer('other-token', { instrumentId: { admin: sender, id: 'BIT' } }),
        usdcxOffer('kept'),
      ],
    });

    const view = await listReceivedViaWallet(party, assets);

    expect(view.pending.map((o) => o.transferInstructionCid)).toEqual(['kept']);
  });

  it('keeps the Canton Coin path unchanged', async () => {
    mockAcs({
      [AMULET_TID]: [
        ccInstruction,
        {
          ...ccInstruction,
          contractId: 'cc-other',
          createArguments: { transfer: { ...ccInstruction.createArguments.transfer, receiver: 'x::1' } },
        },
      ],
    });

    const view = await listReceivedViaWallet(party);

    expect(queryActiveContracts).toHaveBeenCalledTimes(1);
    expect(queryActiveContracts).toHaveBeenCalledWith([AMULET_TID], party);
    expect(view).toEqual({
      party,
      pending: [
        {
          transferInstructionCid: 'cc-offer',
          amount: '12.0000000000',
          sender,
          instrumentId: 'Amulet',
          instrumentAdmin: ccAdmin,
          requestedAt: '2026-10-16T10:00:00Z',
          executeBefore: '2000-01-01T00:00:00Z',
          expired: true,
        },
      ],
      received: [],
    });
  });

  it('lists CC and USDCx offers together', async () => {
    mockAcs({ [AMULET_TID]: [ccInstruction], [OFFER_TID]: [usdcxOffer('usdcx-offer')] });

    const view = await listReceivedViaWallet(party, assets);

    expect(view.pending.map((o) => [o.transferInstructionCid, o.instrumentId])).toEqual([
      ['cc-offer', 'Amulet'],
      ['usdcx-offer', 'USDCx'],
    ]);
  });

  it('degrades a query the wallet cannot serve without hiding the others', async () => {
    mockAcs({
      [AMULET_TID]: [ccInstruction],
      [OFFER_TID]: new Error('PACKAGE_NAMES_NOT_FOUND: utility-registry-app-v0'),
    });

    const view = await listReceivedViaWallet(party, assets);

    expect(view.pending.map((o) => o.transferInstructionCid)).toEqual(['cc-offer']);
  });

  it('still lists USDCx when the CC query is unavailable', async () => {
    mockAcs({
      [AMULET_TID]: new Error('Failed to get active contracts'),
      [OFFER_TID]: [usdcxOffer('usdcx-offer')],
    });

    const view = await listReceivedViaWallet(party, assets);

    expect(view.pending.map((o) => o.transferInstructionCid)).toEqual(['usdcx-offer']);
  });

  it('rethrows a genuine transport failure', async () => {
    mockAcs({ [AMULET_TID]: [], [OFFER_TID]: new Error('Unauthorized') });

    await expect(listReceivedViaWallet(party, assets)).rejects.toThrow('Unauthorized');
  });
});

describe('acceptReceivedViaWallet', () => {
  const prepared = { command: { ExerciseCommand: {} }, disclosedContracts: [], actAs: party };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(submitAndWait).mockResolvedValue({ updateId: 'update-1' });
  });

  it('sends the instrument for a USDCx offer', async () => {
    const prepareAcceptReceivedV1 = vi.fn().mockResolvedValue(prepared);
    const client = { prepareAcceptReceivedV1 } as unknown as CantonStreamsApi;
    const instrument = offerAcceptInstrument(
      { instrumentId: 'USDCx', instrumentAdmin: usdcxAdmin },
      assets,
    );

    const res = await acceptReceivedViaWallet(client, party, 'usdcx-offer', instrument);

    expect(instrument).toEqual({ admin: usdcxAdmin, id: 'USDCx' });
    expect(prepareAcceptReceivedV1).toHaveBeenCalledWith('usdcx-offer', {
      admin: usdcxAdmin,
      id: 'USDCx',
    });
    expect(res.updateId).toBe('update-1');
  });

  it('omits the instrument for a CC offer', async () => {
    const prepareAcceptReceivedV1 = vi.fn().mockResolvedValue(prepared);
    const client = { prepareAcceptReceivedV1 } as unknown as CantonStreamsApi;
    const instrument = offerAcceptInstrument(
      { instrumentId: 'Amulet', instrumentAdmin: ccAdmin },
      assets,
    );

    await acceptReceivedViaWallet(client, party, 'cc-offer', instrument);

    expect(instrument).toBeUndefined();
    expect(prepareAcceptReceivedV1).toHaveBeenCalledWith('cc-offer');
    expect(prepareAcceptReceivedV1.mock.calls[0]).toHaveLength(1);
  });

  it('omits the instrument for an offer without an admin or an unconfigured asset', () => {
    expect(offerAcceptInstrument({ instrumentId: 'Amulet' }, assets)).toBeUndefined();
    expect(
      offerAcceptInstrument({ instrumentId: 'BIT', instrumentAdmin: sender }, assets),
    ).toBeUndefined();
  });
});

describe('prepareAcceptReceivedV1 request body', () => {
  it('adds instrumentId only when given', async () => {
    const { CantonStreamsApi: Api } = await import('../api/client.js');
    const prepared = { command: {}, disclosedContracts: [], actAs: party };
    const request = vi.fn().mockResolvedValue(prepared);
    const api = Object.create(Api.prototype) as CantonStreamsApi;
    (api as unknown as { request: typeof request }).request = request;

    await api.prepareAcceptReceivedV1('cc-offer');
    await api.prepareAcceptReceivedV1('usdcx-offer', { admin: usdcxAdmin, id: 'USDCx' });

    expect(request.mock.calls).toEqual([
      ['POST', '/api/v1/received/prepare-accept', { transferInstructionCid: 'cc-offer' }],
      [
        'POST',
        '/api/v1/received/prepare-accept',
        { transferInstructionCid: 'usdcx-offer', instrumentId: { admin: usdcxAdmin, id: 'USDCx' } },
      ],
    ]);
  });
});
