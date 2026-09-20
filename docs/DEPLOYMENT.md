# Deployment Guide

End-to-end deployment of Canton Payment Streams: Daml packages → REST proxy →
React dashboard. V2 is the preferred CIP-56 token-standard lane; registered
V1 assets can use the transitional allocation lane until they advertise V2.

## Local sandbox (Docker)

The fastest way to run Canton Payment Streams locally:

```bash
docker compose -f docker/docker-compose.yml up -d
```

Brings up:

| Service        | Port                  | Purpose                                 |
| -------------- | --------------------- | --------------------------------------- |
| Canton sandbox | gRPC 5001, Admin 5002 | Single-node participant for development |
| Dashboard      | 3000                  | Nginx-served SPA                        |
| Proxy          | 4000                  | Express REST API                        |

Wallet-backed V2 E2E is tested against the Amulet wallet running on a
separate Splice validator LocalNet with Token Standard V2 support. That
wallet gateway should expose `http://localhost:3030/api/v0/dapp`.

Data persists in the `canton-data` Docker volume. Reset:

```bash
docker compose -f docker/docker-compose.yml down -v
```

## Component deployment

### 1. Daml packages

**Build for local development and CI:**

```bash
pnpm daml:deps
pnpm daml:build
```

This source-build path is reproducible for the repository's isolated sandbox
and tests. Do not upload its `canton-streams-1.4.0.dar` to TestNet or MainNet:
the token-standard dependencies have different package ids from the official
packages already vetted on those networks.

**Build for TestNet or MainNet:**

Copy the exact official Token Standard DARs from the validator release used by
the target network into one directory. Obtain the already-vetted
`canton-streams-interfaces-1.0.0.dar` from the participant when preserving its
package id, then run:

```bash
pnpm daml:build:network -- \
  --network mainnet \
  --official-dir /path/to/target-validator/dars \
  --interfaces-dar /path/to/vetted/canton-streams-interfaces-1.0.0.dar
pnpm daml:upgrade-check
```

The command checks the four direct official Token Standard dependencies,
builds `canton-streams` against their exact package ids, and writes the
deployable DAR plus a dependency manifest to `dist/network/<network>/`. Use
`--network testnet` for TestNet; never reuse that artifact for MainNet. If the Streams
interfaces package has never been vetted on that participant, omit
`--interfaces-dar`; the command builds it and it must be uploaded and vetted
with the main package. The upgrade check reconstructs the deployed 1.3.0
baseline and runs both compiler and participant compatibility validation
against 1.4.0.

Do not use a DAR from the `canton-streams-source-built-test-dars` CI artifact
for network deployment. Selectively vetting the source-built DAR cannot make it
compatible because vetting does not rewrite dependency package ids embedded in
DALF files.

**Upload to a participant:**

```bash
# Via Canton Admin API (gRPC)
DAR=dist/network/mainnet/canton-streams-mainnet-1.4.0-<package-id-prefix>.dar
B64=$(base64 < "$DAR" | tr -d '\n')
printf '{"dars":[{"bytes":"%s"}],"vet_all_packages":false,"synchronize_vetting":true}' "$B64" > /tmp/streams-upload.json
grpcurl -plaintext -max-msg-sz 104857600 \
  -d @ localhost:5002 \
  com.digitalasset.canton.admin.participant.v30.PackageService/UploadDar \
  < /tmp/streams-upload.json

# Or via the daml CLI
daml ledger upload-dar \
  --host localhost --port 5001 \
  dist/network/mainnet/canton-streams-mainnet-1.4.0-<package-id-prefix>.dar
```

**Vet the package on the synchronizer:**

Upload alone is not enough: the participant must also vet the new Streams
package on the synchronizer where streams are created. The official token
packages are already vetted and should not be re-vetted as alternate builds.
Otherwise submissions fail with `UNKNOWN_PACKAGE` even though the DAR is on
disk.

Via the Canton console:

```scala
participant.topology.vetted_packages.propose_delta(
  participant.id,
  adds = Seq(streamsPackage),
  store = SYNCHRONIZER_ID,
  mustFullyAuthorize = true,
  forceFlags = ForceFlags.all,
)
```

Also add the interfaces package only when it is not already vetted. Compare the
package ids in the generated `.dar.json` manifest with the participant's vetted
package set before changing topology.

