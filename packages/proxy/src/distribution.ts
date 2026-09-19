import Decimal from 'decimal.js';
import {
  buildDistributionAllocationFactoryPlan,
  buildDistributionRecipientAllocationFactoryPlan,
  buildDistributionSettlementFactoryPlan,
  calculateDistributionAmounts,
  fetchAllocationFactory,
  fetchSettlementFactory,
  validateDistribution,
  type AccountV2,
  type AllocationSettlementInfo,
  type DisclosedContract,
  type DistributionFundingMode,
  type DistributionLeg,
  type DistributionRecipientAuthorization,
  type InstrumentIdV2,
  type NextIterationFunding,
} from '@canton-streams/sdk';

import { createCommand, dec, exerciseCommand, submitViaJson, updateIdOf } from './v2-write.js';
import { listActiveContractsViaJson } from './v2-read.js';

export const DISTRIBUTION_STREAM_TID =
  '#canton-streams:CantonStreams.Stream.DistributionStream:DistributionStreamRecord';

export interface CreateDistributionInput {
  readonly streamId: string;
  readonly operator: string;
  readonly payerAccount: AccountV2 & { readonly owner: string };
  readonly instrumentId: InstrumentIdV2;
  readonly grossAmountPerPeriod: Decimal.Value;
  readonly periodSeconds: number;
  readonly startTime: Date;
  readonly endTime?: Date | undefined;
  readonly legs: ReadonlyArray<DistributionLeg>;
  readonly fundingMode?: DistributionFundingMode | undefined;
  readonly observers?: ReadonlyArray<string> | undefined;
}

export interface PrepareDistributionFundingInput {
  readonly sender: string;
  readonly payerAccount: AccountV2 & { readonly owner: string };
  readonly instrumentId: InstrumentIdV2;
  readonly grossAmount: Decimal.Value;
  readonly grossAmountPerPeriod: Decimal.Value;
  readonly legs: ReadonlyArray<DistributionLeg>;
  readonly settlement: AllocationSettlementInfo;
  readonly settlementDeadline: Date;
  readonly requestedAt: Date;
  readonly inputHoldingCids: ReadonlyArray<string>;
  readonly nextIterationFunding?: NextIterationFunding['amounts'] | undefined;
  readonly registryApiUrl: string;
  readonly allocationFactoryInterfaceId: string;
  readonly registryToken?: string | undefined;
  readonly meta?: Readonly<Record<string, string>> | undefined;
}

export interface PreparedDistributionFunding {
  readonly factoryId: string;
  readonly command: Record<string, unknown>;
  readonly disclosedContracts: ReadonlyArray<DisclosedContract>;
  readonly settlementLegs: ReadonlyArray<{ readonly legId: string; readonly amount: string }>;
  readonly committedAmount: string;
}

export interface PrepareDistributionRecipientAuthorizationInput {
  readonly receiverAccount: AccountV2 & { readonly owner: string };
  readonly payerAccount: AccountV2 & { readonly owner: string };
  readonly instrumentId: InstrumentIdV2;
  readonly grossAmount: Decimal.Value;
  readonly grossAmountPerPeriod: Decimal.Value;
  readonly legs: ReadonlyArray<DistributionLeg>;
  readonly settlement: AllocationSettlementInfo;
  readonly settlementDeadline: Date;
  readonly requestedAt: Date;
  readonly registryApiUrl: string;
  readonly allocationFactoryInterfaceId: string;
  readonly registryToken?: string | undefined;
  readonly meta?: Readonly<Record<string, string>> | undefined;
}

export interface PreparedDistributionRecipientAuthorization {
  readonly factoryId: string;
  readonly command: Record<string, unknown>;
  readonly disclosedContracts: ReadonlyArray<DisclosedContract>;
  readonly settlementLegs: ReadonlyArray<{ readonly legId: string; readonly amount: string }>;
}

export interface PrepareDistributionSettlementInput {
  readonly payerAccount: AccountV2 & { readonly owner: string };
  readonly instrumentId: InstrumentIdV2;
  readonly grossAmount: Decimal.Value;
  readonly grossAmountPerPeriod: Decimal.Value;
  readonly legs: ReadonlyArray<DistributionLeg>;
  readonly settlement: AllocationSettlementInfo;
  readonly allocationCid: string;
  readonly recipientAuthorizations: ReadonlyArray<DistributionRecipientAuthorization>;
  readonly nextIterationFunding?: NextIterationFunding['amounts'] | undefined;
  readonly registryApiUrl: string;
  readonly settlementFactoryInterfaceId: string;
  readonly registryToken?: string | undefined;
  readonly meta?: Readonly<Record<string, string>> | undefined;
}

