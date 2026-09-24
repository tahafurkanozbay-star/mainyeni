import { describe, expect, it } from 'vitest';
import { ViewStatePersistenceRuntime, type GisViewState } from './viewStatePersistenceRuntime';

const NOW = 2_000_000;
const state = (overrides: Partial<GisViewState> = {}): GisViewState => ({
  version: 1,
  mode: '2d',
  camera: { longitude: 32.85, latitude: 39.93, zoom: 12 },
  layers: [
    { id: 'roads', visible: true, opacity: 1 },
    { id: 'parks', visible: false, opacity: 0.6 },
  ],
  selectedLayerId: 'roads',
  timestamp: NOW,
  ...overrides,
});

describe('ViewStatePersistenceRuntime', () => {
  it('round trips bounded state', () => {
    const runtime = new ViewStatePersistenceRuntime();
    const encoded = runtime.encode(state(), NOW);
    expect(runtime.decode(encoded, NOW)).toEqual({ ok: true, state: state() });
  });

  it('normalizes longitude, latitude, zoom, heading and tilt', () => {
    const runtime = new ViewStatePersistenceRuntime({ minZoom: 2, maxZoom: 20 });
    const normalized = runtime.normalize(state({
      mode: '3d',
      camera: { longitude: 392.85, latitude: 120, zoom: 99, heading: -30, tilt: 120 },
    }), NOW);
    expect(normalized.camera).toEqual({ longitude: 32.85000000000002, latitude: 90, zoom: 20, heading: 330, tilt: 90 });
  });

  it('deduplicates layer ids and clamps opacity when normalizing trusted runtime state', () => {
    const runtime = new ViewStatePersistenceRuntime();
    const normalized = runtime.normalize(state({ layers: [
      { id: 'roads', visible: true, opacity: 2 },
      { id: 'roads', visible: false, opacity: 0 },
      { id: 'parks', visible: true, opacity: -1 },
    ] }), NOW);
    expect(normalized.layers).toEqual([
      { id: 'roads', visible: true, opacity: 1 },
      { id: 'parks', visible: true, opacity: 0 },
    ]);
  });

  it('drops selection when the selected layer is not retained', () => {
    const runtime = new ViewStatePersistenceRuntime({ maxLayers: 1 });
    const normalized = runtime.normalize(state({ selectedLayerId: 'parks' }), NOW);
    expect(normalized.selectedLayerId).toBeUndefined();
  });

  it('rejects malformed json', () => {
    expect(new ViewStatePersistenceRuntime().decode('{', NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects unsupported schema versions', () => {
    expect(new ViewStatePersistenceRuntime().decode(JSON.stringify({ version: 2 }), NOW)).toEqual({ ok: false, reason: 'unsupported-version' });
  });

  it('rejects expired persisted state', () => {
    const runtime = new ViewStatePersistenceRuntime({ maxAgeMs: 100 });
    const encoded = runtime.encode(state({ timestamp: NOW - 101 }), NOW);
    expect(runtime.decode(encoded, NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('allows age checks to be disabled', () => {
    const runtime = new ViewStatePersistenceRuntime({ maxAgeMs: 0 });
    const encoded = runtime.encode(state({ timestamp: 1 }), NOW);
    expect(runtime.decode(encoded, NOW).ok).toBe(true);
  });

  it('rejects payloads above the configured byte budget before parsing', () => {
    const runtime = new ViewStatePersistenceRuntime({ maxSerializedBytes: 512 });
    expect(runtime.decode('x'.repeat(513), NOW)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('rejects decoded layer arrays above the configured capacity', () => {
    const runtime = new ViewStatePersistenceRuntime({ maxLayers: 1 });
    const encoded = JSON.stringify(state());
    expect(runtime.decode(encoded, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects duplicate persisted layer ids rather than silently changing external state', () => {
    const runtime = new ViewStatePersistenceRuntime();
    const encoded = JSON.stringify(state({ layers: [
      { id: 'roads', visible: true, opacity: 1 },
      { id: 'roads', visible: false, opacity: 0.5 },
    ] }));
    expect(runtime.decode(encoded, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects invalid persisted opacity instead of clamping untrusted state', () => {
    const runtime = new ViewStatePersistenceRuntime();
    const encoded = JSON.stringify(state({ layers: [{ id: 'roads', visible: true, opacity: 2 }] }));
    expect(runtime.decode(encoded, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a selection that does not identify a persisted layer', () => {
    const runtime = new ViewStatePersistenceRuntime();
    const encoded = JSON.stringify(state({ selectedLayerId: 'missing' }));
    expect(runtime.decode(encoded, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('round trips URL-safe state without introducing a network or storage dependency', () => {
    const runtime = new ViewStatePersistenceRuntime();
    const encoded = runtime.toUrlParameter(state(), NOW);
    expect(encoded).not.toContain('{');
    expect(runtime.fromUrlParameter(encoded, NOW)).toEqual({ ok: true, state: state() });
  });

  it('fails closed for malformed URL encoding', () => {
    expect(new ViewStatePersistenceRuntime().fromUrlParameter('%E0%A4%A', NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('merges a partial state while refreshing timestamp', () => {
    const runtime = new ViewStatePersistenceRuntime();
    const merged = runtime.merge(state({ timestamp: 1 }), { mode: '3d', selectedLayerId: 'parks' }, NOW);
    expect(merged.mode).toBe('3d');
    expect(merged.selectedLayerId).toBe('parks');
    expect(merged.timestamp).toBe(NOW);
  });

  it.each([
    [{ maxLayers: 0 }, 'maxLayers'],
    [{ maxLayers: 4097 }, 'maxLayers'],
    [{ maxSerializedBytes: 1 }, 'maxSerializedBytes'],
    [{ maxAgeMs: -1 }, 'maxAgeMs'],
    [{ minZoom: 10, maxZoom: 1 }, 'zoom range'],
  ] as const)('rejects invalid limits %o', (limits, message) => {
    expect(() => new ViewStatePersistenceRuntime(limits)).toThrow(message);
  });

  it('rejects non-finite camera coordinates', () => {
    const runtime = new ViewStatePersistenceRuntime();
    expect(() => runtime.normalize(state({ camera: { longitude: Number.NaN, latitude: 0, zoom: 1 } }), NOW)).toThrow('Invalid camera coordinates');
  });

  it('bounds future timestamps to now', () => {
    const runtime = new ViewStatePersistenceRuntime();
    expect(runtime.normalize(state({ timestamp: NOW + 5000 }), NOW).timestamp).toBe(NOW);
  });
});
