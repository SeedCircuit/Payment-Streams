import { describe, expect, it } from 'vitest';
import { accountParty, extractTransferProof } from './settleV1Wallet.js';

const payer = 'Payer::1220aa';
const recipient = 'Recipient::1220bb';
const admin = 'decentralized-usdc-interchain-rep::1220cc';

function offerUpdate(transfer: Record<string, unknown>) {
  return {
    transaction: {
      events: [
        {
          CreatedEvent: {
            templateId: 'pkg:Utility.Registry.App.V0.Model.Transfer:TransferOffer',
            interfaceViews: [{ viewValue: { transfer } }],
          },
        },
      ],
    },
  };
}

const opts = { payerParty: payer, recipientParty: recipient, instrumentId: 'USDCx', instrumentAdmin: admin };

describe('extractTransferProof', () => {
  it('reads a V2 offer whose parties are accounts', () => {
    const proof = extractTransferProof(
      offerUpdate({
        sender: { owner: payer, provider: null, id: '' },
        receiver: { owner: recipient, provider: null, id: '' },
        amount: '1.0000000000',
        instrumentId: { admin, id: 'USDCx' },
      }),
      opts,
    );
    expect(proof).toEqual({
      sender: payer,
      receiver: recipient,
      amount: '1.0000000000',
      instrumentId: 'USDCx',
      instrumentAdmin: admin,
      delivered: false,
    });
  });

  it('still reads a V1 offer whose parties are plain strings', () => {
    const proof = extractTransferProof(
      offerUpdate({
        sender: payer,
        receiver: recipient,
        amount: '2.0000000000',
        instrumentId: { admin, id: 'USDCx' },
      }),
      opts,
    );
    expect(proof?.receiver).toBe(recipient);
    expect(proof?.sender).toBe(payer);
  });

  it('rejects a V2 offer to someone else', () => {
    const proof = extractTransferProof(
      offerUpdate({
        sender: { owner: payer, provider: null, id: '' },
        receiver: { owner: 'Other::1220dd', provider: null, id: '' },
        amount: '1.0000000000',
        instrumentId: { admin, id: 'USDCx' },
      }),
      opts,
    );
    expect(proof).toBeUndefined();
  });
});

describe('accountParty', () => {
  it('handles both party shapes', () => {
    expect(accountParty(recipient)).toBe(recipient);
    expect(accountParty({ owner: recipient, provider: null, id: '' })).toBe(recipient);
    expect(accountParty({ id: '' })).toBe('');
    expect(accountParty(null)).toBe('');
  });
});