export interface PreparedDistributionSettlement {
  readonly factoryId: string;
  readonly command: Record<string, unknown>;
  readonly disclosedContracts: ReadonlyArray<DisclosedContract>;
  readonly settlementLegs: ReadonlyArray<{ readonly legId: string; readonly amount: string }>;
}

export interface DistributionRecordView extends Record<string, unknown> {
  readonly contractId: string;
  readonly streamId: string;
  readonly operator: string;
  readonly payerAccount: AccountV2 & { readonly owner: string };
  readonly instrumentId: InstrumentIdV2;
  readonly grossAmountPerPeriod: string;
  readonly periodSeconds: number;
  readonly startTime: string;
  readonly endTime?: string | undefined;
  readonly legs: ReadonlyArray<DistributionLeg>;
  readonly fundingMode: DistributionFundingMode;
  readonly totalFunded: string;
  readonly totalGrossSettled: string;
  readonly fundingCount: number;
  readonly settlementCount: number;
  readonly currentAllocationCid?: string | undefined;
  readonly originalAllocationId?: string | undefined;
  readonly lastFundingId?: string | undefined;
  readonly lastSettlementId?: string | undefined;
  readonly fundingIds: ReadonlyArray<string>;
  readonly settlementIds: ReadonlyArray<string>;
  readonly recipientAuthorizations: ReadonlyArray<DistributionRecipientAuthorization>;
  readonly recipientAuthorizationIds: ReadonlyArray<string>;
  readonly currentSettlementDeadline?: string | undefined;
  readonly status: string;
}

export function calculateDistributionAccruedGross(
  record: Pick<
    DistributionRecordView,
    'startTime' | 'endTime' | 'periodSeconds' | 'grossAmountPerPeriod'
  >,
  at: Date,
): Decimal {
  const start = new Date(record.startTime).getTime();
  const configuredEnd = record.endTime ? new Date(record.endTime).getTime() : at.getTime();
  const effectiveAt = Math.min(at.getTime(), configuredEnd);
  const elapsedPeriods = Math.max(
    0,
    Math.floor((effectiveAt - start) / (record.periodSeconds * 1000)),
  );
  return new Decimal(record.grossAmountPerPeriod).times(elapsedPeriods);
}

function accountToJson(account: AccountV2 & { readonly owner: string }): Record<string, unknown> {
  return { owner: account.owner, provider: account.provider ?? null, id: account.id };
}

function ruleToJson(rule: DistributionLeg['rule']): Record<string, unknown> {
  return rule.type === 'percentage'
    ? { tag: 'PercentageBps', value: { basisPoints: String(rule.basisPoints) } }
    : { tag: 'FixedAmountPerPeriod', value: { amount: dec(rule.amountPerPeriod) } };
}

export function buildDistributionCreateArguments(
  input: CreateDistributionInput,
): Record<string, unknown> {
  validateDistribution(input.grossAmountPerPeriod, input.legs);
  if (!Number.isSafeInteger(input.periodSeconds) || input.periodSeconds <= 0) {
    throw new Error('periodSeconds must be a positive safe integer');
  }
  if (input.endTime && input.endTime <= input.startTime) {
    throw new Error('endTime must be after startTime');
  }
  return {
    streamId: input.streamId,
    operator: input.operator,
    payerAccount: accountToJson(input.payerAccount),
    instrumentId: input.instrumentId,
    grossAmountPerPeriod: dec(input.grossAmountPerPeriod),
    periodSeconds: String(input.periodSeconds),
    startTime: input.startTime.toISOString(),
    endTime: input.endTime?.toISOString() ?? null,
    legs: input.legs.map((leg) => ({
      legId: leg.legId,
      receiver: accountToJson(leg.receiver as AccountV2 & { readonly owner: string }),
      rule: ruleToJson(leg.rule),
    })),
    fundingMode: input.fundingMode ?? 'EscrowFunding',
    totalFunded: dec(0),
    totalGrossSettled: dec(0),
    fundingCount: '0',
    settlementCount: '0',
    currentAllocationCid: null,
    originalAllocationId: null,
    lastFundingId: null,
    lastSettlementId: null,
    fundingIds: [],
    settlementIds: [],
    recipientAuthorizations: [],
    recipientAuthorizationIds: [],
    currentSettlementDeadline: null,
    status: 'AwaitingFunding',
    observers: [...(input.observers ?? [])],
  };
}

