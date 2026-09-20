import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DISTRIBUTION_ALLOCATION_FACTORY_INTERFACE_ID,
  DEFAULT_DISTRIBUTION_SETTLEMENT_FACTORY_INTERFACE_ID,
  buildDistributionCreateArguments,
  calculateDistributionAccruedGross,
  decodeDistributionRecord,
  prepareDistributionFunding,
  prepareDistributionRecipientAuthorization,
  prepareDistributionSettlement,
} from '../dist/distribution.js';
import { AuthError, enforceRole } from '../dist/auth.js';
import { requireNonEmptyObject } from '../dist/validation.js';

test('rejects an empty distribution request body as invalid input', () => {
  assert.throws(
    () => requireNonEmptyObject({}, 'request body'),
    (error) =>
      error instanceof AuthError &&
      error.statusCode === 400 &&
      error.reason === 'invalid_input',
  );
});

test('accepts only the selected distribution receiver as recipient', () => {
  assert.doesNotThrow(() =>
    enforceRole('Supplier::abcdef12', 'recipient', undefined, 'Supplier::abcdef12'),
  );
  assert.throws(
    () => enforceRole('Other::abcdef12', 'recipient', undefined, 'Supplier::abcdef12'),
    (error) =>
      error instanceof AuthError && error.statusCode === 403 && error.reason === 'role_mismatch',
  );
});

test('uses stable V2 package-name references for factory interfaces', () => {
  assert.equal(
    DEFAULT_DISTRIBUTION_ALLOCATION_FACTORY_INTERFACE_ID,
    '#splice-api-token-allocation-instruction-v2:Splice.Api.Token.AllocationInstructionV2:AllocationFactory',
  );
  assert.equal(
    DEFAULT_DISTRIBUTION_SETTLEMENT_FACTORY_INTERFACE_ID,
    '#splice-api-token-allocation-v2:Splice.Api.Token.AllocationV2:SettlementFactory',
  );
});

const input = {
  streamId: 'distribution-1',
  operator: 'PlatformOperator::abcdef12',
  payerAccount: { owner: 'Payer::abcdef12', id: '' },
  instrumentId: { admin: 'CantonCoin::abcdef12', id: 'Amulet' },
  grossAmountPerPeriod: '684.93',
  periodSeconds: 86_400,
  startTime: new Date('2026-09-20T00:00:00Z'),
  legs: [
    {
      legId: 'supplier',
      receiver: { owner: 'Supplier::abcdef12', id: '' },
      rule: { type: 'percentage', basisPoints: 9000 },
    },
    {
      legId: 'facilitator-fee',
      receiver: { owner: 'Platform::abcdef12', id: 'fees' },
      rule: { type: 'percentage', basisPoints: 1000 },
    },
  ],
};

test('buildDistributionCreateArguments emits plain DA-JSON for a 90/10 distribution', () => {
  const args = buildDistributionCreateArguments(input);

  assert.equal(args.streamId, 'distribution-1');
  assert.equal(args.grossAmountPerPeriod, '684.9300000000');
  assert.equal(args.periodSeconds, '86400');
  assert.equal(args.status, 'AwaitingFunding');
  assert.deepEqual(args.observers, []);
  assert.deepEqual(args.legs[0].rule, {
    tag: 'PercentageBps',
    value: { basisPoints: '9000' },
  });
});

test('decodeDistributionRecord returns participant-facing state', () => {
  const args = buildDistributionCreateArguments(input);
  const record = decodeDistributionRecord(
    {
      ...args,
      totalFunded: '20547.9000000000',
      fundingCount: '1',
      currentAllocationCid: 'allocation-cid-1',
      currentSettlementDeadline: '2026-10-20T00:00:00Z',
      recipientAuthorizations: [
        {
          receiver: input.legs[0].receiver,
          authorizationId: 'supplier-authorization',
          allocationCid: 'supplier-allocation-cid',
        },
      ],
      recipientAuthorizationIds: ['supplier-authorization'],
      status: 'DistributionActive',
    },
    'distribution-cid-1',
  );

  assert.equal(record.contractId, 'distribution-cid-1');
  assert.equal(record.payerAccount.owner, 'Payer::abcdef12');
  assert.equal(record.legs[1].receiver.owner, 'Platform::abcdef12');
  assert.equal(record.legs[1].rule.basisPoints, 1000);
  assert.equal(record.totalFunded, '20547.9000000000');
  assert.equal(record.fundingCount, 1);
  assert.equal(record.recipientAuthorizations[0].allocationCid, 'supplier-allocation-cid');
  assert.equal(record.status, 'DistributionActive');
});

