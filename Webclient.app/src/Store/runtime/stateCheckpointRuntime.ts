import type { StoreStateProjection, StoreRuntimeLimits } from './contracts';
import { normalizeStoreRuntimeLimits } from './contracts';
import { decodeStoreSnapshot, encodeStoreSnapshot } from './stateSnapshotCodec';

export interface StoreCheckpointMetadata {
  readonly id: string;
  readonly createdAt: number;
  readonly bytes: number;
}

export interface StoreCheckpointRuntimeConfiguration {
  readonly maxCheckpoints?: number;
  readonly maxTotalBytes?: number;
  readonly limits?: Partial<StoreRuntimeLimits>;
}

type InternalCheckpoint = StoreCheckpointMetadata & {
  readonly payload: string;
};

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const normalizeId = (value: string): string => {
  const id = String(value ?? '').trim();
  if (!id) throw Object.assign(new Error('Store checkpoint id is required.'), {
    code: 'STORE_CHECKPOINT_ID_REQUIRED',
  });
  if (id.length > 120) throw Object.assign(new Error('Store checkpoint id exceeds the length limit.'), {
    code: 'STORE_CHECKPOINT_ID_TOO_LONG',
  });
  return id;
};

const bounded = (value: unknown, fallback: number, min: number, max: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
};

export class StoreCheckpointRuntime {
  readonly #limits;
  readonly #maxCheckpoints: number;
  readonly #maxTotalBytes: number;
  #entries = new Map<string, InternalCheckpoint>();
  #totalBytes = 0;

  constructor(configuration: StoreCheckpointRuntimeConfiguration = {}) {
    this.#limits = normalizeStoreRuntimeLimits(configuration.limits);
    this.#maxCheckpoints = bounded(configuration.maxCheckpoints, 8, 1, 256);
    this.#maxTotalBytes = bounded(
      configuration.maxTotalBytes,
      this.#limits.maxSnapshotBytes * 4,
      this.#limits.maxSnapshotBytes,
      64 * 1024 * 1024,
    );
  }

  get size(): number {
    return this.#entries.size;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  save(idInput: string, projection: StoreStateProjection): StoreCheckpointMetadata {
    const id = normalizeId(idInput);
    const payload = encodeStoreSnapshot(projection, this.#limits);
    const bytes = byteLength(payload);
    const existing = this.#entries.get(id);
    if (existing) {
      this.#entries.delete(id);
      this.#totalBytes -= existing.bytes;
    }

    const entry: InternalCheckpoint = Object.freeze({
      id,
      createdAt: projection.generatedAt,
      bytes,
      payload,
    });
    this.#entries.set(id, entry);
    this.#totalBytes += bytes;
    this.#evictToBudget();
    const retained = this.#entries.get(id);
    if (!retained) {
      throw Object.assign(new Error('Store checkpoint cannot fit within the configured total budget.'), {
        code: 'STORE_CHECKPOINT_BUDGET_EXCEEDED',
      });
    }
    return Object.freeze({ id: retained.id, createdAt: retained.createdAt, bytes: retained.bytes });
  }

  load(idInput: string, now = Date.now()): StoreStateProjection | null {
    const id = normalizeId(idInput);
    const entry = this.#entries.get(id);
    if (!entry) return null;

    this.#entries.delete(id);
    this.#entries.set(id, entry);
    try {
      return decodeStoreSnapshot(entry.payload, this.#limits, now).projection;
    } catch {
      this.#entries.delete(id);
      this.#totalBytes -= entry.bytes;
      return null;
    }
  }

  remove(idInput: string): boolean {
    const id = normalizeId(idInput);
    const entry = this.#entries.get(id);
    if (!entry) return false;
    this.#entries.delete(id);
    this.#totalBytes -= entry.bytes;
    return true;
  }

  list(): readonly StoreCheckpointMetadata[] {
    return Object.freeze(
      [...this.#entries.values()]
        .slice()
        .reverse()
        .map((entry) => Object.freeze({
          id: entry.id,
          createdAt: entry.createdAt,
          bytes: entry.bytes,
        })),
    );
  }

  clear(): number {
    const count = this.#entries.size;
    this.#entries.clear();
    this.#totalBytes = 0;
    return count;
  }

  #evictToBudget(): void {
    while (
      this.#entries.size > this.#maxCheckpoints
      || this.#totalBytes > this.#maxTotalBytes
    ) {
      const oldest = this.#entries.entries().next().value as [string, InternalCheckpoint] | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest[0]);
      this.#totalBytes -= oldest[1].bytes;
    }
  }
}

export const createStoreCheckpointRuntime = (
  configuration: StoreCheckpointRuntimeConfiguration = {},
): StoreCheckpointRuntime => new StoreCheckpointRuntime(configuration);