export async function createDistributionViaJson(
  input: CreateDistributionInput,
): Promise<{ updateId: string }> {
  const response = await submitViaJson(
    'distribution-create',
    [input.operator],
    [createCommand(DISTRIBUTION_STREAM_TID, buildDistributionCreateArguments(input))],
  );
  const updateId = updateIdOf(response);
  if (!updateId)
    throw new Error('Distribution create submitted but the ledger returned no updateId');
  return { updateId };
}

function decodeRule(rule: any): DistributionLeg['rule'] {
  const tag = rule?.tag ?? rule?.variant_constructor;
  const value = rule?.value ?? {};
  if (tag === 'FixedAmountPerPeriod') {
    return { type: 'fixed', amountPerPeriod: String(value.amount ?? '0') };
  }
  return { type: 'percentage', basisPoints: Number(value.basisPoints ?? 0) };
}

export function decodeDistributionRecord(
  createArgument: any,
  contractId: string,
): DistributionRecordView {
  return {
    contractId,
    streamId: createArgument?.streamId ?? '',
    operator: createArgument?.operator ?? '',
    payerAccount: createArgument?.payerAccount ?? { owner: '', provider: null, id: '' },
    instrumentId: createArgument?.instrumentId ?? { admin: '', id: '' },
    grossAmountPerPeriod: String(createArgument?.grossAmountPerPeriod ?? '0'),
    periodSeconds: Number(createArgument?.periodSeconds ?? 0),
    startTime: createArgument?.startTime,
    endTime: createArgument?.endTime ?? undefined,
    legs: Array.isArray(createArgument?.legs)
      ? createArgument.legs.map((leg: any) => ({
          legId: leg?.legId ?? '',
          receiver: leg?.receiver ?? { owner: '', provider: null, id: '' },
          rule: decodeRule(leg?.rule),
        }))
      : [],
    fundingMode: createArgument?.fundingMode ?? 'EscrowFunding',
    totalFunded: String(createArgument?.totalFunded ?? '0'),
    totalGrossSettled: String(createArgument?.totalGrossSettled ?? '0'),
    fundingCount: Number(createArgument?.fundingCount ?? 0),
    settlementCount: Number(createArgument?.settlementCount ?? 0),
    currentAllocationCid: createArgument?.currentAllocationCid ?? undefined,
    originalAllocationId: createArgument?.originalAllocationId ?? undefined,
    lastFundingId: createArgument?.lastFundingId ?? undefined,
    lastSettlementId: createArgument?.lastSettlementId ?? undefined,
    fundingIds: Array.isArray(createArgument?.fundingIds) ? createArgument.fundingIds : [],
    settlementIds: Array.isArray(createArgument?.settlementIds) ? createArgument.settlementIds : [],
    recipientAuthorizations: Array.isArray(createArgument?.recipientAuthorizations)
      ? createArgument.recipientAuthorizations.map((authorization: any) => ({
          receiver: authorization?.receiver ?? { owner: '', provider: null, id: '' },
          authorizationId: String(authorization?.authorizationId ?? ''),
          allocationCid: String(authorization?.allocationCid ?? ''),
        }))
      : [],
    recipientAuthorizationIds: Array.isArray(createArgument?.recipientAuthorizationIds)
      ? createArgument.recipientAuthorizationIds
      : [],
    currentSettlementDeadline: createArgument?.currentSettlementDeadline ?? undefined,
    status: createArgument?.status ?? 'AwaitingFunding',
  };
}

export function listDistributionsViaJson(operator: string): Promise<DistributionRecordView[]> {
  return listActiveContractsViaJson(
    operator,
    DISTRIBUTION_STREAM_TID,
    decodeDistributionRecord,
  ) as Promise<DistributionRecordView[]>;
}

