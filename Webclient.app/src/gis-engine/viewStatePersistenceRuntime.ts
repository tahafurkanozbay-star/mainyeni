export type GisViewMode = '2d' | '3d';

export interface GisCameraState {
  readonly longitude: number;
  readonly latitude: number;
  readonly zoom: number;
  readonly heading?: number;
  readonly tilt?: number;
}

export interface GisLayerState {
  readonly id: string;
  readonly visible: boolean;
  readonly opacity: number;
}

export interface GisViewState {
  readonly version: 1;
  readonly mode: GisViewMode;
  readonly camera: GisCameraState;
  readonly layers: readonly GisLayerState[];
  readonly selectedLayerId?: string;
  readonly timestamp: number;
}

export interface ViewStatePersistenceLimits {
  readonly maxLayers: number;
  readonly maxSerializedBytes: number;
  readonly maxAgeMs: number;
  readonly minZoom: number;
  readonly maxZoom: number;
}

export interface ViewStateDecodeResult {
  readonly ok: boolean;
  readonly state?: GisViewState;
  readonly reason?: 'empty' | 'too-large' | 'malformed' | 'unsupported-version' | 'invalid' | 'expired';
}

const DEFAULT_LIMITS: ViewStatePersistenceLimits = Object.freeze({
  maxLayers: 256,
  maxSerializedBytes: 32 * 1024,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  minZoom: 0,
  maxZoom: 24,
});

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const utf8Bytes = (value: string): number => {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  return value.length;
};

const normalizeLongitude = (value: number): number => {
  // Preserve already-canonical coordinates exactly. Running an in-range decimal
  // through modulo arithmetic can introduce IEEE-754 drift (for example
  // 32.85 -> 32.85000000000002), which makes persisted state non-idempotent.
  if (value >= -180 && value < 180) return Object.is(value, -0) ? 0 : value;
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
};

const normalizeHeading = (value: number): number => {
  const wrapped = ((value % 360) + 360) % 360;
  return Object.is(wrapped, -0) ? 0 : wrapped;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const cleanId = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  if (id.length === 0 || id.length > 160) return undefined;
  if (!/^[\p{L}\p{N}_.:/@ -]+$/u.test(id)) return undefined;
  return id;
};

export class ViewStatePersistenceRuntime {
  readonly #limits: ViewStatePersistenceLimits;

  constructor(limits: Partial<ViewStatePersistenceLimits> = {}) {
    const merged = { ...DEFAULT_LIMITS, ...limits };
    if (!Number.isInteger(merged.maxLayers) || merged.maxLayers < 1 || merged.maxLayers > 4096) throw new RangeError('maxLayers');
    if (!Number.isInteger(merged.maxSerializedBytes) || merged.maxSerializedBytes < 512 || merged.maxSerializedBytes > 1024 * 1024) throw new RangeError('maxSerializedBytes');
    if (!finite(merged.maxAgeMs) || merged.maxAgeMs < 0) throw new RangeError('maxAgeMs');
    if (!finite(merged.minZoom) || !finite(merged.maxZoom) || merged.minZoom > merged.maxZoom) throw new RangeError('zoom range');
    this.#limits = Object.freeze(merged);
  }

  normalize(input: GisViewState, now = Date.now()): GisViewState {
    const camera = this.#normalizeCamera(input.camera);
    const layers = this.#normalizeLayers(input.layers);
    const selectedLayerId = cleanId(input.selectedLayerId);
    const timestamp = finite(input.timestamp) && input.timestamp >= 0 ? Math.min(input.timestamp, now) : now;
    return Object.freeze({
      version: 1,
      mode: input.mode === '3d' ? '3d' : '2d',
      camera,
      layers,
      ...(selectedLayerId && layers.some((layer) => layer.id === selectedLayerId) ? { selectedLayerId } : {}),
      timestamp,
    });
  }

