import Decimal from 'decimal.js';
import type { Logger } from 'pino';

import type { AssetCapabilities } from '../assets/capabilities.js';
import {
  buildAllocationRequest,
  buildAllocationFactoryAllocateJson,
  buildSettlementFactorySettleBatchJson,
  type AccountV2,
  type AllocationFactoryAllocateParams,
  type AllocationRequestPayload,
  type AllocationSettlementInfo,
  type InstrumentIdV2,
  type NextIterationFundingAmounts,
  type TransferLegSideV2,
} from './allocation.js';
import {
  CHOICE_ACTIVATE_DISTRIBUTION,
  CHOICE_CANCEL_DISTRIBUTION,
  CHOICE_COMPLETE_DISTRIBUTION,
  CHOICE_PAUSE_DISTRIBUTION,
  CHOICE_RECORD_DISTRIBUTION_FUNDING,
  CHOICE_RECORD_DISTRIBUTION_RECIPIENT_AUTHORIZATION,
  CHOICE_RECORD_DISTRIBUTION_SETTLEMENT,
  CHOICE_RESUME_DISTRIBUTION,
  TEMPLATE_DISTRIBUTION_STREAM,
} from '../templates.js';
import type { TemplateId, Transport } from '../transport/base.js';

export type DistributionRule =
  | { readonly type: 'percentage'; readonly basisPoints: number }
  | { readonly type: 'fixed'; readonly amountPerPeriod: Decimal.Value };

export interface DistributionLeg {
  readonly legId: string;
  readonly receiver: AccountV2;
  readonly rule: DistributionRule;
  readonly meta?: Readonly<Record<string, string>> | undefined;
}

export interface DistributionSettlementLeg {
  readonly legId: string;
  readonly amount: Decimal;
}

export interface DistributionRecipientAuthorization {
  readonly receiver: AccountV2 & { readonly owner: string };
  readonly authorizationId: string;
  readonly allocationCid: string;
}

export type DistributionFundingMode = 'MandateFunding' | 'PerCycleFunding' | 'EscrowFunding';

export type DistributionStatus =
  | 'AwaitingFunding'
  | 'AwaitingRecipients'
  | 'DistributionActive'
  | 'DistributionPaused'
  | 'DistributionCompleted'
  | 'DistributionCancelled';

