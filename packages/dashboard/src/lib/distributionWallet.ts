import type {
  CantonStreamsApi,
  DistributionAccount,
  DistributionRecord,
  PreparedDistributionFunding,
} from '../api/client.js';
import Decimal from 'decimal.js';
import { submitAndWait } from './hostedWalletLedger.js';
import { extractUpdateId, readPayerHoldings, walletSubmitError } from './settleV1Wallet.js';

export interface FundDistributionParams {
  readonly record: DistributionRecord;
  readonly payerParty: string;
  readonly periods: number;
  readonly settlementDeadline: Date;
  readonly holdingTemplateId?: string;
}

export interface DistributionFundingSubmission {
  readonly fundingId: string;
  readonly updateId?: string;
  readonly confirmation: 'confirmed' | 'pending';
  readonly settlementLegs: PreparedDistributionFunding['settlementLegs'];
}

export interface DistributionRecipientAuthorizationSubmission {
  readonly authorizationId: string;
  readonly updateId?: string;
  readonly confirmation: 'confirmed' | 'pending';
}

function sameAccount(left: DistributionAccount, right: DistributionAccount): boolean {
  return (
    left.owner === right.owner &&
    (left.provider ?? undefined) === (right.provider ?? undefined) &&
    left.id === right.id
  );
}

async function stableCommandId(prefix: string, value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  const suffix = Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${prefix}-${suffix}`;
}

export async function fundDistributionWithWallet(
  client: CantonStreamsApi,
  params: FundDistributionParams,
): Promise<DistributionFundingSubmission> {
  if (params.record.payerAccount.owner !== params.payerParty) {
    throw new Error('Only the distribution payer can fund this stream.');
  }
  if (!Number.isSafeInteger(params.periods) || params.periods < 1) {
    throw new Error('Funding runway must be at least one whole period.');
  }
  const periodAmount = new Decimal(params.record.grossAmountPerPeriod);
  const prefundedAmount = periodAmount.times(params.periods);
  const holdings = await readPayerHoldings(params.payerParty, {
    instrumentId: params.record.instrumentId.id,
    instrumentAdmin: params.record.instrumentId.admin,
    holdingTemplateId: params.holdingTemplateId,
  });
  const prepared = await client.prepareDistributionFunding(params.record.contractId, {
    grossAmount: periodAmount.toFixed(10),
    settlementDeadline: params.settlementDeadline.toISOString(),
    inputHoldingCids: holdings.map((holding) => holding.cid),
    nextIterationFunding: { [params.record.instrumentId.id]: prefundedAmount.toFixed(10) },
  });
  const response = await submitAndWait([prepared.command], params.payerParty, {
    disclosedContracts: prepared.disclosedContracts,
    commandId: await stableCommandId(
      'distribution-funding',
      `${params.record.contractId}|${prepared.fundingId}`,
    ),
  });
  const submitError = walletSubmitError(response);
  if (submitError) {
    throw new Error(`Wallet rejected distribution funding: ${submitError}`);
  }
  const updateId = extractUpdateId(response);
  return {
    fundingId: prepared.fundingId,
    updateId,
    confirmation: updateId ? 'confirmed' : 'pending',
    settlementLegs: prepared.settlementLegs,
  };
}

export async function authorizeDistributionReceiptWithWallet(
  client: CantonStreamsApi,
  params: {
    readonly record: DistributionRecord;
    readonly receiverParty: string;
    readonly receiverAccount: DistributionAccount;
  },
): Promise<DistributionRecipientAuthorizationSubmission> {
  if (params.receiverAccount.owner !== params.receiverParty) {
    throw new Error('Only the configured receiver can authorize this destination.');
  }
  if (!params.record.legs.some((leg) => sameAccount(leg.receiver, params.receiverAccount))) {
    throw new Error('The selected receiver account is not part of this distribution.');
  }
  const prepared = await client.prepareDistributionRecipientAuthorization(
    params.record.contractId,
    { receiverAccount: params.receiverAccount },
  );
  const response = await submitAndWait([prepared.command], params.receiverParty, {
    disclosedContracts: prepared.disclosedContracts,
    commandId: await stableCommandId(
      'distribution-recipient',
      `${params.record.contractId}|${prepared.authorizationId}`,
    ),
  });
  const submitError = walletSubmitError(response);
  if (submitError) {
    throw new Error(`Wallet rejected recipient authorization: ${submitError}`);
  }
  const updateId = extractUpdateId(response);
  return {
    authorizationId: prepared.authorizationId,
    updateId,
    confirmation: updateId ? 'confirmed' : 'pending',
  };
}
