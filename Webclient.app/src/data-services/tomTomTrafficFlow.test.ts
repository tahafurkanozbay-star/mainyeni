import { describe, expect, it } from 'vitest';
import {
  buildTomTomTrafficFlowUrlTemplate,
  normalizeTomTomTrafficCredential,
  resolveTomTomTrafficCredential,
} from './tomTomTrafficFlow';

describe('TomTom browser credential configuration', () => {
  it('prefers the documented API key and accepts the legacy credential alias', () => {
    expect(resolveTomTomTrafficCredential({ VITE_TOMTOM_TRAFFIC_API_KEY: ' api-key ', VITE_TOMTOM_TRAFFIC_CREDENTIAL: 'legacy' })).toBe('api-key');
    expect(resolveTomTomTrafficCredential({ VITE_TOMTOM_TRAFFIC_CREDENTIAL: ' legacy-key ' })).toBe('legacy-key');
    expect(resolveTomTomTrafficCredential({})).toBe('');
  });
});

describe('TomTom traffic flow tile URL template', () => {
  it('normalizes absent and whitespace-only credentials safely', () => {
    expect(normalizeTomTomTrafficCredential(undefined)).toBe('');
    expect(normalizeTomTomTrafficCredential('  public-key  ')).toBe('public-key');
    expect(() => buildTomTomTrafficFlowUrlTemplate('  ')).toThrow(/yapılandırılmamış/u);
  });

  it('uses TomTom Orbis raster tiles with ArcGIS WebTileLayer placeholders', () => {
    const url = buildTomTomTrafficFlowUrlTemplate('test key');
    expect(url).toContain('/maps/orbis/traffic/flow/raster/tile/{level}/{col}/{row}?');
    expect(url).toContain('apiVersion=2');
    expect(url).toContain('key=test+key');
    expect(url).toContain('style=light');
    expect(url).toContain('tileSize=256');
  });
});