export async function prepareDistributionFunding(
  input: PrepareDistributionFundingInput,
): Promise<PreparedDistributionFunding> {
  const basePlan = buildDistributionAllocationFactoryPlan({
    sender: input.sender,
    payerAccount: input.payerAccount,
    instrumentId: input.instrumentId,
    grossAmount: input.grossAmount,
    grossAmountPerPeriod: input.grossAmountPerPeriod,
    legs: input.legs,
    settlement: input.settlement,
    settlementDeadline: input.settlementDeadline,
    requestedAt: input.requestedAt,
    inputHoldingCids: input.inputHoldingCids,
    nextIterationFunding: input.nextIterationFunding,
    meta: input.meta,
  });
  const factory = await fetchAllocationFactory(
    input.registryApiUrl,
    { version: 'v2', choiceArguments: basePlan.choiceArguments },
    input.registryToken ? { token: input.registryToken } : undefined,
  );
  const finalPlan = buildDistributionAllocationFactoryPlan({
    sender: input.sender,
    payerAccount: input.payerAccount,
    instrumentId: input.instrumentId,
    grossAmount: input.grossAmount,
    grossAmountPerPeriod: input.grossAmountPerPeriod,
    legs: input.legs,
    settlement: input.settlement,
    settlementDeadline: input.settlementDeadline,
    requestedAt: input.requestedAt,
    inputHoldingCids: input.inputHoldingCids,
    nextIterationFunding: input.nextIterationFunding,
    choiceContextValues: factory.choiceContext.values,
    meta: input.meta,
  });
  const reservedAmount = Object.values(input.nextIterationFunding ?? {}).reduce<Decimal>(
    (sum, amount) => sum.plus(amount),
    new Decimal(0),
  );
  return {
    factoryId: factory.factoryId,
    command: {
      ExerciseCommand: {
        templateId: input.allocationFactoryInterfaceId,
        contractId: factory.factoryId,
        choice: 'AllocationFactory_Allocate',
        choiceArgument: finalPlan.choiceArguments,
      },
    },
    disclosedContracts: factory.choiceContext.disclosedContracts ?? [],
    settlementLegs: finalPlan.settlementLegs.map((leg) => ({
      legId: leg.legId,
      amount: leg.amount.toFixed(10),
    })),
    committedAmount: new Decimal(input.grossAmount).plus(reservedAmount).toFixed(10),
  };
}

export async function prepareDistributionRecipientAuthorization(
  input: PrepareDistributionRecipientAuthorizationInput,
): Promise<PreparedDistributionRecipientAuthorization> {
  const buildPlan = (choiceContextValues?: Readonly<Record<string, unknown>>) =>
    buildDistributionRecipientAllocationFactoryPlan({
      receiverAccount: input.receiverAccount,
      payerAccount: input.payerAccount,
      instrumentId: input.instrumentId,
      grossAmount: input.grossAmount,
      grossAmountPerPeriod: input.grossAmountPerPeriod,
      legs: input.legs,
      settlement: input.settlement,
      settlementDeadline: input.settlementDeadline,
      requestedAt: input.requestedAt,
      choiceContextValues,
      meta: input.meta,
    });
  const basePlan = buildPlan();
  const factory = await fetchAllocationFactory(
    input.registryApiUrl,
    { version: 'v2', choiceArguments: basePlan.choiceArguments },
    input.registryToken ? { token: input.registryToken } : undefined,
  );
  const finalPlan = buildPlan(factory.choiceContext.values);
  return {
    factoryId: factory.factoryId,
    command: {
      ExerciseCommand: {
        templateId: input.allocationFactoryInterfaceId,
        contractId: factory.factoryId,
        choice: 'AllocationFactory_Allocate',
        choiceArgument: finalPlan.choiceArguments,
      },
    },
    disclosedContracts: factory.choiceContext.disclosedContracts ?? [],
    settlementLegs: finalPlan.settlementLegs.map((leg) => ({
      legId: leg.legId,
      amount: leg.amount.toFixed(10),
    })),
  };
}

export async function prepareDistributionSettlement(
  input: PrepareDistributionSettlementInput,
): Promise<PreparedDistributionSettlement> {
  const basePlan = buildDistributionSettlementFactoryPlan({
    payerAccount: input.payerAccount,
    instrumentId: input.instrumentId,
    grossAmount: input.grossAmount,
    grossAmountPerPeriod: input.grossAmountPerPeriod,
    legs: input.legs,
    settlement: input.settlement,
    allocationCid: input.allocationCid,
    recipientAuthorizations: input.recipientAuthorizations,
    nextIterationFunding: input.nextIterationFunding,
    meta: input.meta,
  });
  const factory = await fetchSettlementFactory(
    input.registryApiUrl,
    { choiceArguments: basePlan.choiceArguments },
    input.registryToken ? { token: input.registryToken } : undefined,
  );
  const finalPlan = buildDistributionSettlementFactoryPlan({
    payerAccount: input.payerAccount,
    instrumentId: input.instrumentId,
    grossAmount: input.grossAmount,
    grossAmountPerPeriod: input.grossAmountPerPeriod,
    legs: input.legs,
    settlement: input.settlement,
    allocationCid: input.allocationCid,
    recipientAuthorizations: input.recipientAuthorizations,
    nextIterationFunding: input.nextIterationFunding,
    choiceContextValues: factory.choiceContext.values,
    meta: input.meta,
  });
  return {
    factoryId: factory.factoryId,
    command: {
      ExerciseCommand: {
        templateId: input.settlementFactoryInterfaceId,
        contractId: factory.factoryId,
        choice: 'SettlementFactory_SettleBatch',
        choiceArgument: finalPlan.choiceArguments,
      },
    },
    disclosedContracts: factory.choiceContext.disclosedContracts ?? [],
    settlementLegs: finalPlan.settlementLegs.map((leg) => ({
      legId: leg.legId,
      amount: leg.amount.toFixed(10),
    })),
  };
}

