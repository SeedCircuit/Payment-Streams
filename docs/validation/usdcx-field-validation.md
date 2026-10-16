# USDCx field validation

> **Status (2026-10-16):** USDCx publishes the CIP-56 V2 token standard on
> TestNet and MainNet, and Canton Payment Streams routes it on V2. Its registry
> advertises `holding-v2`, `transfer-instruction-v2`,
> `allocation-instruction-v2` and `allocation-v2`, alongside the V1 APIs it
> still serves. It does not advertise a transfer-events API or a
> transfer-preapproval API. The full V2 path is proven live on TestNet against
> the same DA Utility registry that issues USDCx (§4). One step remains: a run
> with USDCx itself, which needs a party we control to own unlocked USDCx (§5).

## 1. Code-path parity with CC

USDCx and Canton Coin share one code path. Only registry routing data differs:
the SDK never branches by asset name, only by capability flags, and the proxy
picks each asset's registry from its instrument.

| Layer | Shared component | Per-asset difference |
| --- | --- | --- |
| Capability routing | `packages/sdk/src/assets/capabilities.ts` (`resolveSettlementVersion`, `assertActionSupported`) | `allocationsV2` / `allocationsV1` / `transferEventsV2` flags in `config/asset-registry.json` |
| Proxy asset whitelist | `packages/proxy/src/assets.ts` | `USDCX_*` env: admin, registry base, holding template, transfer version |
| Transfers | `prepareSettleCommandV2` / `prepareSettleCommand` in `packages/proxy/src/v1-lane.ts` | registry base and version, fixed per stream at creation |
| Distributions | `packages/proxy/src/distribution.ts` + `resolveInstrumentRegistry` | registry base resolved from the record's instrument |
| Holdings | `senderHoldings` / `escrowOwnedHoldings` | concrete holding template; holdings matched to the instrument's id and admin |
| Choice contexts | registry endpoints under `/registry/...` | base URL: Scan for Amulet, the registrar-scoped utility base for USDCx |

Behavioural differences to expect, all wire-compatible:

- **No pre-approval.** A direct USDCx transfer always lands as an offer the
  recipient accepts. The proxy keeps one offer per stream outstanding and
  reconciles accepts and reclaims from the ledger before offering the next
  cycle. For recurring payments, use a
  [distribution](../integration-guide/multi-recipient-distributions.md): the
  recipient authorizes once per funded runway.
- **Shared holding template.** `utility-registry-holding-v0` holds every token
  its registry issues, so a party can hold many unrelated instruments under it.
  Holdings are matched to the instrument before they are spent, and large
  holding sets are read over the participant's WebSocket stream, past the
  HTTP list cap.
- **Empty iteration funding.** A USDCx allocation with no iteration funding
  reports `nextIterationFunding: {}` where Canton Coin reports `null`.
- **Off Scan.** USDCx transfers are not indexed by Canton Coin's Scan. The
  proxy confirms USDCx accepts and reclaims on its own participant, reading as
  whichever stream party it hosts, and refuses to record them otherwise.
- **Fees.** Record observed before/after balances; do not assume zero.

## 2. What is validated

| Item | Evidence |
| --- | --- |
| Registry advertises V2 | `GET {registry}/registry/metadata/v1/info` on TestNet staging and MainNet (2026-10-16); V2 factories answer `422` to an empty body (present) |
| SDK routing | `packages/sdk/test/assets/committed-registry.test.ts`: the committed registry routes `usdcx` to V2, permits `allocation-iterated` and `allocation-batch`, keeps an explicit V1 pin working, and refuses `event-subscription` |
| Proxy routing | `packages/proxy/test/assets.test.mjs`: per-instrument registry resolution, fallback token isolation, offer-accept routing |
| Large holding sets | `packages/proxy/test/acs-stream.test.mjs`: WebSocket fallback past the 200-row cap; error frames and abnormal closes reject |
| Offer lifecycle | same file: holding-to-instrument matching, accept vs withdraw classification |
| Live V2 path | §4 |

## 3. Per-network routing (committed real values)

The `usdcx` entry carries the Circle xReserve / Digital Asset published
routing. Fields hold the **TestNet** values; `meta.mainnet` holds MainNet.