test('prepareDistributionRecipientAuthorization builds a no-funds receiver allocation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://scan.example/registry/allocation-instruction/v2/allocation-factory');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.choiceArguments.inputHoldingCids, []);
    assert.equal(body.choiceArguments.allocation.transferLegSides[0].side, 'ReceiverSide');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        factoryId: 'allocation-factory-cid',
        choiceContext: {
          choiceContextData: { values: { rules: 'rules-cid' } },
          disclosedContracts: [],
        },
      }),
      text: async () => '',
    };
  };
  try {
    const prepared = await prepareDistributionRecipientAuthorization({
      receiverAccount: input.legs[0].receiver,
      payerAccount: input.payerAccount,
      instrumentId: input.instrumentId,
      grossAmount: input.grossAmountPerPeriod,
      grossAmountPerPeriod: input.grossAmountPerPeriod,
      legs: input.legs,
      settlement: {
        executor: input.operator,
        settlementRefId: 'distribution-1:funding:1',
        requestedAt: input.startTime,
      },
      settlementDeadline: new Date('2026-10-20T00:00:00Z'),
      requestedAt: input.startTime,
      registryApiUrl: 'https://scan.example',
      allocationFactoryInterfaceId: 'pkg:AllocationInstructionV2:AllocationFactory',
    });
    assert.equal(prepared.command.ExerciseCommand.choice, 'AllocationFactory_Allocate');
    assert.deepEqual(prepared.settlementLegs, [{ legId: 'supplier', amount: '616.4370000000' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('calculateDistributionAccruedGross counts only complete periods and caps at end', () => {
  const record = decodeDistributionRecord(
    {
      ...buildDistributionCreateArguments({
        ...input,
        endTime: new Date('2026-09-23T00:00:00Z'),
      }),
    },
    'distribution-cid-1',
  );

  assert.equal(
    calculateDistributionAccruedGross(record, new Date('2026-09-21T12:00:00Z')).toFixed(10),
    '684.9300000000',
  );
  assert.equal(
    calculateDistributionAccruedGross(record, new Date('2026-09-30T00:00:00Z')).toFixed(10),
    '2054.7900000000',
  );
});

test('buildDistributionCreateArguments rejects invalid percentage totals', () => {
  assert.throws(
    () =>
      buildDistributionCreateArguments({
        ...input,
        legs: input.legs.map((leg) => ({
          ...leg,
          rule: { type: 'percentage', basisPoints: 4000 },
        })),
      }),
    /must total 10000/,
  );
});

test('prepareDistributionFunding reports the full multi-period wallet commitment', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://scan.example/registry/allocation-instruction/v2/allocation-factory');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.choiceArguments.allocation.transferLegSides, []);
    assert.equal(body.choiceArguments.allocation.nextIterationFunding.Amulet, '20547.9000000000');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        factoryId: 'allocation-factory-cid',
        choiceContext: {
          choiceContextData: { values: { rules: 'rules-cid' } },
          disclosedContracts: [],
        },
      }),
      text: async () => '',
    };
  };
  try {
    const prepared = await prepareDistributionFunding({
      sender: 'Payer::abcdef12',
      payerAccount: input.payerAccount,
      instrumentId: input.instrumentId,
      grossAmount: input.grossAmountPerPeriod,
      grossAmountPerPeriod: input.grossAmountPerPeriod,
      legs: input.legs,
      settlement: {
        executor: input.operator,
        settlementRefId: 'distribution-1:funding:1',
        requestedAt: input.startTime,
      },
      settlementDeadline: new Date('2026-10-20T00:00:00Z'),
      requestedAt: input.startTime,
      inputHoldingCids: ['holding-cid'],
      nextIterationFunding: { Amulet: '20547.90' },
      registryApiUrl: 'https://scan.example',
      allocationFactoryInterfaceId: 'pkg:AllocationV2:AllocationFactory',
    });
    assert.equal(prepared.committedAmount, '20547.9000000000');
    assert.equal(prepared.command.ExerciseCommand.choice, 'AllocationFactory_Allocate');
    assert.equal(
      prepared.command.ExerciseCommand.choiceArgument.extraArgs.context.values.rules,
      'rules-cid',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('prepareDistributionSettlement builds an operator-only canonical batch settle', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://scan.example/registry/allocation/v2/settlement-factory');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        factoryId: 'settlement-factory-cid',
        choiceContext: {
          choiceContextData: { values: { rules: 'rules-cid' } },
          disclosedContracts: [],
        },
      }),
      text: async () => '',
    };
  };
  try {
    const prepared = await prepareDistributionSettlement({
      payerAccount: input.payerAccount,
      instrumentId: input.instrumentId,
      grossAmount: input.grossAmountPerPeriod,
      grossAmountPerPeriod: input.grossAmountPerPeriod,
      legs: input.legs,
      settlement: {
        executor: input.operator,
        settlementRefId: 'distribution-1:funding:1',
        requestedAt: new Date('2026-09-21T00:00:00Z'),
      },
      allocationCid: 'allocation-cid-1',
      recipientAuthorizations: [
        {
          receiver: input.legs[0].receiver,
          authorizationId: 'supplier-authorization',
          allocationCid: 'supplier-allocation-cid',
        },
        {
          receiver: input.legs[1].receiver,
          authorizationId: 'platform-authorization',
          allocationCid: 'platform-allocation-cid',
        },
      ],
      nextIterationFunding: { Amulet: '19862.97' },
      registryApiUrl: 'https://scan.example',
      settlementFactoryInterfaceId: 'pkg:AllocationV2:SettlementFactory',
    });
    const command = prepared.command.ExerciseCommand;
    assert.equal(command.choice, 'SettlementFactory_SettleBatch');
    assert.deepEqual(command.choiceArgument.actors, [input.operator]);
    assert.deepEqual(
      command.choiceArgument.transferLegs.map((leg) => leg.amount),
      ['616.4370000000', '68.4930000000'],
    );
    assert.equal(
      command.choiceArgument.allocations[0].nextIterationFunding.Amulet,
      '19862.9700000000',
    );
    assert.deepEqual(
      command.choiceArgument.allocations[0].extraTransferLegSides.map((leg) => ({
        id: leg.transferLegId,
        side: leg.side,
        amount: leg.amount,
      })),
      [
        { id: 'supplier', side: 'SenderSide', amount: '616.4370000000' },
        { id: 'facilitator-fee', side: 'SenderSide', amount: '68.4930000000' },
      ],
    );
    assert.deepEqual(
      command.choiceArgument.allocations.slice(1).map((allocation) => ({
        cid: allocation.allocationCid,
        next: allocation.nextIterationFunding,
      })),
      [
        { cid: 'supplier-allocation-cid', next: {} },
        { cid: 'platform-allocation-cid', next: {} },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