async function submitChoice(
  tag: string,
  operator: string,
  contractId: string,
  choice: string,
  argument: Record<string, unknown>,
): Promise<{ updateId: string }> {
  const response = await submitViaJson(
    tag,
    [operator],
    [exerciseCommand(DISTRIBUTION_STREAM_TID, contractId, choice, argument)],
  );
  const updateId = updateIdOf(response);
  if (!updateId) throw new Error(`${choice} submitted but the ledger returned no updateId`);
  return { updateId };
}

export function recordDistributionFundingViaJson(input: {
  readonly operator: string;
  readonly contractId: string;
  readonly amount: Decimal.Value;
  readonly fundingId: string;
  readonly allocationCid: string;
  readonly originalAllocationCid?: string | undefined;
  readonly settlementDeadline: Date;
  readonly expectedSequence: number;
}): Promise<{ updateId: string }> {
  return submitChoice(
    'distribution-funding',
    input.operator,
    input.contractId,
    'RecordDistributionFunding',
    {
      amount: dec(input.amount),
      fundingId: input.fundingId,
      allocationCid: input.allocationCid,
      originalAllocationCid: input.originalAllocationCid ?? null,
      settlementDeadline: input.settlementDeadline.toISOString(),
      expectedSequence: String(input.expectedSequence),
    },
  );
}

export function recordDistributionRecipientAuthorizationViaJson(input: {
  readonly operator: string;
  readonly contractId: string;
  readonly receiver: AccountV2 & { readonly owner: string };
  readonly authorizationId: string;
  readonly allocationCid: string;
  readonly expectedCount: number;
}): Promise<{ updateId: string }> {
  return submitChoice(
    'distribution-recipient-authorization',
    input.operator,
    input.contractId,
    'RecordDistributionRecipientAuthorization',
    {
      receiver: accountToJson(input.receiver),
      authorizationId: input.authorizationId,
      allocationCid: input.allocationCid,
      expectedCount: String(input.expectedCount),
    },
  );
}

export function activateDistributionViaJson(
  operator: string,
  contractId: string,
): Promise<{ updateId: string }> {
  return submitChoice('distribution-activate', operator, contractId, 'ActivateDistribution', {});
}

export function recordDistributionSettlementViaJson(input: {
  readonly operator: string;
  readonly contractId: string;
  readonly grossAmount: Decimal.Value;
  readonly grossAmountPerPeriod: Decimal.Value;
  readonly legs: ReadonlyArray<DistributionLeg>;
  readonly settlementId: string;
  readonly settledAt: Date;
  readonly newAllocationCid?: string | undefined;
  readonly newRecipientAuthorizations: ReadonlyArray<DistributionRecipientAuthorization>;
  readonly expectedSequence: number;
}): Promise<{ updateId: string }> {
  const settledLegs = calculateDistributionAmounts(
    input.grossAmount,
    input.grossAmountPerPeriod,
    input.legs,
  );
  return submitChoice(
    'distribution-settlement',
    input.operator,
    input.contractId,
    'RecordDistributionSettlement',
    {
      grossAmount: dec(input.grossAmount),
      settledLegs: settledLegs.map((leg) => ({ legId: leg.legId, amount: leg.amount.toFixed(10) })),
      settlementId: input.settlementId,
      settledAt: input.settledAt.toISOString(),
      newAllocationCid: input.newAllocationCid ?? null,
      newRecipientAuthorizations: input.newRecipientAuthorizations.map((authorization) => ({
        receiver: accountToJson(authorization.receiver),
        authorizationId: authorization.authorizationId,
        allocationCid: authorization.allocationCid,
      })),
      expectedSequence: String(input.expectedSequence),
    },
  );
}

export function changeDistributionStateViaJson(
  operator: string,
  contractId: string,
  action: 'pause' | 'resume' | 'complete' | 'cancel',
  releasedAllocationCid?: string,
): Promise<{ updateId: string }> {
  const choices = {
    pause: 'PauseDistribution',
    resume: 'ResumeDistribution',
    complete: 'CompleteDistribution',
    cancel: 'CancelDistribution',
  } as const;
  return submitChoice(
    `distribution-${action}`,
    operator,
    contractId,
    choices[action],
    action === 'cancel' ? { releasedAllocationCid: releasedAllocationCid ?? null } : {},
  );
}
