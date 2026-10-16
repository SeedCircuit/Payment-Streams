import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getSupportedAssets,
  resolveAssetForInstrument,
  resolveInstrumentRegistry,
} from '../dist/assets.js';
import { accountParty, registryBaseForInstrument } from '../dist/v1-lane.js';

const CC_ADMIN = 'DSO::1220aa';
const USDCX_ADMIN = 'decentralized-usdc-interchain-rep::1220bb';
const USDCX_REGISTRY =
  'https://api.utilities.example/api/token-standard/v0/registrars/decentralized-usdc-interchain-rep::1220bb';
const SCAN = 'https://scan.example';

const ENV_KEYS = [
  'CC_ADMIN_PARTY',
  'CANTON_CC_ADMIN',
  'TRANSFER_VERSION',
  'USDCX_ADMIN_PARTY',
  'USDCX_REGISTRY_API_URL',
  'USDCX_TRANSFER_VERSION',
  'USDCX_HOLDING_TEMPLATE_ID',
];

function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const deployment = {
  CC_ADMIN_PARTY: CC_ADMIN,
  TRANSFER_VERSION: 'v2',
  USDCX_ADMIN_PARTY: USDCX_ADMIN,
  USDCX_REGISTRY_API_URL: `${USDCX_REGISTRY}/`,
  USDCX_TRANSFER_VERSION: 'v2',
  USDCX_HOLDING_TEMPLATE_ID: '#utility-registry-holding-v0:Utility.Registry.Holding.V0.Holding:Holding',
};

test('USDCx follows USDCX_TRANSFER_VERSION', () => {
  withEnv(deployment, () => {
    assert.equal(getSupportedAssets().find((a) => a.key === 'usdcx').transferVersion, 'v2');
  });
  withEnv({ ...deployment, USDCX_TRANSFER_VERSION: 'v1' }, () => {
    assert.equal(getSupportedAssets().find((a) => a.key === 'usdcx').transferVersion, 'v1');
  });
});

test('an instrument resolves only by its exact admin and id', () => {
  withEnv(deployment, () => {
    assert.equal(resolveAssetForInstrument({ admin: USDCX_ADMIN, id: 'USDCx' }).key, 'usdcx');
    assert.equal(resolveAssetForInstrument({ admin: CC_ADMIN, id: 'Amulet' }).key, 'cc');
    assert.equal(resolveAssetForInstrument({ admin: CC_ADMIN, id: 'USDCx' }), undefined);
    assert.equal(resolveAssetForInstrument({ admin: 'Other::1220cc', id: 'USDCx' }), undefined);
  });
});

test('USDCx routes to its own registry, never the fallback', () => {
  withEnv(deployment, () => {
    const route = resolveInstrumentRegistry(
      { admin: USDCX_ADMIN, id: 'USDCx' },
      { url: SCAN, token: 'scan-secret' },
    );
    assert.equal(route.registryApiUrl, USDCX_REGISTRY);
    assert.equal(route.registryToken, undefined);
  });
});

test('CC routes to the fallback registry with its token', () => {
  withEnv(deployment, () => {
    const route = resolveInstrumentRegistry(
      { admin: CC_ADMIN, id: 'Amulet' },
      { url: SCAN, token: 'scan-secret' },
    );
    assert.equal(route.registryApiUrl, SCAN);
    assert.equal(route.registryToken, 'scan-secret');
  });
});

test('an unconfigured instrument has no registry route', () => {
  withEnv(deployment, () => {
    assert.equal(
      resolveInstrumentRegistry({ admin: 'Other::1220cc', id: 'TKN' }, { url: SCAN }),
      undefined,
    );
  });
  withEnv({ CC_ADMIN_PARTY: CC_ADMIN }, () => {
    assert.equal(
      resolveInstrumentRegistry({ admin: USDCX_ADMIN, id: 'USDCx' }, { url: SCAN }),
      undefined,
    );
  });
});

test('an offer accept routes to the offer asset registry', () => {
  withEnv(deployment, () => {
    assert.equal(registryBaseForInstrument({ admin: USDCX_ADMIN, id: 'USDCx' }), USDCX_REGISTRY);
    assert.equal(registryBaseForInstrument({ admin: CC_ADMIN, id: 'Amulet' }), undefined);
    assert.equal(registryBaseForInstrument({ admin: 'Other::1220cc', id: 'TKN' }), undefined);
  });
});

test('accountParty reads V1 parties and V2 accounts', () => {
  assert.equal(accountParty('Alice::1220dd'), 'Alice::1220dd');
  assert.equal(accountParty({ owner: 'Alice::1220dd', provider: null, id: '' }), 'Alice::1220dd');
  assert.equal(accountParty({ provider: 'P::1' }), '');
  assert.equal(accountParty(undefined), '');
  assert.equal(accountParty(42), '');
});