After upload + vet, capture the new package id:

```bash
export CANTON_STREAMS_PACKAGE_ID=<new-package-hash>
```

### 2. REST proxy

**Build:**

```bash
pnpm --filter @canton-streams/proxy build
```

**Run:**

```bash
node packages/proxy/dist/index.js
```

**Required environment variables (production):**

Set `PROXY_DEPLOYMENT_TARGET=mainnet` for MainNet. This activates the mandatory
startup checks documented in [MainNet readiness](./MAINNET-READINESS.md).

| Variable                    | Default                         | Description                                                    |
| --------------------------- | ------------------------------- | -------------------------------------------------------------- |
| `PROXY_DEPLOYMENT_TARGET`   | (none)                          | Set `mainnet` to enforce the fail-closed MainNet startup profile |
| `PROXY_PORT`                | `4000`                          | Proxy listen port                                              |
| `CANTON_HOST`               | `localhost`                     | Canton ledger API host                                         |
| `CANTON_PORT`               | `5001`                          | Canton ledger API gRPC port                                    |
| `CANTON_USE_TLS`            | `false`                         | Set `true` to use gRPC TLS                                     |
| `CANTON_JSON_API_URL`       | (required for readiness)        | Canton JSON API base URL                                       |
| `CANTON_SYNCHRONIZER_ID`    | (required)                      | Synchronizer/domain id streams are created on                  |
| `CANTON_STREAMS_PACKAGE_ID` | (required)                      | Vetted package id of the canton-streams DAR                    |
| `PROXY_AUTH_MODE`           | `jwt`                           | `jwt` (production) or `dev`; dev requires `PROXY_ALLOW_DEV_AUTH=true` |
| `PROXY_OIDC_ISSUER`         | (none)                          | OIDC issuer URL — required when `PROXY_AUTH_MODE=jwt`          |
| `PROXY_JWT_AUDIENCE`        | (none)                          | Expected JWT audience; required in jwt mode unless explicitly acknowledged with `PROXY_ALLOW_ANY_AUDIENCE=true` |
| `PROXY_SERVICE_TOKEN`       | (none)                          | Service JWT for finalize / auto-withdraw routes                |
| `PROXY_ESCROW_OPERATOR`     | (none)                          | Escrow-operator party id                                       |
| `PROXY_DISTRIBUTION_OPERATOR` | `PROXY_ESCROW_OPERATOR`       | Hosted service party that signs distribution schedule records  |
| `DISTRIBUTION_REGISTRY_API_URL` | `REGISTRY_API_URL`          | V2 token registry base, such as the bare CC Scan host           |
| `DISTRIBUTION_REGISTRY_TOKEN` | (none)                         | Optional bearer token for registries that require authentication |
| `V2_ALLOCATION_FACTORY_INTERFACE_ID` | package-name reference    | Optional explicit AllocationFactory interface override         |
| `V2_SETTLEMENT_FACTORY_INTERFACE_ID` | package-name reference    | Optional explicit SettlementFactory interface override         |
| `ESCROW_DISCLOSED_CUSTODY`  | `false`                         | Set `true` to knowingly run the operator-custodial money-leg when the payer is co-hosted on the operator participant |
| `ESCROW_MAX_TOTAL_CC`       | `0` (uncapped)                  | Aggregate custody cap; deposits past it are rejected with `escrow_cap_exceeded` |
| `ESCROW_SOLVENCY_MONITOR_SECONDS` | `0` (streamer tick)       | Cadence override for the pool-vs-owed drift monitor (`escrow_solvency_drift`); the monitor always runs when the escrow lane is enabled, `0` uses the escrow-streamer tick cadence (10s floor) |
| `PROXY_ALLOW_INSECURE_WALLET_URL` | `false`                   | Allow an `http` wallet-gateway URL on a trusted private network; otherwise a non-loopback gateway URL must be `https` |
| `ALLOWED_ORIGINS`           | (none)                          | CORS allowlist, comma-separated (e.g. `http://localhost:3000`) |
| `LOG_LEVEL`                 | `info`                          | `trace` / `debug` / `info` / `warn` / `error`                  |

**Recommended readiness flags (production):**

