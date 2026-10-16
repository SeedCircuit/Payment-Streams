import { describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';

import type { AssetCapabilities } from '../../src/assets/capabilities.js';
import {
  buildDistributionAllocationRequest,
  buildDistributionAllocationFactoryPlan,
  buildDistributionRecipientAllocationFactoryPlan,
  buildDistributionSettlementFactoryPlan,
  buildDistributionCreate,
  calculateDistributionAmounts,
  recordDistributionSettlement,
  validateDistribution,
  type CreateDistributionParams,
  type DistributionLeg,
} from '../../src/commands/distribution.js';
import { TEMPLATE_DISTRIBUTION_STREAM } from '../../src/templates.js';
import type { TemplateId, Transport } from '../../src/transport/base.js';

const caps: AssetCapabilities = {
  key: 'cc-v2',
  allocationsV2: true,
  allocationsV1: false,
  transferEventsV2: true,
  paused: false,
  source: 'registry',
};

const allocationRequestTemplate: TemplateId = {
  packageId: 'token-standard-v2',
  moduleName: 'Splice.Api.Token.AllocationRequestV2',
  entityName: 'AllocationRequest',
};

const percentageLegs: DistributionLeg[] = [
  {
    legId: 'supplier',
    receiver: { owner: 'supplier', id: '' },
    rule: { type: 'percentage', basisPoints: 9000 },
  },
  {
    legId: 'facilitator',
    receiver: { owner: 'platform', id: 'fees' },
    rule: { type: 'percentage', basisPoints: 1000 },
  },
];

function createParams(overrides: Partial<CreateDistributionParams> = {}): CreateDistributionParams {
  return {
    streamId: 'distribution-001',
    operator: 'operator',
    payerAccount: { owner: 'consumer', id: '' },
    instrumentId: { admin: 'cc-admin', id: 'Amulet' },
    grossAmountPerPeriod: new Decimal('684.93'),
    periodSeconds: 86_400,
    startTime: new Date('2026-01-01T00:00:00Z'),
    legs: percentageLegs,
    ...overrides,
  };
}

describe('distribution validation and calculation', () => {
  it('calculates a 90/10 split exactly', () => {
    const result = calculateDistributionAmounts('684.93', '684.93', percentageLegs);
    expect(result.map((leg) => [leg.legId, leg.amount.toFixed(10)])).toEqual([
      ['supplier', '616.4370000000'],
      ['facilitator', '68.4930000000'],
    ]);
  });

  it('assigns Numeric-10 rounding residual to the final leg', () => {
    const thirds: DistributionLeg[] = [
      {
        legId: 'a',
        receiver: { owner: 'a', id: '' },
        rule: { type: 'percentage', basisPoints: 3333 },
      },
      {
        legId: 'b',
        receiver: { owner: 'b', id: '' },
        rule: { type: 'percentage', basisPoints: 3333 },
      },
      {
        legId: 'c',
        receiver: { owner: 'c', id: '' },
        rule: { type: 'percentage', basisPoints: 3334 },
      },
    ];
    const result = calculateDistributionAmounts('1', '1', thirds);
    expect(result.reduce((sum, leg) => sum.plus(leg.amount), new Decimal(0)).toFixed(10)).toBe(
      '1.0000000000',
    );
    expect(result[2]!.amount.toFixed(10)).toBe('0.3334000000');
  });

  it('scales fixed per-period amounts across a settlement batch', () => {
    const fixed: DistributionLeg[] = [
      {
        legId: 'supplier',
        receiver: { owner: 'supplier', id: '' },
        rule: { type: 'fixed', amountPerPeriod: '90' },
      },
      {
        legId: 'fee',
        receiver: { owner: 'platform', id: '' },
        rule: { type: 'fixed', amountPerPeriod: '10' },
      },
    ];
    const result = calculateDistributionAmounts('700', '100', fixed);
    expect(result.map((leg) => leg.amount.toFixed(10))).toEqual([
      '630.0000000000',
      '70.0000000000',
    ]);
  });

  it('rejects mixed rule modes and invalid percentage totals', () => {
    expect(() =>
      validateDistribution('100', [
        percentageLegs[0]!,
        {
          legId: 'fixed',
          receiver: { owner: 'platform', id: '' },
          rule: { type: 'fixed', amountPerPeriod: '10' },
        },
      ]),
    ).toThrow(/all use percentage or all use fixed/);
    expect(() =>
      validateDistribution('100', [
        { ...percentageLegs[0]!, rule: { type: 'percentage', basisPoints: 8000 } },
        percentageLegs[1]!,
      ]),
    ).toThrow(/must total 10000/);
  });

  it('rejects more than 25 legs for portable registry support', () => {
    const legs = Array.from(
      { length: 26 },
      (_, index): DistributionLeg => ({
        legId: `leg-${index}`,
        receiver: { owner: `receiver-${index}`, id: '' },
        rule: { type: 'fixed', amountPerPeriod: '1' },
      }),
    );
    expect(() => validateDistribution('26', legs)).toThrow(/at most 25 legs/);
  });
});

describe('buildDistributionCreate', () => {
  it('builds an operator-signed record with immutable legs', () => {
    const payload = buildDistributionCreate(createParams());
    expect(payload.templateId).toEqual(TEMPLATE_DISTRIBUTION_STREAM);
    expect(payload.signatories).toEqual(['operator']);
    expect(payload.argument).toMatchObject({
      streamId: { text: 'distribution-001' },
      operator: { party: 'operator' },
      grossAmountPerPeriod: { numeric: '684.9300000000' },
      periodSeconds: { int64: '86400' },
      status: { enum: { enum_constructor: 'AwaitingFunding' } },
    });
    const legs = payload.argument['legs'] as Array<Record<string, unknown>>;
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({
      legId: { text: 'supplier' },
      rule: {
        variant: {
          variant_constructor: 'PercentageBps',
          value: { basisPoints: { int64: '9000' } },
        },
      },
    });
  });
});

describe('buildDistributionAllocationRequest', () => {
  it('composes one standard V2 allocation entry per destination', () => {
    const result = buildDistributionAllocationRequest(
      caps,
      {
        sender: 'consumer',
        payerAccount: { owner: 'consumer', id: '' },
        instrumentId: { admin: 'cc-admin', id: 'Amulet' },
        grossAmount: '4794.51',
        grossAmountPerPeriod: '684.93',
        legs: percentageLegs,
        settlement: {
          executor: 'operator',
          settlementRefId: 'distribution-001:1',
          requestedAt: new Date('2026-01-08T00:00:00Z'),
        },
      },
      allocationRequestTemplate,
    );
    expect(result.settlementLegs.map((leg) => leg.amount.toFixed(10))).toEqual([
      '4315.0590000000',
      '479.4510000000',
    ]);
    const allocations = result.request.argument['allocations'] as Array<{
      transferLegSides: Array<{ amount: { numeric: string } }>;
    }>;
    expect(allocations).toHaveLength(2);
    expect(allocations.map((allocation) => allocation.transferLegSides[0]!.amount.numeric)).toEqual(
      ['4315.0590000000', '479.4510000000'],
    );
  });
});

describe('buildDistributionAllocationFactoryPlan', () => {
  it('builds a canonical prefunded V2 allocation without fixed transfer legs', () => {
    const result = buildDistributionAllocationFactoryPlan({
      sender: 'consumer',
      payerAccount: { owner: 'consumer', id: '' },
      instrumentId: { admin: 'cc-admin', id: 'Amulet' },
      grossAmount: '684.93',
      grossAmountPerPeriod: '684.93',
      legs: percentageLegs,
      settlement: {
        executor: 'operator',
        settlementRefId: 'distribution-001:funding-1',
        requestedAt: new Date('2026-01-08T00:00:00Z'),
      },
      settlementDeadline: new Date('2026-02-08T00:00:00Z'),
      requestedAt: new Date('2026-01-08T00:00:00Z'),
      inputHoldingCids: ['holding-1'],
      nextIterationFunding: { Amulet: '20547.90' },
      choiceContextValues: { round: 'round-contract' },
    });
    expect(result.choiceArguments).toMatchObject({
      settlement: {
        executors: ['operator'],
        id: 'distribution-001:funding-1',
      },
      allocation: {
        admin: 'cc-admin',
        authorizer: { owner: 'consumer', provider: null, id: '' },
        committed: true,
        settlementDeadline: '2026-02-08T00:00:00.000Z',
        transferLegSides: [],
        nextIterationFunding: { Amulet: '20547.9000000000' },
      },
      inputHoldingCids: ['holding-1'],
      actors: ['consumer'],
      extraArgs: { context: { values: { round: 'round-contract' } } },
    });
  });
});

describe('buildDistributionRecipientAllocationFactoryPlan', () => {
  it('builds a no-funds ReceiverSide allocation for one destination account', () => {
    const result = buildDistributionRecipientAllocationFactoryPlan({
      receiverAccount: { owner: 'supplier', id: '' },
      payerAccount: { owner: 'consumer', id: '' },
      instrumentId: { admin: 'cc-admin', id: 'Amulet' },
      grossAmount: '684.93',
      grossAmountPerPeriod: '684.93',
      legs: percentageLegs,
      settlement: {
        executor: 'operator',
        settlementRefId: 'distribution-001:funding-1',
        requestedAt: new Date('2026-01-01T00:00:00Z'),
      },
      settlementDeadline: new Date('2026-02-01T00:00:00Z'),
      requestedAt: new Date('2026-01-01T00:00:00Z'),
    });

    expect(result.choiceArguments).toMatchObject({
      allocation: {
        authorizer: { owner: 'supplier', provider: null, id: '' },
        committed: false,
        transferLegSides: [
          {
            transferLegId: 'supplier',
            side: 'ReceiverSide',
            otherside: { owner: 'consumer', provider: null, id: '' },
            amount: '616.4370000000',
          },
        ],
        nextIterationFunding: {},
      },
      inputHoldingCids: [],
      actors: ['supplier'],
    });
  });
});

describe('buildDistributionSettlementFactoryPlan', () => {
  it('builds the canonical V2 batch settlement for one distribution period', () => {
    const result = buildDistributionSettlementFactoryPlan({
      payerAccount: { owner: 'consumer', id: '' },
      instrumentId: { admin: 'cc-admin', id: 'Amulet' },
      grossAmount: '684.93',
      grossAmountPerPeriod: '684.93',
      legs: percentageLegs,
      settlement: {
        executor: 'operator',
        settlementRefId: 'distribution-001:funding-1',
        requestedAt: new Date('2026-01-08T00:00:00Z'),
      },
      allocationCid: 'allocation-cid-1',
      recipientAuthorizations: [
        {
          receiver: { owner: 'supplier', id: '' },
          authorizationId: 'supplier-authorization',
          allocationCid: 'supplier-allocation-cid',
        },
        {
          receiver: { owner: 'platform', id: 'fees' },
          authorizationId: 'platform-authorization',
          allocationCid: 'platform-allocation-cid',
        },
      ],
      nextIterationFunding: { Amulet: '19862.97' },
      choiceContextValues: { rules: 'rules-cid' },
    });

    expect(result.settlementLegs.map((leg) => leg.amount.toFixed(10))).toEqual([
      '616.4370000000',
      '68.4930000000',
    ]);
    expect(result.choiceArguments).toMatchObject({
      settlement: {
        executors: ['operator'],
        id: 'distribution-001:funding-1',
      },
      transferLegs: [
        {
          transferLegId: 'supplier',
          sender: { owner: 'consumer', provider: null, id: '' },
          receiver: { owner: 'supplier', provider: null, id: '' },
          amount: '616.4370000000',
          instrumentId: 'Amulet',
        },
        {
          transferLegId: 'facilitator',
          sender: { owner: 'consumer', provider: null, id: '' },
          receiver: { owner: 'platform', provider: null, id: 'fees' },
          amount: '68.4930000000',
          instrumentId: 'Amulet',
        },
      ],
      allocations: [
        {
          allocationCid: 'allocation-cid-1',
          extraTransferLegSides: [
            {
              transferLegId: 'supplier',
              side: 'SenderSide',
              otherside: { owner: 'supplier', provider: null, id: '' },
              amount: '616.4370000000',
            },
            {
              transferLegId: 'facilitator',
              side: 'SenderSide',
              otherside: { owner: 'platform', provider: null, id: 'fees' },
              amount: '68.4930000000',
            },
          ],
          nextIterationFunding: { Amulet: '19862.9700000000' },
        },
        {
          allocationCid: 'supplier-allocation-cid',
          extraTransferLegSides: [],
          nextIterationFunding: {},
        },
        {
          allocationCid: 'platform-allocation-cid',
          extraTransferLegSides: [],
          nextIterationFunding: {},
        },
      ],
      actors: ['operator'],
      extraArgs: { context: { values: { rules: 'rules-cid' } } },
    });
  });

  it('terminates payer and recipient allocations after the final funded period', () => {
    const result = buildDistributionSettlementFactoryPlan({
      payerAccount: { owner: 'consumer', id: '' },
      instrumentId: { admin: 'cc-admin', id: 'Amulet' },
      grossAmount: '684.93',
      grossAmountPerPeriod: '684.93',
      legs: percentageLegs,
      settlement: {
        executor: 'operator',
        settlementRefId: 'distribution-001:funding-1',
        requestedAt: new Date('2026-01-08T00:00:00Z'),
      },
      allocationCid: 'allocation-cid-1',
      recipientAuthorizations: [
        {
          receiver: { owner: 'supplier', id: '' },
          authorizationId: 'supplier-authorization',
          allocationCid: 'supplier-allocation-cid',
        },
      ],
    });

    expect(result.choiceArguments).toMatchObject({
      allocations: [
        { allocationCid: 'allocation-cid-1', nextIterationFunding: null },
        { allocationCid: 'supplier-allocation-cid', nextIterationFunding: null },
      ],
    });
  });
});

describe('recordDistributionSettlement', () => {
  it('records the same deterministic split used by the allocation request', async () => {
    const transport = {
      exercise: vi.fn().mockResolvedValue({ contractId: 'distribution-cid-2' }),
    } as unknown as Transport;
    const logger = { info: vi.fn() } as unknown as Parameters<
      typeof recordDistributionSettlement
    >[2];
    const result = await recordDistributionSettlement(
      transport,
      {
        contractId: 'distribution-cid-1',
        operator: 'operator',
        grossAmount: '684.93',
        grossAmountPerPeriod: '684.93',
        legs: percentageLegs,
        settlementId: 'update-1',
        settledAt: new Date('2026-01-02T00:00:00Z'),
        newRecipientAuthorizations: [
          {
            receiver: { owner: 'supplier', id: '' },
            authorizationId: 'supplier-authorization',
            allocationCid: 'supplier-allocation-next',
          },
        ],
        expectedSequence: 1,
      },
      logger,
    );
    expect(result.newRecordCid).toBe('distribution-cid-2');
    expect(transport.exercise).toHaveBeenCalledWith(
      TEMPLATE_DISTRIBUTION_STREAM,
      'distribution-cid-1',
      'RecordDistributionSettlement',
      expect.objectContaining({
        grossAmount: { numeric: '684.9300000000' },
        settledLegs: [
          { legId: { text: 'supplier' }, amount: { numeric: '616.4370000000' } },
          { legId: { text: 'facilitator' }, amount: { numeric: '68.4930000000' } },
        ],
        settlementId: { text: 'update-1' },
        newRecipientAuthorizations: [
          {
            receiver: {
              owner: { party: 'supplier' },
              provider: { optional: null },
              id: { text: '' },
            },
            authorizationId: { text: 'supplier-authorization' },
            allocationCid: { text: 'supplier-allocation-next' },
          },
        ],
        expectedSequence: { int64: '1' },
      }),
      ['operator'],
    );
  });
});
