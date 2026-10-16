import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  assertActionSupported,
  getAssetCapabilities,
  resolveSettlementVersion,
} from '../../src/assets/capabilities.js';
import { loadAssetRegistry } from '../../src/assets/registry.js';

const registryPath = fileURLToPath(new URL('../../../../config/asset-registry.json', import.meta.url));
const registry = loadAssetRegistry(JSON.parse(readFileSync(registryPath, 'utf8')));

describe('committed asset registry', () => {
  it('routes USDCx on the V2 lane by default', () => {
    const caps = getAssetCapabilities(registry, 'usdcx');
    expect(caps.allocationsV2).toBe(true);
    expect(resolveSettlementVersion(caps)).toBe('v2');
  });

  it('allows the V2-only USDCx actions', () => {
    const caps = getAssetCapabilities(registry, 'usdcx');
    expect(() => assertActionSupported(caps, 'allocation-iterated')).not.toThrow();
    expect(() => assertActionSupported(caps, 'allocation-batch')).not.toThrow();
  });

  it('keeps an explicit V1 pin working for USDCx while its registry serves V1', () => {
    const caps = getAssetCapabilities(registry, 'usdcx');
    expect(resolveSettlementVersion(caps, 'v1')).toBe('v1');
  });

  it('does not claim USDCx transfer events, which its registry does not advertise', () => {
    const caps = getAssetCapabilities(registry, 'usdcx');
    expect(() => assertActionSupported(caps, 'event-subscription')).toThrow(/TransferEventsV2/);
  });

  it('resolves USDCx by its on-ledger instrument id', () => {
    const usdcx = registry.requireAsset('usdcx');
    const caps = getAssetCapabilities(registry, usdcx.instrumentIdV2);
    expect(caps.key).toBe('usdcx');
    expect(resolveSettlementVersion(caps)).toBe('v2');
  });

  it('leaves CC on the transitional V1 lane', () => {
    expect(resolveSettlementVersion(getAssetCapabilities(registry, 'cc'))).toBe('v1');
  });
});
