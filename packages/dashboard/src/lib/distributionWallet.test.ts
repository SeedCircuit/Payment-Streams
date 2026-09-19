import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CantonStreamsApi,
  DistributionAccount,
  DistributionRecord,
} from '../api/client.js';
import {
  authorizeDistributionReceiptWithWallet,
  fundDistributionWithWallet,
} from './distributionWallet.js';
import { submitAndWait } from './hostedWalletLedger.js';
import { extractUpdateId, readPayerHoldings, walletSubmitError } from './settleV1Wallet.js';

vi.mock('./hostedWalletLedger.js', () => ({
  submitAndWait: vi.fn(),
}));

vi.mock('./settleV1Wallet.js', () => ({
  extractUpdateId: vi.fn(),
  readPayerHoldings: vi.fn(),
  walletSubmitError: vi.fn(),
}));

const payer = 'Payer::abcdef12';
const supplier = 'Supplier::abcdef12';
const supplierAccount: DistributionAccount = { owner: supplier, id: '' };

const record = {
  contractId: 'distribution-cid',
  streamId: 'distribution-1',
  operator: 'Operator::abcdef12',
  payerAccount: { owner: payer, id: '' },
  instrumentId: { admin: 'CoinAdmin::abcdef12', id: 'Amulet' },
  grossAmountPerPeriod: '100.0000000000',
  periodSeconds: 86_400,
  startTime: '2026-09-20T00:00:00Z',
  legs: [
    {
      legId: 'supplier',
      receiver: supplierAccount,
      rule: { type: 'percentage', basisPoints: 10_000 },
    },
  ],
  fundingMode: 'EscrowFunding',
  totalFunded: '0.0000000000',
  totalGrossSettled: '0.0000000000',
  fundingCount: 0,
  settlementCount: 0,
  fundingIds: [],
  settlementIds: [],
  recipientAuthorizations: [],
  recipientAuthorizationIds: [],
  status: 'AwaitingFunding',
} satisfies DistributionRecord;

describe('distribution wallet orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(walletSubmitError).mockReturnValue(undefined);
    vi.mocked(extractUpdateId).mockReturnValue('abcdef1234567890');
    vi.mocked(submitAndWait).mockResolvedValue({ updateId: 'abcdef1234567890' });
  });

  it('rejects funding by a party other than the configured payer', async () => {
    const client = {} as CantonStreamsApi;

    await expect(
      fundDistributionWithWallet(client, {
        record,
        payerParty: supplier,
        periods: 1,
        settlementDeadline: new Date('2026-10-20T00:00:00Z'),
      }),
    ).rejects.toThrow('Only the distribution payer');
    expect(readPayerHoldings).not.toHaveBeenCalled();
  });

  it('funds one active period and reserves the remaining runway', async () => {
    vi.mocked(readPayerHoldings).mockResolvedValue([{ cid: 'holding-cid', amount: 500 }]);
    const prepareDistributionFunding = vi.fn().mockResolvedValue({
      command: { ExerciseCommand: { choice: 'AllocationFactory_Allocate' } },
      disclosedContracts: [{ contractId: 'rules-cid' }],
      fundingId: 'distribution-1:funding:1',
      settlementLegs: [{ legId: 'supplier', amount: '100.0000000000' }],
    });
    const client = { prepareDistributionFunding } as unknown as CantonStreamsApi;

    const params = {
      record,
      payerParty: payer,
      periods: 3,
      settlementDeadline: new Date('2026-10-20T00:00:00Z'),
    };
    const result = await fundDistributionWithWallet(client, params);

    expect(prepareDistributionFunding).toHaveBeenCalledWith('distribution-cid', {
      grossAmount: '100.0000000000',
      settlementDeadline: '2026-10-20T00:00:00.000Z',
      inputHoldingCids: ['holding-cid'],
      nextIterationFunding: { Amulet: '200.0000000000' },
    });
    expect(submitAndWait).toHaveBeenCalledWith(
      [{ ExerciseCommand: { choice: 'AllocationFactory_Allocate' } }],
      payer,
      expect.objectContaining({ disclosedContracts: [{ contractId: 'rules-cid' }] }),
    );
    expect(result).toMatchObject({
      fundingId: 'distribution-1:funding:1',
      updateId: 'abcdef1234567890',
      confirmation: 'confirmed',
    });

    await fundDistributionWithWallet(client, params);
    expect(vi.mocked(submitAndWait).mock.calls[1]![2]?.commandId).toBe(
      vi.mocked(submitAndWait).mock.calls[0]![2]?.commandId,
    );
  });

  it('rejects receipt authorization by a different party', async () => {
    const client = {} as CantonStreamsApi;

    await expect(
      authorizeDistributionReceiptWithWallet(client, {
        record,
        receiverParty: payer,
        receiverAccount: supplierAccount,
      }),
    ).rejects.toThrow('Only the configured receiver');
  });

  it('submits the prepared receiver-side allocation through the receiver wallet', async () => {
    const prepareDistributionRecipientAuthorization = vi.fn().mockResolvedValue({
      command: { ExerciseCommand: { choice: 'AllocationFactory_Allocate' } },
      disclosedContracts: [{ contractId: 'rules-cid' }],
      authorizationId: 'distribution-1:funding:1:receiver:1',
      receiverAccount: supplierAccount,
      settlementLegs: [{ legId: 'supplier', amount: '100.0000000000' }],
    });
    const client = {
      prepareDistributionRecipientAuthorization,
    } as unknown as CantonStreamsApi;

    const result = await authorizeDistributionReceiptWithWallet(client, {
      record,
      receiverParty: supplier,
      receiverAccount: supplierAccount,
    });

    expect(prepareDistributionRecipientAuthorization).toHaveBeenCalledWith('distribution-cid', {
      receiverAccount: supplierAccount,
    });
    expect(submitAndWait).toHaveBeenCalledWith(
      [{ ExerciseCommand: { choice: 'AllocationFactory_Allocate' } }],
      supplier,
      expect.objectContaining({ disclosedContracts: [{ contractId: 'rules-cid' }] }),
    );
    expect(result).toEqual({
      authorizationId: 'distribution-1:funding:1:receiver:1',
      updateId: 'abcdef1234567890',
      confirmation: 'confirmed',
    });
  });
});