export interface CreateDistributionParams {
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

export interface DistributionCreatePayload {
  readonly templateId: TemplateId;
  readonly argument: Record<string, unknown>;
  readonly signatories: ReadonlyArray<string>;
}

export interface BuildDistributionAllocationRequestParams {
  readonly sender: string;
  readonly payerAccount: AccountV2 & { readonly owner: string };
  readonly instrumentId: InstrumentIdV2;
  readonly grossAmount: Decimal.Value;
  readonly grossAmountPerPeriod: Decimal.Value;
  readonly legs: ReadonlyArray<DistributionLeg>;
  readonly settlement: AllocationSettlementInfo;
  readonly committed?: boolean | undefined;
  readonly nextIterationFunding?: NextIterationFundingAmounts | undefined;
  readonly originalRequestCid?: string | undefined;
  readonly meta?: Readonly<Record<string, string>> | undefined;
}

export interface DistributionAllocationRequest {
  readonly request: AllocationRequestPayload;
  readonly settlementLegs: ReadonlyArray<DistributionSettlementLeg>;
}

export interface BuildDistributionAllocationFactoryParams {
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
  readonly actors?: ReadonlyArray<string> | undefined;
  readonly committed?: boolean | undefined;
  readonly nextIterationFunding?: NextIterationFundingAmounts | undefined;
  readonly choiceContextValues?: Readonly<Record<string, unknown>> | undefined;
  readonly meta?: Readonly<Record<string, string>> | undefined;
}

export interface DistributionAllocationFactoryPlan {
  readonly choiceArguments: Record<string, unknown>;
  readonly settlementLegs: ReadonlyArray<DistributionSettlementLeg>;
}

export interface BuildDistributionRecipientAllocationFactoryParams {
  readonly receiverAccount: AccountV2 & { readonly owner: string };
  readonly payerAccount: AccountV2 & { readonly owner: string };
  readonly instrumentId: InstrumentIdV2;
  readonly grossAmount: Decimal.Value;
  readonly grossAmountPerPeriod: Decimal.Value;
  readonly legs: ReadonlyArray<DistributionLeg>;
  readonly settlement: AllocationSettlementInfo;
  readonly settlementDeadline: Date;
  readonly requestedAt: Date;
  readonly actors?: ReadonlyArray<string> | undefined;
  readonly committed?: boolean | undefined;
  readonly choiceContextValues?: Readonly<Record<string, unknown>> | undefined;
  readonly meta?: Readonly<Record<string, string>> | undefined;
}

export interface DistributionRecipientAllocationFactoryPlan {
  readonly choiceArguments: Record<string, unknown>;
  readonly settlementLegs: ReadonlyArray<DistributionSettlementLeg>;
}

export interface BuildDistributionSettlementFactoryParams {
  readonly payerAccount: AccountV2 & { readonly owner: string };
  readonly instrumentId: InstrumentIdV2;
  readonly grossAmount: Decimal.Value;
  readonly grossAmountPerPeriod: Decimal.Value;
  readonly legs: ReadonlyArray<DistributionLeg>;
  readonly settlement: AllocationSettlementInfo;
  readonly allocationCid: string;
  readonly recipientAuthorizations: ReadonlyArray<DistributionRecipientAuthorization>;
  readonly nextIterationFunding?: NextIterationFundingAmounts | undefined;
  readonly actors?: ReadonlyArray<string> | undefined;
  readonly choiceContextValues?: Readonly<Record<string, unknown>> | undefined;
  readonly meta?: Readonly<Record<string, string>> | undefined;
}

export interface DistributionSettlementFactoryPlan {
  readonly choiceArguments: Record<string, unknown>;
  readonly settlementLegs: ReadonlyArray<DistributionSettlementLeg>;
}

function numeric(amount: Decimal.Value): { numeric: string } {
  return { numeric: new Decimal(amount).toFixed(10) };
}

function int64(value: number): { int64: string } {
  return { int64: String(value) };
}

function timestamp(value: Date): { timestamp: string } {
  return { timestamp: String(BigInt(value.getTime()) * 1000n) };
}

function optional(value: unknown | undefined): { optional: unknown | null } {
  return { optional: value === undefined ? null : value };
}

function party(value: string): { party: string } {
  return { party: value };
}

function text(value: string): { text: string } {
  return { text: value };
}

function damlEnum(value: string): Record<string, unknown> {
  return { enum: { enum_constructor: value } };
}

function damlVariant(value: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { variant: { variant_constructor: value, value: fields } };
}

function encodeAccount(account: AccountV2 & { readonly owner: string }): Record<string, unknown> {
  return {
    owner: party(account.owner),
    provider: optional(account.provider === undefined ? undefined : party(account.provider)),
    id: text(account.id),
  };
}

function sameAccount(left: AccountV2, right: AccountV2): boolean {
  return (
    left.owner === right.owner &&
    (left.provider ?? undefined) === (right.provider ?? undefined) &&
    left.id === right.id
  );
}

function encodeRule(rule: DistributionRule): Record<string, unknown> {
  return rule.type === 'percentage'
    ? damlVariant('PercentageBps', { basisPoints: int64(rule.basisPoints) })
    : damlVariant('FixedAmountPerPeriod', { amount: numeric(rule.amountPerPeriod) });
}

function encodeLeg(leg: DistributionLeg): Record<string, unknown> {
  if (!leg.receiver.owner) {
    throw new Error(`Distribution leg "${leg.legId}" requires a receiver owner`);
  }
  return {
    legId: text(leg.legId),
    receiver: encodeAccount(leg.receiver as AccountV2 & { readonly owner: string }),
    rule: encodeRule(leg.rule),
  };
}

function decimal10(value: Decimal.Value): Decimal {
  return new Decimal(value).toDecimalPlaces(10, Decimal.ROUND_HALF_EVEN);
}

export function validateDistribution(
  grossAmountPerPeriod: Decimal.Value,
  legs: ReadonlyArray<DistributionLeg>,
): void {
  const gross = decimal10(grossAmountPerPeriod);
  if (!gross.isPositive()) throw new Error('grossAmountPerPeriod must be positive');
  if (legs.length === 0) throw new Error('At least one distribution leg is required');
  if (legs.length > 25) {
    throw new Error('Distribution supports at most 25 legs for registry portability');
  }

  const ids = new Set<string>();
  for (const leg of legs) {
    if (leg.legId.trim() === '') throw new Error('Distribution leg id is required');
    if (ids.has(leg.legId)) throw new Error(`Duplicate distribution leg id: ${leg.legId}`);
    ids.add(leg.legId);
    if (!leg.receiver.owner)
      throw new Error(`Distribution leg "${leg.legId}" requires a receiver owner`);
  }

  const mode = legs[0]!.rule.type;
  if (legs.some((leg) => leg.rule.type !== mode)) {
    throw new Error('Distribution legs must all use percentage or all use fixed amounts');
  }

  if (mode === 'percentage') {
    const total = legs.reduce((sum, leg) => {
      const basisPoints = (leg.rule as Extract<DistributionRule, { type: 'percentage' }>)
        .basisPoints;
      if (!Number.isInteger(basisPoints) || basisPoints <= 0) {
        throw new Error(`Distribution leg "${leg.legId}" basisPoints must be a positive integer`);
      }
      return sum + basisPoints;
    }, 0);
    if (total !== 10_000)
      throw new Error(`Percentage distribution must total 10000 bps; received ${total}`);
    return;
  }

  const total = legs.reduce((sum, leg) => {
    const amount = decimal10(
      (leg.rule as Extract<DistributionRule, { type: 'fixed' }>).amountPerPeriod,
    );
    if (!amount.isPositive()) {
      throw new Error(`Distribution leg "${leg.legId}" amountPerPeriod must be positive`);
    }
    return sum.plus(amount);
  }, new Decimal(0));
  if (!total.equals(gross)) {
    throw new Error(
      `Fixed distribution amounts must total grossAmountPerPeriod (${gross.toFixed(10)}); received ${total.toFixed(10)}`,
    );
  }
}

export function calculateDistributionAmounts(
  grossAmount: Decimal.Value,
  grossAmountPerPeriod: Decimal.Value,
  legs: ReadonlyArray<DistributionLeg>,
): DistributionSettlementLeg[] {
  validateDistribution(grossAmountPerPeriod, legs);
  const gross = decimal10(grossAmount);
  const perPeriod = decimal10(grossAmountPerPeriod);
  if (!gross.isPositive()) throw new Error('grossAmount must be positive');

  let allocated = new Decimal(0);
  return legs.map((leg, index) => {
    const isLast = index === legs.length - 1;
    let amount: Decimal;
    if (isLast) {
      amount = decimal10(gross.minus(allocated));
    } else if (leg.rule.type === 'percentage') {
      const product = decimal10(gross.times(leg.rule.basisPoints));
      amount = decimal10(product.dividedBy(10_000));
    } else {
      const product = decimal10(gross.times(leg.rule.amountPerPeriod));
      amount = decimal10(product.dividedBy(perPeriod));
    }
    if (amount.isNegative()) {
      throw new Error('Distribution rounding produced a negative residual');
    }
    allocated = allocated.plus(amount);
    return { legId: leg.legId, amount };
  });
}

export function buildDistributionCreate(
  params: CreateDistributionParams,
): DistributionCreatePayload {
  validateDistribution(params.grossAmountPerPeriod, params.legs);
  if (!Number.isSafeInteger(params.periodSeconds) || params.periodSeconds <= 0) {
    throw new Error('periodSeconds must be a positive safe integer');
  }
  if (params.endTime && params.endTime <= params.startTime) {
    throw new Error('endTime must be after startTime');
  }
  return {
    templateId: TEMPLATE_DISTRIBUTION_STREAM,
    signatories: [params.operator],
    argument: {
      streamId: text(params.streamId),
      operator: party(params.operator),
      payerAccount: encodeAccount(params.payerAccount),
      instrumentId: { admin: party(params.instrumentId.admin), id: text(params.instrumentId.id) },
      grossAmountPerPeriod: numeric(params.grossAmountPerPeriod),
      periodSeconds: int64(params.periodSeconds),
      startTime: timestamp(params.startTime),
      endTime: optional(params.endTime ? timestamp(params.endTime) : undefined),
      legs: params.legs.map(encodeLeg),
      fundingMode: damlEnum(params.fundingMode ?? 'EscrowFunding'),
      totalFunded: numeric(0),
      totalGrossSettled: numeric(0),
      fundingCount: int64(0),
      settlementCount: int64(0),
      currentAllocationCid: optional(undefined),
      originalAllocationId: optional(undefined),
      lastFundingId: optional(undefined),
      lastSettlementId: optional(undefined),
      fundingIds: [],
      settlementIds: [],
      recipientAuthorizations: [],
      recipientAuthorizationIds: [],
      currentSettlementDeadline: optional(undefined),
      status: damlEnum('AwaitingFunding'),
      observers: (params.observers ?? []).map(party),
    },
  };
}

export function buildDistributionAllocationRequest(
  caps: AssetCapabilities,
  params: BuildDistributionAllocationRequestParams,
  allocationRequestTemplateId: TemplateId,
): DistributionAllocationRequest {
  const settlementLegs = calculateDistributionAmounts(
    params.grossAmount,
    params.grossAmountPerPeriod,
    params.legs,
  );
  const amountById = new Map(settlementLegs.map((leg) => [leg.legId, leg.amount]));
  const request = buildAllocationRequest(
    caps,
    {
      settlement: params.settlement,
      legs: params.legs.map((leg) => ({
        legId: leg.legId,
        leg: {
          sender: params.sender,
          authorizer: params.payerAccount,
          receiver: leg.receiver,
          amount: amountById.get(leg.legId)!,
          instrumentId: params.instrumentId,
          meta: leg.meta,
        },
      })),
      committed: params.committed ?? true,
      nextIterationFunding: params.nextIterationFunding,
      originalRequestCid: params.originalRequestCid,
      meta: params.meta,
    },
    allocationRequestTemplateId,
  );
  return { request, settlementLegs };
}

export function buildDistributionAllocationFactoryPlan(
  params: BuildDistributionAllocationFactoryParams,
): DistributionAllocationFactoryPlan {
  const settlementLegs = calculateDistributionAmounts(
    params.grossAmount,
    params.grossAmountPerPeriod,
    params.legs,
  );
  const nextIterationFunding = params.nextIterationFunding ?? {
    [params.instrumentId.id]: new Decimal(params.grossAmount),
  };
  const factoryParams: AllocationFactoryAllocateParams = {
    settlement: params.settlement,
    admin: params.instrumentId.admin,
    authorizer: params.payerAccount,
    transferLegSides: [],
    settlementDeadline: params.settlementDeadline,
    nextIterationFunding,
    committed: params.committed ?? true,
    allocationMeta: params.meta,
    requestedAt: params.requestedAt,
    inputHoldingCids: params.inputHoldingCids,
    actors: params.actors ?? [params.sender],
    choiceContextValues: params.choiceContextValues,
    extraArgsMeta: params.meta,
  };
  return {
    choiceArguments: buildAllocationFactoryAllocateJson(factoryParams),
    settlementLegs,
  };
}

export function buildDistributionRecipientAllocationFactoryPlan(
  params: BuildDistributionRecipientAllocationFactoryParams,
): DistributionRecipientAllocationFactoryPlan {
  const settlementLegs = calculateDistributionAmounts(
    params.grossAmount,
    params.grossAmountPerPeriod,
    params.legs,
  );
  const amountById = new Map(settlementLegs.map((leg) => [leg.legId, leg.amount]));
  const receiverLegs = params.legs.filter((leg) =>
    sameAccount(leg.receiver, params.receiverAccount),
  );
  if (receiverLegs.length === 0) {
    throw new Error('receiverAccount has no configured distribution legs');
  }
  const transferLegSides: TransferLegSideV2[] = receiverLegs.map((leg) => ({
    transferLegId: leg.legId,
    side: 'ReceiverSide',
    otherside: params.payerAccount,
    amount: amountById.get(leg.legId)!,
    instrumentId: params.instrumentId.id,
    meta: leg.meta,
  }));
  return {
    choiceArguments: buildAllocationFactoryAllocateJson({
      settlement: params.settlement,
      admin: params.instrumentId.admin,
      authorizer: params.receiverAccount,
      transferLegSides,
      settlementDeadline: params.settlementDeadline,
      nextIterationFunding: {},
      committed: params.committed ?? false,
      allocationMeta: params.meta,
      requestedAt: params.requestedAt,
      inputHoldingCids: [],
      actors: params.actors ?? [params.receiverAccount.owner],
      choiceContextValues: params.choiceContextValues,
      extraArgsMeta: params.meta,
    }),
    settlementLegs: settlementLegs.filter((leg) =>
      receiverLegs.some((configured) => configured.legId === leg.legId),
    ),
  };
}

export function buildDistributionSettlementFactoryPlan(
  params: BuildDistributionSettlementFactoryParams,
): DistributionSettlementFactoryPlan {
  const settlementLegs = calculateDistributionAmounts(
    params.grossAmount,
    params.grossAmountPerPeriod,
    params.legs,
  );
  const amountById = new Map(settlementLegs.map((leg) => [leg.legId, leg.amount]));
  const payerSides: TransferLegSideV2[] = params.legs.map((leg) => ({
    transferLegId: leg.legId,
    side: 'SenderSide',
    otherside: leg.receiver,
    amount: amountById.get(leg.legId)!,
    instrumentId: params.instrumentId.id,
    meta: leg.meta,
  }));
  return {
    choiceArguments: buildSettlementFactorySettleBatchJson({
      settlement: params.settlement,
      transferLegs: params.legs.map((leg) => ({
        transferLegId: leg.legId,
        sender: params.payerAccount,
        receiver: leg.receiver,
        amount: amountById.get(leg.legId)!,
        instrumentId: params.instrumentId.id,
        meta: leg.meta,
      })),
      allocations: [
        {
          allocationCid: params.allocationCid,
          extraTransferLegSides: payerSides,
          nextIterationFunding:
            params.nextIterationFunding === undefined
              ? undefined
              : { amounts: params.nextIterationFunding },
        },
        ...params.recipientAuthorizations.map((authorization) => ({
          allocationCid: authorization.allocationCid,
          nextIterationFunding:
            params.nextIterationFunding === undefined ? undefined : { amounts: {} },
        })),
      ],
      actors: params.actors ?? params.settlement.executors ?? [params.settlement.executor],
      choiceContextValues: params.choiceContextValues,
      extraArgsMeta: params.meta,
    }),
    settlementLegs,
  };
}

async function exerciseRecord(
  transport: Transport,
  contractId: string,
  operator: string,
  choice: string,
  argument: Record<string, unknown>,
  logger: Logger,
): Promise<{ newRecordCid: string }> {
  logger.info({ contractId, choice }, 'Exercising distribution record choice');
  const result = (await transport.exercise(
    TEMPLATE_DISTRIBUTION_STREAM,
    contractId,
    choice,
    argument,
    [operator],
  )) as { contractId?: string };
  return { newRecordCid: result.contractId ?? '' };
}

export interface RecordDistributionFundingParams {
  readonly contractId: string;
  readonly operator: string;
  readonly amount: Decimal.Value;
  readonly fundingId: string;
  readonly allocationCid: string;
  readonly originalAllocationCid?: string | undefined;
  readonly settlementDeadline: Date;
  readonly expectedSequence: number;
}

export function recordDistributionFunding(
  transport: Transport,
  params: RecordDistributionFundingParams,
  logger: Logger,
): Promise<{ newRecordCid: string }> {
  return exerciseRecord(
    transport,
    params.contractId,
    params.operator,
    CHOICE_RECORD_DISTRIBUTION_FUNDING,
    {
      amount: numeric(params.amount),
      fundingId: text(params.fundingId),
      allocationCid: text(params.allocationCid),
      originalAllocationCid: optional(
        params.originalAllocationCid === undefined ? undefined : text(params.originalAllocationCid),
      ),
      settlementDeadline: timestamp(params.settlementDeadline),
      expectedSequence: int64(params.expectedSequence),
    },
    logger,
  );
}

export interface RecordDistributionRecipientAuthorizationParams {
  readonly contractId: string;
  readonly operator: string;
  readonly receiver: AccountV2 & { readonly owner: string };
  readonly authorizationId: string;
  readonly allocationCid: string;
  readonly expectedCount: number;
}

export function recordDistributionRecipientAuthorization(
  transport: Transport,
  params: RecordDistributionRecipientAuthorizationParams,
  logger: Logger,
): Promise<{ newRecordCid: string }> {
  return exerciseRecord(
    transport,
    params.contractId,
    params.operator,
    CHOICE_RECORD_DISTRIBUTION_RECIPIENT_AUTHORIZATION,
    {
      receiver: encodeAccount(params.receiver),
      authorizationId: text(params.authorizationId),
      allocationCid: text(params.allocationCid),
      expectedCount: int64(params.expectedCount),
    },
    logger,
  );
}

export function activateDistribution(
  transport: Transport,
  contractId: string,
  operator: string,
  logger: Logger,
): Promise<{ newRecordCid: string }> {
  return exerciseRecord(transport, contractId, operator, CHOICE_ACTIVATE_DISTRIBUTION, {}, logger);
}

export interface RecordDistributionSettlementParams {
  readonly contractId: string;
  readonly operator: string;
  readonly grossAmount: Decimal.Value;
  readonly grossAmountPerPeriod: Decimal.Value;
  readonly legs: ReadonlyArray<DistributionLeg>;
  readonly settlementId: string;
  readonly settledAt: Date;
  readonly newAllocationCid?: string | undefined;
  readonly newRecipientAuthorizations: ReadonlyArray<DistributionRecipientAuthorization>;
  readonly expectedSequence: number;
}

export function recordDistributionSettlement(
  transport: Transport,
  params: RecordDistributionSettlementParams,
  logger: Logger,
): Promise<{ newRecordCid: string }> {
  const settledLegs = calculateDistributionAmounts(
    params.grossAmount,
    params.grossAmountPerPeriod,
    params.legs,
  );
  return exerciseRecord(
    transport,
    params.contractId,
    params.operator,
    CHOICE_RECORD_DISTRIBUTION_SETTLEMENT,
    {
      grossAmount: numeric(params.grossAmount),
      settledLegs: settledLegs.map((leg) => ({
        legId: text(leg.legId),
        amount: numeric(leg.amount),
      })),
      settlementId: text(params.settlementId),
      settledAt: timestamp(params.settledAt),
      newAllocationCid: optional(
        params.newAllocationCid === undefined ? undefined : text(params.newAllocationCid),
      ),
      newRecipientAuthorizations: params.newRecipientAuthorizations.map((authorization) => ({
        receiver: encodeAccount(authorization.receiver),
        authorizationId: text(authorization.authorizationId),
        allocationCid: text(authorization.allocationCid),
      })),
      expectedSequence: int64(params.expectedSequence),
    },
    logger,
  );
}

export function pauseDistribution(
  transport: Transport,
  contractId: string,
  operator: string,
  logger: Logger,
): Promise<{ newRecordCid: string }> {
  return exerciseRecord(transport, contractId, operator, CHOICE_PAUSE_DISTRIBUTION, {}, logger);
}

export function resumeDistribution(
  transport: Transport,
  contractId: string,
  operator: string,
  logger: Logger,
): Promise<{ newRecordCid: string }> {
  return exerciseRecord(transport, contractId, operator, CHOICE_RESUME_DISTRIBUTION, {}, logger);
}

export function completeDistribution(
  transport: Transport,
  contractId: string,
  operator: string,
  logger: Logger,
): Promise<{ newRecordCid: string }> {
  return exerciseRecord(transport, contractId, operator, CHOICE_COMPLETE_DISTRIBUTION, {}, logger);
}

export function cancelDistribution(
  transport: Transport,
  contractId: string,
  operator: string,
  releasedAllocationCid: string | undefined,
  logger: Logger,
): Promise<{ newRecordCid: string }> {
  return exerciseRecord(
    transport,
    contractId,
    operator,
    CHOICE_CANCEL_DISTRIBUTION,
    {
      releasedAllocationCid: optional(
        releasedAllocationCid === undefined ? undefined : text(releasedAllocationCid),
      ),
    },
    logger,
  );
}
