import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAuthConfig } from '../dist/auth.js';
import {
  assertMainnetConfigSafe,
  assertMainnetSigningProviderSafe,
} from '../dist/mainnet.js';
import { createReadinessConfig } from '../dist/readiness.js';

function validMainnetEnv() {
  return {
    PROXY_DEPLOYMENT_TARGET: 'mainnet',
    NODE_ENV: 'production',
    PROXY_AUTH_MODE: 'jwt',
    PROXY_OIDC_ISSUER: 'https://identity.example',
    PROXY_JWT_AUDIENCE: 'canton-streams',
    PROXY_SERVICE_TOKEN: '0123456789abcdef0123456789abcdef',
    PROXY_ESCROW_OPERATOR: 'operator::1220',
    CANTON_HOST: 'localhost',
    CANTON_JSON_API_URL: 'http://localhost:7575',
    CANTON_SYNCHRONIZER_ID: 'global-domain::1220',
    CANTON_STREAMS_PACKAGE_ID: 'a'.repeat(64),
    ALLOWED_ORIGINS: 'https://streams.example',
    REGISTRY_API_URL: 'https://scan.canton.network',
    PROXY_STARTUP_REQUIRE_PACKAGE_ENDPOINT: 'true',
    PROXY_STARTUP_REQUIRE_VETTED_PACKAGES: 'true',
    PROXY_STARTUP_FAIL_ON_UNKNOWN_PACKAGE_VETTING: 'true',
    PROXY_STARTUP_REQUIRE_INTERACTIVE_SUBMISSION_ENDPOINT: 'true',
  };
}

function parseWithEnv(env) {
  const original = process.env;
  process.env = env;
  try {
    return parseAuthConfig();
  } finally {
    process.env = original;
  }
}

test('accepts a fail-closed MainNet configuration', () => {
  const env = validMainnetEnv();
  const auth = parseWithEnv(env);
  const readiness = createReadinessConfig(env, auth.serviceToken ?? undefined);
  assert.doesNotThrow(() => assertMainnetConfigSafe(env, auth, readiness));
});

test('rejects an unsafe MainNet configuration with all actionable failures', () => {
  const env = {
    ...validMainnetEnv(),
    PROXY_AUTH_MODE: 'dev',
    PROXY_ALLOW_DEV_AUTH: 'true',
    PROXY_ALLOW_ANY_AUDIENCE: 'true',
    PROXY_JWT_AUDIENCE: '',
    CANTON_HOST: 'participant.internal',
    CANTON_USE_TLS: 'false',
    ALLOWED_ORIGINS: 'http://streams.example',
    PROXY_STARTUP_REQUIRE_VETTED_PACKAGES: 'false',
    PROXY_ESCROW_OPERATOR_PRIVATE_KEY: 'secret',
  };
  const auth = parseWithEnv(env);
  const readiness = createReadinessConfig(env, auth.serviceToken ?? undefined);

  assert.throws(
    () => assertMainnetConfigSafe(env, auth, readiness),
    (error) => {
      assert.match(error.message, /use PROXY_AUTH_MODE=jwt/);
      assert.match(error.message, /set PROXY_JWT_AUDIENCE/);
      assert.match(error.message, /set CANTON_USE_TLS=true/);
      assert.match(error.message, /use only HTTPS ALLOWED_ORIGINS/);
      assert.match(error.message, /enable PROXY_STARTUP_REQUIRE_VETTED_PACKAGES/);
      assert.match(error.message, /remove in-process wallet private keys/);
      return true;
    },
  );
});

test('requires explicit custody controls when the MainNet escrow lane is enabled', () => {
  const env = { ...validMainnetEnv(), ESCROW_PARTY: 'escrow::1220' };
  const auth = parseWithEnv(env);
  const readiness = createReadinessConfig(env, auth.serviceToken ?? undefined);

  assert.throws(
    () => assertMainnetConfigSafe(env, auth, readiness),
    /set ESCROW_DISCLOSED_CUSTODY=true[\s\S]*set a positive ESCROW_MAX_TOTAL_CC[\s\S]*set a positive ESCROW_SOLVENCY_MONITOR_SECONDS/,
  );
});

test('does not apply MainNet-only requirements to local and TestNet deployments', () => {
  const env = { PROXY_DEPLOYMENT_TARGET: 'testnet' };
  const auth = parseWithEnv(env);
  const readiness = createReadinessConfig(env);
  assert.doesNotThrow(() => assertMainnetConfigSafe(env, auth, readiness));
});

test('rejects the dev-only wallet gateway signing provider on MainNet', () => {
  assert.throws(
    () => assertMainnetSigningProviderSafe(
      { PROXY_DEPLOYMENT_TARGET: 'mainnet' },
      'wallet-gateway-internal',
    ),
    /Refusing MainNet signing with provider wallet-gateway-internal/,
  );
  assert.doesNotThrow(() => assertMainnetSigningProviderSafe(
    { PROXY_DEPLOYMENT_TARGET: 'mainnet' },
    'participant',
  ));
});
