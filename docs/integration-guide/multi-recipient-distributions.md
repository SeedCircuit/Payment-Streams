# Multi-Recipient Distribution Streams

Use a distribution stream when one recurring gross payment must be delivered
atomically to two or more destinations. Each destination can receive either a
percentage or a fixed amount per period.

For example, a platform can configure a daily payment of `684.93 CC` as:

| Destination  | Rule | Amount per day |
| ------------ | ---: | -------------: |
| Supplier     |  90% |     616.437 CC |
| Platform fee |  10% |      68.493 CC |

The protocol is generic. The application chooses the recipients and split when
it creates the record.

## When To Use It

Distribution streams require a Token Standard V2 asset. They use:

- `AllocationFactory_Allocate` for payer-approved funding.
- `SettlementFactory_SettleBatch` for atomic multi-recipient settlement.
- `nextIterationFunding` to carry unused runway into the next period.

Use an ordinary single-recipient stream if every payment has only one
destination. V1 assets do not support this atomic iterated batch-settlement
flow.

## Custody And DAR Deployment

The payer's tokens remain in standard Token Standard allocations. The custom
`DistributionStreamRecord` holds no tokens and cannot transfer them.

Only the operator is a stakeholder of the record, so only the operator's
participant needs the Streams DAR. Payers and recipients can remain on other
participants. Their wallets sign or receive standard token operations and do
not need to vet the Streams package.

The operator record is a schedule and reconciliation index. The allocation and
settlement ledger events are the payment source of truth.

## End-To-End Flow

1. The integrating backend creates a `DistributionStreamRecord` with the payer,
   asset, cadence, gross amount, and destination rules.
2. The payer opens the Streams dashboard and chooses the number of periods to
   fund.
3. The proxy prepares `AllocationFactory_Allocate`. The payer reviews and signs
   a committed prefunding allocation in their wallet. Its transfer-leg list is
   empty and the complete funded runway is placed in `nextIterationFunding`.
4. The operator verifies the allocation on-ledger, records the full committed
   amount, allocation contract id, and settlement deadline.
5. Each unique destination account signs a standard no-funds `ReceiverSide`
   allocation. The operator verifies and records every resulting allocation,
   then activates the distribution.
6. After each complete period, the operator prepares and submits
   `SettlementFactory_SettleBatch`. Every destination is paid atomically.
7. The operator records the confirmed update id and every replacement
   allocation id. The final settlement omits `nextIterationFunding` and ends
   all allocation chains. The payer can fund a new runway after that.

The payer and each unique destination account sign once per bounded funding
runway, not once per period. The named executor can release only the transfer
legs authorized by both sides.

The reference proxy exposes the prepare and record boundaries separately. The
dashboard submits payer and receiver commands, but it never treats a wallet
response as ledger proof. A production integration must observe the committed
allocation and settlement updates, extract their contract ids, and call the
service-only record endpoints. An autonomous distribution observer/executor is
not bundled with this initial reference slice.

## Configure The Proxy

```env
PROXY_DISTRIBUTION_OPERATOR=Operator::1220...
DISTRIBUTION_REGISTRY_API_URL=https://scan.example.com
```

`PROXY_DISTRIBUTION_OPERATOR` may be omitted when `PROXY_ESCROW_OPERATOR`
already names the service party hosted by this participant. It is the
non-custodial schedule operator, not the V1 `ESCROW_PARTY`; using the same party
is optional.

The proxy defaults to stable package-name references for the V2 allocation and
settlement interfaces. `V2_ALLOCATION_FACTORY_INTERFACE_ID` and
`V2_SETTLEMENT_FACTORY_INTERFACE_ID` are optional overrides for deployments
that require explicit package ids. `DISTRIBUTION_REGISTRY_TOKEN` is also
optional and should remain unset for a public registry such as CC Scan. Set it
only when the selected asset registry requires bearer authentication.

