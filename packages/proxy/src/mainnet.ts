import { isProductionProvider, type SigningProviderKind } from '@canton-streams/sdk';
import type { AuthConfig } from './auth.js';
import { parseBoolean, type ReadinessConfig } from './readiness.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function assertMainnetSigningProviderSafe(
  env: NodeJS.ProcessEnv,
  kind: SigningProviderKind,
): void {
  if (
    String(env['PROXY_DEPLOYMENT_TARGET'] ?? '').trim().toLowerCase() === 'mainnet' &&
    !isProductionProvider(kind)
  ) {
    throw new Error(`Refusing MainNet signing with provider ${kind}`);
  }
}

function configured(env: NodeJS.ProcessEnv, name: string): boolean {
  return String(env[name] ?? '').trim().length > 0;
}

function secureUrl(value: string | undefined, allowLoopback: boolean): boolean {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'https:' ||
      (allowLoopback && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

export function assertMainnetConfigSafe(
  env: NodeJS.ProcessEnv,
  auth: AuthConfig,
  readiness: ReadinessConfig,
): void {
  const target = String(env['PROXY_DEPLOYMENT_TARGET'] ?? '').trim().toLowerCase();
  if (!target || target === 'local' || target === 'testnet') return;
  if (target !== 'mainnet') {
    throw new Error(`Unsupported PROXY_DEPLOYMENT_TARGET: ${target}`);
  }

  const failures: string[] = [];
  const requireSetting = (condition: boolean, message: string) => {
    if (!condition) failures.push(message);
  };

  requireSetting(env['NODE_ENV'] === 'production', 'set NODE_ENV=production');
  requireSetting(auth.mode === 'jwt' && auth.requestedMode === 'jwt', 'use PROXY_AUTH_MODE=jwt');
  requireSetting(Boolean(auth.jwtAudience), 'set PROXY_JWT_AUDIENCE');
  requireSetting(
    secureUrl(auth.oidcIssuer ?? auth.jwtIssuer ?? undefined, false),
    'use an HTTPS PROXY_OIDC_ISSUER or PROXY_JWT_ISSUER',
  );
  requireSetting(
    !auth.audienceUnenforcedAcknowledged,
    'remove PROXY_ALLOW_ANY_AUDIENCE',
  );
  requireSetting(!parseBoolean(env['PROXY_ALLOW_DEV_AUTH'], false), 'remove PROXY_ALLOW_DEV_AUTH');

  const cantonHost = String(env['CANTON_HOST'] ?? 'localhost').trim();
  requireSetting(
    parseBoolean(env['CANTON_USE_TLS'], false) || LOOPBACK_HOSTS.has(cantonHost),
    'set CANTON_USE_TLS=true for a non-loopback participant',
  );
  requireSetting(
    !parseBoolean(env['CANTON_ALLOW_INSECURE_TOKEN'], false),
    'remove CANTON_ALLOW_INSECURE_TOKEN',
  );
  requireSetting(
    secureUrl(readiness.jsonApiUrl, true),
    'set CANTON_JSON_API_URL to HTTPS or a loopback URL',
  );
  requireSetting(configured(env, 'CANTON_SYNCHRONIZER_ID'), 'set CANTON_SYNCHRONIZER_ID');

  const origins = String(env['ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  requireSetting(origins.length > 0, 'set ALLOWED_ORIGINS');
  requireSetting(
    origins.every((origin) => secureUrl(origin, false)),
    'use only HTTPS ALLOWED_ORIGINS',
  );

  requireSetting(
    /^[a-f0-9]{64}$/i.test(String(env['CANTON_STREAMS_PACKAGE_ID'] ?? '').trim()),
    'set CANTON_STREAMS_PACKAGE_ID to the exact 64-hex MainNet package id',
  );
  requireSetting(readiness.requirePackageEndpoint, 'enable PROXY_STARTUP_REQUIRE_PACKAGE_ENDPOINT');
  requireSetting(readiness.requireVettedPackages, 'enable PROXY_STARTUP_REQUIRE_VETTED_PACKAGES');
  requireSetting(
    readiness.failOnUnknownPackageVetting,
    'enable PROXY_STARTUP_FAIL_ON_UNKNOWN_PACKAGE_VETTING',
  );
  requireSetting(
    readiness.requireInteractiveSubmissionEndpoint,
    'enable PROXY_STARTUP_REQUIRE_INTERACTIVE_SUBMISSION_ENDPOINT',
  );

  requireSetting(
    String(auth.serviceToken ?? '').trim().length >= 32,
    'set PROXY_SERVICE_TOKEN to a high-entropy value of at least 32 characters',
  );
  requireSetting(Boolean(auth.escrowOperator), 'set PROXY_ESCROW_OPERATOR');
  requireSetting(
    secureUrl(
      env['DISTRIBUTION_REGISTRY_API_URL'] ?? env['REGISTRY_API_URL'],
      false,
    ),
    'set DISTRIBUTION_REGISTRY_API_URL or REGISTRY_API_URL to HTTPS',
  );
  requireSetting(
    !parseBoolean(env['PROXY_RATE_LIMIT_DISABLE'], false),
    'keep the proxy rate limiter enabled',
  );
  requireSetting(
    !parseBoolean(env['PROXY_ALLOW_INSECURE_WALLET_URL'], false),
    'remove PROXY_ALLOW_INSECURE_WALLET_URL',
  );

  const localKeyVariables = [
    'CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON',
    'PROXY_ESCROW_OPERATOR_PRIVATE_KEY',
    'PROXY_ESCROW_OPERATOR_PRIVATE_KEY_FILE',
    'ESCROW_OPERATOR_PRIVATE_KEY',
    'ESCROW_OPERATOR_PRIVATE_KEY_FILE',
  ];
  requireSetting(
    !localKeyVariables.some((name) => configured(env, name)),
    'remove in-process wallet private keys and use a production SigningProvider',
  );
  if (parseBoolean(env['PROXY_TOKEN_STANDARD_AUTOWITHDRAW_ENABLED'], false)) {
    requireSetting(
      parseBoolean(env['PROXY_AUTO_WITHDRAW_USE_SIGNING_PROVIDER'], false),
      'enable PROXY_AUTO_WITHDRAW_USE_SIGNING_PROVIDER for auto-withdraw',
    );
  }

  if (configured(env, 'ESCROW_PARTY')) {
    requireSetting(
      parseBoolean(env['ESCROW_DISCLOSED_CUSTODY'], false),
      'set ESCROW_DISCLOSED_CUSTODY=true for the custodial escrow lane',
    );
    requireSetting(
      Number(env['ESCROW_MAX_TOTAL_CC'] ?? 0) > 0,
      'set a positive ESCROW_MAX_TOTAL_CC custody cap',
    );
    requireSetting(
      Number(env['ESCROW_SOLVENCY_MONITOR_SECONDS'] ?? 0) > 0,
      'set a positive ESCROW_SOLVENCY_MONITOR_SECONDS interval',
    );
  }

  if (failures.length > 0) {
    throw new Error(`Refusing MainNet startup:\n- ${failures.join('\n- ')}`);
  }
}
