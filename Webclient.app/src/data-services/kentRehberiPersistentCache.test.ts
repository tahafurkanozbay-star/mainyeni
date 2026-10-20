import { describe, expect, it, vi } from 'vitest';
import {
  PlanAskiPersistentCategoryCache,
  type PlanAskiCategoryCacheEntry,
  type PlanAskiCategoryCacheStore,
} from './kentRehberiPersistentCache';
import { fetchPlanAskiGeoJsonDirect } from './kentRehberiPlanAskiDirect';

class MemoryCategoryStore implements PlanAskiCategoryCacheStore {
  readonly entries = new Map<number, PlanAskiCategoryCacheEntry>();

  async get(tur: number): Promise<unknown | null> {
    return this.entries.get(tur) ?? null;
  }

  async put(entry: PlanAskiCategoryCacheEntry): Promise<void> {
    this.entries.set(entry.tur, entry);
  }

  async delete(tur: number): Promise<void> {
    this.entries.delete(tur);
  }
}

const row = (tur: number, objectId: number) => ({
  objectId,
  tur,
  adi: 'Çankaya Hizmet Noktası',
  adres: 'Kızılay, Ankara',
  ilce: 'Çankaya',
  mahalle: 'Kızılay',
  x: 32.854,
  y: 39.92,
  yapan: 1,
  webSayfasi: null,
  durakNo: null,
});

const responseFetch = (tur: number, rows: readonly unknown[]) =>
  vi.fn(async (input: RequestInfo | URL) => {
    expect(Number(new URL(String(input)).searchParams.get('tur'))).toBe(tur);
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }) as typeof fetch;

describe('persistent PlanASKI category cache', () => {
  it('reuses a fresh validated category after the fetch implementation changes', async () => {
    const store = new MemoryCategoryStore();
    const cache = new PlanAskiPersistentCategoryCache({
      store,
      clock: () => 10_000,
    });
    const firstFetch = responseFetch(13, [row(13, 101)]);

    const first = await fetchPlanAskiGeoJsonDirect({
      tur: 13,
      fetchImpl: firstFetch,
      persistentCache: cache,
    });

    expect(first.features.map((feature) => feature.id)).toEqual([101]);
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(store.entries.has(13)).toBe(true);

    const secondFetch = vi.fn(async () => {
      throw new Error('A fresh persistent cache should avoid the network.');
    }) as typeof fetch;
    const second = await fetchPlanAskiGeoJsonDirect({
      tur: 13,
      fetchImpl: secondFetch,
      persistentCache: cache,
    });

    expect(second.features).toEqual(first.features);
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it('uses stale validated data only if the official endpoint fails', async () => {
    let now = 1_000;
    const store = new MemoryCategoryStore();
    const cache = new PlanAskiPersistentCategoryCache({
      store,
      freshTtlMs: 60_000,
      staleIfErrorMs: 6 * 60 * 60 * 1000,
      clock: () => now,
    });
    await cache.write(13, JSON.stringify([row(13, 202)]));
    now += 61_000;

    const unavailableFetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const result = await fetchPlanAskiGeoJsonDirect({
      tur: 13,
      fetchImpl: unavailableFetch,
      persistentCache: cache,
    });

    expect(unavailableFetch).toHaveBeenCalledTimes(1);
    expect(result.features.map((feature) => feature.id)).toEqual([202]);
  });

  it('discards corrupt persisted JSON and fetches a valid official response', async () => {
    const store = new MemoryCategoryStore();
    const cache = new PlanAskiPersistentCategoryCache({
      store,
      clock: () => 10_000,
    });
    await cache.write(13, '{"not valid json"');

    const fetchImpl = responseFetch(13, [row(13, 303)]);
    const result = await fetchPlanAskiGeoJsonDirect({
      tur: 13,
      fetchImpl,
      persistentCache: cache,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.features.map((feature) => feature.id)).toEqual([303]);
    expect(store.entries.get(13)?.body).toBe(JSON.stringify([row(13, 303)]));
  });

  it('rejects entries older than the stale-if-error window and removes them', async () => {
    let now = 5_000;
    const store = new MemoryCategoryStore();
    const cache = new PlanAskiPersistentCategoryCache({
      store,
      freshTtlMs: 60_000,
      staleIfErrorMs: 120_000,
      clock: () => now,
    });
    await cache.write(13, JSON.stringify([row(13, 404)]));
    now += 121_000;

    await expect(cache.read(13)).resolves.toBeNull();
    expect(store.entries.has(13)).toBe(false);
  });
});