| Variable                                                  | Description                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------- |
| `PROXY_STARTUP_REQUIRE_PACKAGE_ENDPOINT=1`                | Fail startup unless the canton-streams package is visible on JSON API |
| `PROXY_STARTUP_REQUIRE_VETTED_PACKAGES=1`                 | Fail startup unless the package is vetted on the synchronizer         |
| `PROXY_STARTUP_REQUIRE_INTERACTIVE_SUBMISSION_ENDPOINT=1` | Fail startup unless `/v2/interactive-submission/prepare` is reachable |
| `PROXY_STARTUP_FAIL_ON_UNKNOWN_PACKAGE_VETTING=1`         | Treat unknown vetting state as fatal                                  |

**Event-driven auto-withdraw:**

The proxy subscribes to `TransferEventsV2` and advances stream state on settlement events instead of polling. To enable:

| Variable                          | Description                                                           |
| --------------------------------- | --------------------------------------------------------------------- |
| `PROXY_TRANSFER_EVENTS_ENABLED=1` | Turn on the V2 events subscriber                                      |
| `PROXY_SERVICE_USER_ID`           | Ledger user id used for interactive submission of `Allocation_Settle` |

Falls back to interactive submission when a participant cannot stream the event directly.

### 3. Provisioning a service principal

Create a dedicated ledger user for the proxy. Never reuse a broad admin JWT.

```bash
node scripts/provision-streams-service.mjs \
  --api-url http://<your-validator>:7575 \
  --admin-token "$PARTICIPANT_ADMIN_TOKEN" \
  --user-id streams-service \
  --primary-party "$PROXY_ESCROW_OPERATOR" \
  --grant-read-as-any-party \
  --act-as "$PROXY_ESCROW_OPERATOR"
```

Recommended production posture:

- Grant `CanReadAsAnyParty` once to avoid per-party read-right sprawl
- Grant `CanActAs` only for the escrow operator and any app-owned co-signing parties the service truly controls
- Do **not** assume the service can submit for arbitrary hybrid-wallet senders — those senders still sign through their own wallet via the CIP-103 flow

### 4. Per-asset configuration

All asset routing lives in `config/asset-registry.json`. Each asset entry
advertises its admin party, Scan endpoint, wallet-gateway URL, token-standard
API URL, and V1/V2 capability flags. The SDK reads this at runtime via
`getAssetCapabilities(...)`, routes V2 when available, and routes the
transitional V1 lane only for assets that explicitly set `allocationsV1`.

```jsonc
{
  "assets": {
    "cc": {
      "key": "cc",
      "displayName": "Canton Coin (Amulet)",
      "instrumentIdV2": {
        "admin": "DSO::1220...",
        "id": "Amulet"
      },
      "adminParty": "DSO::1220...",
      "scanEndpointUrl": "https://scan.canton.network",
      "walletGatewayUrl": "https://wallet.example.com/api/v0/dapp",
      "tokenStandardApiUrl": "https://scan.canton.network",
      "allocationsV2": true,
      "allocationsV1": false,
      "transferEventsV2": true
    }
  }
}
```

Updating the registry does not require an SDK release; the proxy and dashboard read the file on startup.

The proxy's configured wallet-gateway URL (`CANTON_STREAMS_WALLET_GATEWAY_URL` / `WALLET_GATEWAY_URL`) must be `https` (loopback hosts excepted); a plaintext `http` gateway fails closed at client construction unless `PROXY_ALLOW_INSECURE_WALLET_URL=true` is set for a trusted private network. The per-asset registry `walletGatewayUrl` field itself is validated only as a non-empty string.

### 5. Dashboard

**Build:**

```bash
pnpm --filter @canton-streams/dashboard build
```

Output `packages/dashboard/dist/` is a static SPA. Serve via Nginx, Caddy, S3+CloudFront, or any static host.

**Nginx example (matches the Docker setup):**

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

**Dashboard build-time environment variables (Vite):**

| Variable                  | Default                             | Description                                         |
| ------------------------- | ----------------------------------- | --------------------------------------------------- |
| `VITE_PROXY_URL`          | `/` (Vite dev proxy)                | Proxy base URL when not co-served                   |
| `VITE_WALLET_GATEWAY_URL` | `http://localhost:3030/api/v0/dapp` | CIP-103 wallet gateway endpoint                     |
| `VITE_SKIP_WALLET_PICKER` | `false`                             | Auto-select the remote wallet without picker UI     |
| `VITE_WC_PROJECT_ID`      | (none)                              | WalletConnect / Reown project id (optional adapter) |

