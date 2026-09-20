# MainNet readiness

MainNet deployment is a controlled release decision, not a different build
mode. The proxy provides a strict startup profile, but a successful startup
does not replace independent review or validator approval.

## Automated release gates

Set `PROXY_DEPLOYMENT_TARGET=mainnet`. The proxy then refuses to bind unless:

- JWT authentication has an HTTPS issuer and an enforced audience.
- Node runs in production mode and the service credential is high entropy.
- Browser origins are explicit HTTPS origins.
- Remote participant traffic uses TLS; colocated loopback traffic is allowed.
- the JSON API, synchronizer, service identity, registry, and Streams package
  are explicitly configured, including the exact 64-hex Streams package id.
- package visibility, package vetting, unknown-vetting failure, and interactive
  submission startup probes are enabled.
- rate limiting is enabled and insecure wallet/token overrides are disabled.
- auto-withdraw uses a production `SigningProvider`, with no private keys in
  the proxy environment.
- a custodial V1 escrow lane, when enabled, has disclosed custody, a positive
  CC exposure cap, and an explicit solvency-monitor interval.

Build the deployable DAR from the exact official DARs used by the target
validator release:

```bash
pnpm daml:build:network -- \
  --network mainnet \
  --official-dir /path/to/mainnet-validator/dars \
  --interfaces-dar /path/to/vetted/canton-streams-interfaces-1.0.0.dar
pnpm daml:upgrade-check
```

The artifact and dependency manifest are written under
`dist/network/mainnet/`. Record the DAR hash, package id, dependency hashes,
validator release, and synchronizer id in the release evidence.

Run the repository gates before deployment:

```bash
pnpm lint
pnpm build
pnpm test
pnpm daml:test
bash scripts/check-v2-conformance.sh
docker build -f docker/Dockerfile.dashboard .
docker build -f docker/Dockerfile.proxy .
```

## Required external approvals

The repository cannot self-certify these gates:

- an independent Daml/Canton security review of the release commit and DAR;
- remediation or explicit risk acceptance for every material finding;
- validator approval, upload, and vetting of the exact manifest package id;
- production key-management, backup, monitoring, incident-response, and
  rollback sign-off;
- a capped MainNet canary with reconciliation against Scan before limits are
  increased.

The `PruneExecutionLog` controller was intentionally tightened from sender-only
to sender plus executor. If the target validator or compiler reports an
upgraded-choice-expression warning, do not remove the second controller merely
to silence it. Record the independent review and validator operator's approval
of the migration impact for existing contracts.

## Go/no-go evidence

Do not open unrestricted MainNet access until the evidence pack contains the
green CI run, network DAR manifest, upgrade-check output, external review,
vetting confirmation, restore test, and canary settlement/reconciliation
results. TestNet success alone is not MainNet approval.