  encode(input: GisViewState, now = Date.now()): string {
    const state = this.normalize(input, now);
    const serialized = JSON.stringify(state);
    if (utf8Bytes(serialized) > this.#limits.maxSerializedBytes) throw new RangeError('Serialized GIS view state exceeds configured byte budget');
    return serialized;
  }

  decode(serialized: string | null | undefined, now = Date.now()): ViewStateDecodeResult {
    if (!serialized) return Object.freeze({ ok: false, reason: 'empty' });
    if (utf8Bytes(serialized) > this.#limits.maxSerializedBytes) return Object.freeze({ ok: false, reason: 'too-large' });
    let parsed: unknown;
    try { parsed = JSON.parse(serialized); } catch { return Object.freeze({ ok: false, reason: 'malformed' }); }
    if (!record(parsed)) return Object.freeze({ ok: false, reason: 'invalid' });
    if (parsed.version !== 1) return Object.freeze({ ok: false, reason: 'unsupported-version' });
    const state = this.#parseState(parsed, now);
    if (!state) return Object.freeze({ ok: false, reason: 'invalid' });
    if (this.#limits.maxAgeMs > 0 && now - state.timestamp > this.#limits.maxAgeMs) return Object.freeze({ ok: false, reason: 'expired' });
    return Object.freeze({ ok: true, state });
  }

  toUrlParameter(input: GisViewState, now = Date.now()): string {
    return encodeURIComponent(this.encode(input, now));
  }

  fromUrlParameter(value: string | null | undefined, now = Date.now()): ViewStateDecodeResult {
    if (!value) return Object.freeze({ ok: false, reason: 'empty' });
    let decoded: string;
    try { decoded = decodeURIComponent(value); } catch { return Object.freeze({ ok: false, reason: 'malformed' }); }
    return this.decode(decoded, now);
  }

  merge(base: GisViewState, patch: Partial<Omit<GisViewState, 'version'>>, now = Date.now()): GisViewState {
    return this.normalize({
      ...base,
      ...patch,
      version: 1,
      camera: patch.camera ?? base.camera,
      layers: patch.layers ?? base.layers,
      timestamp: patch.timestamp ?? now,
    }, now);
  }

  #normalizeCamera(camera: GisCameraState): GisCameraState {
    if (!finite(camera.longitude) || !finite(camera.latitude) || !finite(camera.zoom)) throw new TypeError('Invalid camera coordinates');
    const heading = finite(camera.heading) ? normalizeHeading(camera.heading) : undefined;
    const tilt = finite(camera.tilt) ? clamp(camera.tilt, 0, 90) : undefined;
    return Object.freeze({
      longitude: normalizeLongitude(camera.longitude),
      latitude: clamp(camera.latitude, -90, 90),
      zoom: clamp(camera.zoom, this.#limits.minZoom, this.#limits.maxZoom),
      ...(heading === undefined ? {} : { heading }),
      ...(tilt === undefined ? {} : { tilt }),
    });
  }

  #normalizeLayers(layers: readonly GisLayerState[]): readonly GisLayerState[] {
    if (!Array.isArray(layers)) throw new TypeError('layers');
    const byId = new Map<string, GisLayerState>();
    for (const raw of layers) {
      if (byId.size >= this.#limits.maxLayers) break;
      const id = cleanId(raw?.id);
      if (!id || byId.has(id)) continue;
      const opacity = finite(raw.opacity) ? clamp(raw.opacity, 0, 1) : 1;
      byId.set(id, Object.freeze({ id, visible: raw.visible === true, opacity }));
    }
    return Object.freeze([...byId.values()]);
  }

  #parseState(raw: Record<string, unknown>, now: number): GisViewState | undefined {
    if (raw.mode !== '2d' && raw.mode !== '3d') return undefined;
    if (!record(raw.camera) || !Array.isArray(raw.layers) || !finite(raw.timestamp)) return undefined;
    if (raw.layers.length > this.#limits.maxLayers) return undefined;
    const cameraRaw = raw.camera;
    if (!finite(cameraRaw.longitude) || !finite(cameraRaw.latitude) || !finite(cameraRaw.zoom)) return undefined;
    const layers: GisLayerState[] = [];
    const seen = new Set<string>();
    for (const candidate of raw.layers) {
      if (!record(candidate)) return undefined;
      const id = cleanId(candidate.id);
      if (!id || seen.has(id) || typeof candidate.visible !== 'boolean' || !finite(candidate.opacity)) return undefined;
      if (candidate.opacity < 0 || candidate.opacity > 1) return undefined;
      seen.add(id);
      layers.push(Object.freeze({ id, visible: candidate.visible, opacity: candidate.opacity }));
    }
    const selectedLayerId = raw.selectedLayerId === undefined ? undefined : cleanId(raw.selectedLayerId);
    if (raw.selectedLayerId !== undefined && !selectedLayerId) return undefined;
    if (selectedLayerId && !seen.has(selectedLayerId)) return undefined;
    try {
      return this.normalize({
        version: 1,
        mode: raw.mode,
        camera: {
          longitude: cameraRaw.longitude,
          latitude: cameraRaw.latitude,
          zoom: cameraRaw.zoom,
          ...(finite(cameraRaw.heading) ? { heading: cameraRaw.heading } : {}),
          ...(finite(cameraRaw.tilt) ? { tilt: cameraRaw.tilt } : {}),
        },
        layers,
        ...(selectedLayerId ? { selectedLayerId } : {}),
        timestamp: raw.timestamp,
      }, now);
    } catch { return undefined; }
  }
}
