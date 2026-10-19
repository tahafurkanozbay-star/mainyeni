import { describe, expect, it } from 'vitest';
import {
  buildTomTomTrafficFlowTileUrl,
  buildTomTomTrafficFlowUrlTemplate,
  normalizeTomTomTrafficApiKey,
} from './tomTomTrafficFlow';

describe('TomTom traffic flow tile URLs', () => {
  it('normalizes absent and whitespace-only keys safely', () => {
    expect(normalizeTomTomTrafficApiKey(undefined)).toBe('');
    expect(normalizeTomTomTrafficApiKey('  key-value  ')).toBe('key-value');
    expect(() => buildTomTomTrafficFlowUrlTemplate('  ')).toThrow(/API anahtarı/u);
  });

  it('builds a Web Mercator tile template with the current Orbis API contract', () => {
    const url = buildTomTomTrafficFlowUrlTemplate('test key');
    expect(url).toContain('/maps/orbis/traffic/flow/raster/tile/{level}/{col}/{row}?');
    expect(url).toContain('apiVersion=2');
    expect(url).toContain('key=test+key');
    expect(url).toContain('style=light');
    expect(url).toContain('tileSize=256');
  });

  it('validates concrete tile coordinates before probing the service', () => {
    expect(buildTomTomTrafficFlowTileUrl('demo', 8, 151, 97))
      .toContain('/raster/tile/8/151/97?');
    expect(() => buildTomTomTrafficFlowTileUrl('demo', 8, 256, 1)).toThrow(RangeError);
    expect(() => buildTomTomTrafficFlowTileUrl('demo', 23, 0, 0)).toThrow(RangeError);
  });
});
