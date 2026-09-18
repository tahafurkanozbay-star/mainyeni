import { describe, expect, it, vi } from 'vitest';
import {
  buildGoogleDirectionsUrl,
  bufferUnitsToMeters,
  createGeolocationRequest,
  createLatestRequestGate,
  createOwnedResourceRegistry,
  getGeometryCoordinates,
  metersToBufferUnits,
  normalizeBufferUnits,
  normalizeErrorMessage,
  openExternalSafely,
  safeClientLog,
} from './QueryInteractionRuntime';

describe('QueryInteractionRuntime', () => {
  it('normalizes and bounds buffer units', () => {
    expect(normalizeBufferUnits('19.6')).toBe(20);
    expect(normalizeBufferUnits(-50)).toBe(1);
    expect(normalizeBufferUnits(1000)).toBe(100);
    expect(normalizeBufferUnits('invalid')).toBe(20);
  });

  it('converts buffer units and meters consistently', () => {
    expect(bufferUnitsToMeters(20)).toBe(2000);
    expect(metersToBufferUnits(2500)).toBe(25);
  });

  it('reads point and centroid coordinates', () => {
    expect(getGeometryCoordinates({ latitude: 39.9, longitude: 32.8 })).toEqual({
      latitude: 39.9,
      longitude: 32.8,
    });
    expect(getGeometryCoordinates({
      centroid: { y: 40, x: 33 },
    })).toEqual({ latitude: 40, longitude: 33 });
  });

  it('rejects impossible coordinates', () => {
    expect(getGeometryCoordinates({ latitude: 120, longitude: 32 })).toBeNull();
    expect(getGeometryCoordinates({ latitude: 40, longitude: 220 })).toBeNull();
  });

  it('builds encoded HTTPS directions URLs', () => {
    const url = buildGoogleDirectionsUrl({ latitude: 39.9, longitude: 32.8 });
    expect(url).toContain('https://www.google.com.tr/maps?');
    expect(url).toContain('daddr=39.9%2C32.8');
  });

  it('opens only HTTP(S) targets with isolation features', () => {
    const opener = vi.fn(() => null);
    expect(openExternalSafely('javascript:alert(1)', opener)).toBe(false);
    expect(openExternalSafely('https://example.com/path', opener)).toBe(false);
    expect(opener).toHaveBeenCalledWith(
      'https://example.com/path',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('normalizes errors without leaking object internals', () => {
    expect(normalizeErrorMessage(new Error('test'))).toBe('test');
    expect(normalizeErrorMessage({ errorMessage: 'legacy' })).toBe('legacy');
    expect(normalizeErrorMessage({ secret: 'nope' }, 'fallback')).toBe('fallback');
  });

  it('isolates best-effort client logging while exposing the failure hook', async () => {
    const failure = new Error('offline');
    const onError = vi.fn();
    const logger = {
      CreateClientLog: vi.fn(async () => Promise.reject(failure)),
    };
    await expect(safeClientLog(logger, 'event', { value: 1 }, onError)).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('invalidates stale request ids deterministically', () => {
    const gate = createLatestRequestGate();
    const first = gate.next();
    const second = gate.next();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    expect(gate.invalidate()).toBe(3);
    expect(gate.current()).toBe(3);
  });

  it('tracks and clears owned resources', () => {
    const removedLayers: string[] = [];
    const removedGraphics: string[] = [];
    const registry = createOwnedResourceRegistry<string, string>({
      removeLayer: (layer) => removedLayers.push(layer),
      removeGraphic: (graphic) => removedGraphics.push(graphic),
    });
    registry.trackLayer('layer-a');
    registry.trackLayer('layer-b');
    registry.trackGraphic('graphic-a');
    expect(registry.sizes()).toEqual({ layers: 2, graphics: 1 });
    registry.clear();
    expect(new Set(removedLayers)).toEqual(new Set(['layer-a', 'layer-b']));
    expect(removedGraphics).toEqual(['graphic-a']);
    expect(registry.sizes()).toEqual({ layers: 0, graphics: 0 });
  });

  it('does not allow cleanup failures to interrupt the remaining cleanup', () => {
    const onCleanupError = vi.fn();
    const removed: string[] = [];
    const registry = createOwnedResourceRegistry<string, never>({
      removeLayer: (layer) => {
        if (layer === 'bad') throw new Error('cleanup');
        removed.push(layer);
      },
      onCleanupError,
    });
    registry.trackLayer('bad');
    registry.trackLayer('good');
    registry.clearLayers();
    expect(removed).toEqual(['good']);
    expect(onCleanupError).toHaveBeenCalledTimes(1);
  });

  it('resolves bounded geolocation values', async () => {
    const geolocation = {
      getCurrentPosition: (
        success: PositionCallback,
        _error?: PositionErrorCallback | null,
        options?: PositionOptions,
      ) => {
        expect(options?.enableHighAccuracy).toBe(false);
        success({
          coords: {
            latitude: 39.93,
            longitude: 32.85,
            accuracy: 25,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null,
            toJSON: () => ({}),
          },
          timestamp: 1,
          toJSON: () => ({}),
        } as GeolocationPosition);
      },
      watchPosition: () => 1,
      clearWatch: () => undefined,
    } satisfies Geolocation;

    await expect(createGeolocationRequest({ geolocation })).resolves.toEqual({
      latitude: 39.93,
      longitude: 32.85,
      accuracy: 25,
    });
  });

  it('rejects unavailable geolocation', async () => {
    await expect(createGeolocationRequest({ geolocation: null })).rejects.toThrow(
      /Konum servisi/,
    );
  });
});