| Field | TestNet (entry) | MainNet (`meta.mainnet`) |
|---|---|---|
| `instrumentIdV2.id` | `USDCx` | `USDCx` |
| `instrumentIdV2.admin` / `adminParty` | `decentralized-usdc-interchain-rep::122049e2af8a725bd19759320fc83c638e7718973eac189d8f201309c512d1ffec61` | `decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef` |
| `tokenStandardApiUrl` | `https://api.utilities.digitalasset-staging.com` | `https://api.utilities.digitalasset.com` |
| `scanEndpointUrl` | `https://scan.sv-1.test.global.canton.network.sync.global` | `https://scan.sv-1.global.canton.network.sync.global` |

The token-standard registry sits under a registrar-scoped prefix:
`{tokenStandardApiUrl}/api/token-standard/v0/registrars/{admin}/registry/...`.
That full base is what `USDCX_REGISTRY_API_URL` must hold. Only
`walletGatewayUrl` stays operator-specific.

## 4. Live V2 run on TestNet

No party we control owns unlocked USDCx, so the run used **BIT**, a token
issued by `bitdynamicsab-testnet-1` on the same DA Utility registry. It has the
identical `supportedApis`, the same `utility-registry-holding-v0` template and
the same registrar-scoped API. BIT was placed in the proxy's `usdcx` slot
(`USDCX_ADMIN_PARTY`, `USDCX_INSTRUMENT_ID=BIT`, its registry base,
`USDCX_TRANSFER_VERSION=v2`), so every call took the USDCx code path. The run
used an isolated proxy instance with its own state.

| Scenario | Result |
| --- | --- |
| Two-recipient 90/10 distribution: fund, both recipients authorize, activate, `SettlementFactory_SettleBatch` | Supplier +9, fee +1 BIT, atomically; record reconciled (`settlementCount 1`, `AwaitingFunding`). Settle update `122057e5c99e246c0181ccb80bd1994cfd40f6317d17242ffbaa70f63aa8dd003044` |
| Same distribution in Canton Coin (regression) | Supplier +0.9, fee +0.1 CC; registry fell back to Scan. Settle update `12207c854cd435644619a26f1a0d2e268446f43997f80589ce51ea93ae83c9d065c5` |
| Distribution with an unconfigured instrument | Refused, `400 distribution_asset_unsupported` |
| V2 transfer stream: settle | Payer's holdings (over 300 under the shared template) read past the cap and filtered to BIT; V2 transfer committed as a pending offer |
| Recipient inbox, then accept | Offer listed with V2 account parties; accept routed to the token's registry; recipient +2 BIT |
| Settle again while an offer is live | Refused (`pending_acceptance`); no second offer |
| Offer accepted outside the stream, then settle | Reconciled from the ledger: cycle credited with the accept's update id; next cycle offered |
| Offer reclaimed without recording it, then settle | Reconciled as returned, nothing credited; the cycle re-offered under a fresh command id |
| Recording an accept as a reclaim | Refused (`settlement_mismatch`) |

## 5. Remaining: a run with USDCx itself

Blocked on a party hosted on our participant that **owns** unlocked USDCx.
Most USDCx a wallet shows is registrar-custodied and only observed, which
cannot fund a transfer or allocation. Once such a party exists:

1. Confirm it owns unlocked USDCx: query `#utility-registry-holding-v0:Utility.Registry.Holding.V0.Holding:Holding`
   for the party (over the WebSocket ACS stream if it holds many) and keep rows
   with `owner` equal to the party, `lock` null and `instrument.id` `USDCx`.
2. Run the two-recipient distribution from §4 with `instrumentId`
   `{ admin: <usdcx admin>, id: "USDCx" }` and record the settle update id and
   both recipients' balance deltas, including any issuer fee.
3. Run one direct stream cycle and accept it, recording the same.

## 6. V1 lane

USDCx still serves the V1 APIs, so a stream created before the switch keeps
its V1 version and continues to settle. New streams take the version in
`USDCX_TRANSFER_VERSION`. The V1 lane itself is documented in
[V1-LANE-TESTING.md](../V1-LANE-TESTING.md).