The participant hosting the operator must upload and vet a `canton-streams`
1.4.0 DAR built against the exact official Token Standard DARs used by the
target network. Follow the network-build procedure in
[Deployment Guide](../DEPLOYMENT.md#1-daml-packages); the package id is produced
by that build and must not be copied from a source-built local artifact. The
payer and destination participants do not need the Streams DAR because their
wallets exercise only standard V2 token interfaces.

## Create A Distribution

Creation is a service-authorized operation because the operator is the sole
signatory of the reconciliation record.

```http
POST /api/distributions
Authorization: Bearer <service-token>
Content-Type: application/json
```

```json
{
  "streamId": "loan-interest-001",
  "payerAccount": { "owner": "Consumer::1220...", "id": "" },
  "instrumentId": { "admin": "AmuletAdmin::1220...", "id": "Amulet" },
  "grossAmountPerPeriod": "684.93",
  "periodSeconds": 86400,
  "startTime": "2026-09-20T00:00:00Z",
  "legs": [
    {
      "legId": "supplier",
      "receiver": { "owner": "Supplier::1220...", "id": "" },
      "rule": { "type": "percentage", "basisPoints": 9000 }
    },
    {
      "legId": "platform-fee",
      "receiver": { "owner": "Platform::1220...", "id": "fees" },
      "rule": { "type": "percentage", "basisPoints": 1000 }
    }
  ]
}
```

Percentage legs must total exactly `10000` basis points. Fixed legs must total
exactly `grossAmountPerPeriod`. Mixing percentage and fixed rules in one
distribution is rejected. Distributions are limited to 25 legs for portable
registry support.

## Fund With The Payer Wallet

The reference dashboard performs this flow. An integrating UI can use the same
API:

```http
POST /api/distributions/<record-cid>/prepare-funding
```

For 30 daily periods, submit one period as `grossAmount` and place the complete
30-period runway in `nextIterationFunding`:

```json
{
  "grossAmount": "684.93",
  "settlementDeadline": "2026-10-20T00:00:00Z",
  "inputHoldingCids": ["<payer-holding-cid>"],
  "nextIterationFunding": { "Amulet": "20547.90" }
}
```

Submit the returned command and disclosed contracts through the payer's wallet.
After the allocation is visible on-ledger, the operator records its contract id
with `POST /api/distributions/<record-cid>/record-funding`. The record request
must contain the confirmed `committedAmount`, `fundingId`, `allocationCid`, and
the same `settlementDeadline` used above.

Choose enough periods for the required runway. The reference implementation
does not merge overlapping live allocations: another wallet funding action is
accepted only after the current allocation chain is fully settled. This avoids
reporting funds from two allocations while tracking only one authoritative
allocation cid. A production integration that needs refill-before-exhaustion
must add and validate a canonical V2 allocation-merge composer first.

## Authorize Each Destination

After payer funding is reconciled, each unique destination account calls:

```http
POST /api/distributions/<record-cid>/prepare-recipient-authorization
Content-Type: application/json

{
  "receiverAccount": { "owner": "Supplier::1220...", "id": "" }
}
```

The returned uncommitted `AllocationFactory_Allocate` command contains only
that account's `ReceiverSide` legs, no input holdings, and no iterative-funding
map. The destination submits it through its own wallet. The operator verifies the
resulting allocation and calls
`POST /api/distributions/<record-cid>/record-recipient-authorization` with the
`receiverAccount`, `authorizationId`, and `allocationCid`.

Repeat this for every unique destination account, then call
`POST /api/distributions/<record-cid>/activate`. A party receiving multiple legs
through the same account signs once; different account ids authorize
separately.

## Settle A Due Period

The operator calls:

```http
POST /api/distributions/<record-cid>/prepare-settlement
Authorization: Bearer <service-token>
Content-Type: application/json

{}
```

The proxy rejects early settlement, inactive records, and exhausted funding.
It returns a `SettlementFactory_SettleBatch` command, choice-context
disclosures, deterministic destination amounts, and the remaining iteration
funding. `allocationOrder` identifies the payer and recipient allocation result
at each result index. The operator submits the command with its configured
signer.

After observing the ledger update, record it:

```http
POST /api/distributions/<record-cid>/record-settlement
Authorization: Bearer <service-token>
Content-Type: application/json
```

```json
{
  "grossAmount": "684.93",
  "settlementId": "<confirmed-update-id>",
  "settledAt": "2026-09-21T00:00:00Z",
  "newAllocationCid": "<replacement-payer-allocation-cid>",
  "newRecipientAllocationCids": {
    "<supplier-authorization-id>": "<replacement-supplier-allocation-cid>",
    "<platform-authorization-id>": "<replacement-platform-allocation-cid>"
  }
}
```

Omit `newAllocationCid` and send an empty `newRecipientAllocationCids` object
after the final settlement. Never advance the operator record from an
unconfirmed wallet response; reconcile every cid from the ordered settlement
results.

## Application Responsibilities

- Authenticate service routes and keep service credentials out of the browser.
- Verify allocation and settlement events before updating the operator record.
- Use deterministic command ids for safe wallet retries; the reference
  dashboard already does this for funding and receiver authorization.
- Match settlement results to the returned `allocationOrder`; never infer a
  recipient replacement cid from list position maintained elsewhere.
- Run settlement idempotently using the record sequence and confirmed update id.
- Monitor funded runway and ask the payer to approve the next runway when the
  current allocation chain is exhausted.
- Display the gross payment, every destination, and the total wallet commitment
  before requesting a signature.