Template: `packages/dashboard/.env.example`. Never commit `.env.local` (gitignored).

### 6. Amulet wallet gateway

The dashboard talks to any [CIP-103](https://github.com/canton-foundation/cips/blob/main/cip-0103/cip-0103.md)-compliant wallet via `@canton-network/dapp-sdk`. For local Token Standard V2 flows, use the Amulet wallet that runs on a Splice validator LocalNet and expose it through a wallet gateway.

1. Build/start a Splice LocalNet with the validator Amulet wallet enabled
2. Confirm the Amulet wallet gateway is listening on `:3030`
3. Allow the dashboard origin (`http://localhost:3000`) in the wallet gateway config
4. Open the dashboard — Connect Wallet → Amulet login → authenticated

For end-to-end wallet validation, see [E2E-HARNESS.md](E2E-HARNESS.md).

## Production considerations

### TLS

Canton's gRPC API supports TLS. In `canton.conf`:

```hocon
canton.participants.participant.ledger-api {
  tls {
    cert-chain-file = "/path/to/server.crt"
    private-key-file = "/path/to/server.key"
  }
}
```

Set `CANTON_USE_TLS=true` on the proxy.

### Authentication

Set `PROXY_AUTH_MODE=jwt` and configure OIDC:

```bash
export PROXY_AUTH_MODE=jwt
export PROXY_OIDC_ISSUER=https://your-auth-provider.com
export PROXY_JWT_AUDIENCE=https://canton.network.global
```

The proxy:

1. Fetches the OIDC discovery document from `${issuer}/.well-known/openid-configuration`
2. Caches the JWKS for JWT signature verification
3. Verifies every request's Bearer token (signature, issuer, audience, expiry)
4. Reads identity from the JWT `party` (or `sub`) claim — no separate party header required

### Package id management

When DARs are redeployed (new code version), the package id changes. Update:

```bash
export CANTON_STREAMS_PACKAGE_ID=<new-package-hash>
```

The SDK's template registry reads this at startup. Restart the proxy for the change to take effect.

### Health checks

| Check           | Command                                                         |
| --------------- | --------------------------------------------------------------- |
| Proxy           | `curl http://localhost:4000/api/health`                         |
| Canton gRPC     | `grpcurl -plaintext localhost:5001 grpc.health.v1.Health/Check` |
| Canton JSON API | `curl http://localhost:7575/v2/version`                         |
| Dashboard       | `curl -I http://localhost:3000/`                                |

### Monitoring

The proxy logs all requests as structured JSON (pino). Connect to your log aggregator.

Key metrics:

- Request latency per endpoint
- gRPC error rates (PERMISSION_DENIED, UNAVAILABLE, DEADLINE_EXCEEDED)
- Active stream count
- `TransferEventsV2` subscriber lag
- Auto-withdraw success / failure rate per stream

## Validation probes

| Script                                   | Purpose                                                |
| ---------------------------------------- | ------------------------------------------------------ |
| `scripts/devnet-smoke.sh`                | End-to-end lifecycle on a local sandbox                |
| `scripts/testnet-cc-stream-probe.mjs`    | CC / Amulet stream against a real validator            |
| `scripts/testnet-usdcx-stream-probe.mjs` | USDCx stream against a real validator                  |
| `scripts/testnet-v2-stream-probe.mjs`    | V2-native asset against a V2 validator                 |
| `scripts/query-adoption-metrics.mjs`     | Aggregate adoption metrics across asset Scan endpoints |
| `scripts/check-tunnel.sh`                | Detect a local sandbox shadowing an SSH tunnel port    |

Local-environment defaults for the probes can live in `config/local.<env>.json` (gitignored). A template is in `config/local.testnet.example.json`.

```bash
cp config/local.testnet.example.json config/local.testnet.json
export CANTON_STREAMS_LOCAL_CONFIG=./config/local.testnet.json
```

Keep secrets in env vars, never in the JSON config file.

## Upgrade and migration

For breaking changes between releases, see [CHANGELOG.md](../CHANGELOG.md).

## See also

For running the system day to day — health and readiness, SLOs, backup and
restore of stateful files, incident runbooks, upgrade/rollback, and on-call
ownership — see [OPERATIONS.md](OPERATIONS.md).
