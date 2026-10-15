import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchPlanAskiFeatureDirect,
  fetchPlanAskiGeoJsonDirect,
  fetchPlanAskiTypeCatalogDirect,
} from './kentRehberiPlanAskiDirect';

const SOURCE = 'https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi';
const UTF8 = new TextEncoder();
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function feature(tur: number, objectId: number, extras: Record<string, unknown> = {}) {
  return {
    objectId,
    tur,
    adi: 'Çankaya Kadın Danışma',
    adres: 'Atatürk Caddesi',
    ilce: 'ÇANKAYA',
    mahalle: 'KIZILAY',
    x: 32.8597,
    y: 39.9228,
    ...extras,
  };
}

function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function singleTypeFetch(tur: number, entries: readonly unknown[]): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(`${SOURCE}?tur=${tur}`);
    expect(init?.method).toBe('GET');
    expect(init?.mode).toBe('cors');
    expect(init?.credentials).toBe('omit');
    expect(init?.cache).toBe('no-store');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toEqual({ Accept: 'application/json' });
    return jsonResponse(entries);
  }) as typeof fetch;
}

function streamedResponse(chunks: readonly Uint8Array[], cancel?: () => void): Response {
  let cursor = 0;
  const body = new NodeReadableStream<Uint8Array>({
    pull(controller) {
      const value = chunks[cursor++];
      if (value) controller.enqueue(value);
      else controller.close();
    },
    cancel() {
      cancel?.();
    },
  });
  return new Response(body as unknown as BodyInit, { headers: { 'Content-Type': 'application/json' } });
}

describe('QA: direct PlanASKI transport memory and lifecycle security', () => {
  it('decodes UTF-8 correctly when a Turkish character crosses chunk boundaries', async () => {
    const json = JSON.stringify([feature(13, 101)]);
    const bytes = UTF8.encode(json);
    const position = bytes.indexOf(0xc3);
    expect(position).toBeGreaterThan(0);
    const response = streamedResponse([
      bytes.subarray(0, position + 1),
      bytes.subarray(position + 1, position + 2),
      bytes.subarray(position + 2),
    ]);
    const fetchImpl = vi.fn(async () => response) as typeof fetch;
    const result = await fetchPlanAskiGeoJsonDirect({ tur: 13, fetchImpl });
    expect(result.features).toHaveLength(1);
    expect(result.features[0]?.properties.adi).toBe('Çankaya Kadın Danışma');
  });

  it('rejects a stream as soon as its byte budget is exceeded and cancels consumption', async () => {
    let cancelled = false;
    const response = streamedResponse([
      new Uint8Array(MAX_RESPONSE_BYTES / 2),
      new Uint8Array(MAX_RESPONSE_BYTES / 2 + 1),
    ], () => { cancelled = true; });
    const fetchImpl = vi.fn(async () => response) as typeof fetch;
    await expect(fetchPlanAskiGeoJsonDirect({ tur: 13, fetchImpl }))
      .rejects.toThrow('size budget');
    expect(cancelled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a declared oversized response before JSON decoding', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([], { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) })) as typeof fetch;
    await expect(fetchPlanAskiGeoJsonDirect({ tur: 13, fetchImpl }))
      .rejects.toThrow('size budget');
  });

  it.each(['-1', '20extra', '1.25', '9999999999999999999999999999999999'])(
    'fails closed on malformed or unsafe content-length %s',
    async (header) => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse([], { 'Content-Length': header })) as typeof fetch;
      await expect(fetchPlanAskiGeoJsonDirect({ tur: 13, fetchImpl })).rejects.toThrow();
    },
  );

  it.each(['text/application/json', 'application/json-malicious', 'text/html', 'application/problem+json'])(
    'requires the exact JSON media type instead of substring matching: %s',
    async (type) => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse([], { 'Content-Type': type })) as typeof fetch;
      await expect(fetchPlanAskiGeoJsonDirect({ tur: 13, fetchImpl }))
        .rejects.toThrow('content type');
    },
  );

  it('rejects malformed UTF-8 rather than replacing bytes in location names', async () => {
    const prefix = UTF8.encode('[{"objectId":101,"tur":13,"adi":"');
    const suffix = UTF8.encode('"}]');
    const response = streamedResponse([prefix, new Uint8Array([0xc3, 0x28]), suffix]);
    const fetchImpl = vi.fn(async () => response) as typeof fetch;
    await expect(fetchPlanAskiGeoJsonDirect({ tur: 13, fetchImpl })).rejects.toThrow();
  });

  it('keeps upstream endpoint fixed regardless of filters or API base override', async () => {
    const fetchImpl = singleTypeFetch(13, [feature(13, 101)]);
    const result = await fetchPlanAskiGeoJsonDirect({
      tur: 13, q: 'çankaya', ilce: 'ÇANKAYA', apiBaseUrl: 'https://other.example.test',
      fetchImpl,
    });
    expect(result.meta?.count).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch network requests after cancellation was already requested', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Cancelled by navigation'));
    const fetchImpl = vi.fn(async () => jsonResponse([])) as typeof fetch;
    await expect(fetchPlanAskiGeoJsonDirect({
      tur: 13, signal: controller.signal, fetchImpl,
    })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('aborts other in-flight categories after a rejected category invalidates the snapshot', async () => {
    const requests: number[] = [];
    const aborted: number[] = [];
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const type = Number(new URL(String(input)).searchParams.get('tur'));
      requests.push(type);
      if (type === 0) return Promise.resolve(new Response('unavailable', { status: 503 }));
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error('Expected an AbortSignal'));
        if (signal.aborted) {
          aborted.push(type);
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => {
          aborted.push(type);
          reject(signal.reason);
        }, { once: true });
      });
    }) as typeof fetch;
    await expect(fetchPlanAskiTypeCatalogDirect({ fetchImpl })).rejects.toThrow();
    expect(requests).toEqual([0, 1, 2, 3]);
    expect(aborted.sort()).toEqual([1, 2, 3]);
  });

  it('constrains a complete 43-category sweep to four in-flight requests', async () => {
    const active = new Set<number>();
    let maximum = 0;
    const called: number[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const type = Number(new URL(String(input)).searchParams.get('tur'));
      expect(String(input)).toBe(`${SOURCE}?tur=${type}`);
      expect(init?.signal).toBeDefined();
      active.add(type);
      maximum = Math.max(maximum, active.size);
      called.push(type);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      active.delete(type);
      return jsonResponse(type === 13 ? [feature(13, 101)] : []);
    }) as typeof fetch;
    const catalog = await fetchPlanAskiTypeCatalogDirect({ fetchImpl });
    expect(maximum).toBeLessThanOrEqual(4);
    expect(maximum).toBeGreaterThan(1);
    expect(called.sort((a, b) => a - b)).toEqual(Array.from({ length: 43 }, (_, i) => i));
    expect(catalog.types[13]?.samples).toMatchObject([{ objectid: 101 }]);
  });

  it('does not leak personal information into transport parsing errors', async () => {
    const privateValue = 'Sokak 42 özel adres';
    const fetchImpl = singleTypeFetch(13, [
      feature(13, 101, { adres: privateValue, x: 181 }),
    ]);
    try {
      await fetchPlanAskiGeoJsonDirect({ tur: 13, fetchImpl });
      throw new Error('Expected rejection');
    } catch (error) {
      expect(String(error)).not.toContain(privateValue);
      expect(String(error)).toContain('coordinate');
    }
  });

  it('keeps feature lookup, type catalog and filtered results consistent for null geometry', async () => {
    const entries = [feature(13, 101, { x: null, y: null, adres: 'Cadde\r\nNo: 4' })];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      jsonResponse(Number(new URL(String(input)).searchParams.get('tur')) === 13 ? entries : [])
    ) as typeof fetch;
    const direct = await fetchPlanAskiGeoJsonDirect({ tur: 13, fetchImpl });
    expect(direct.features[0]?.geometry).toBeNull();
    expect(direct.features[0]?.properties.adres).toBe('Cadde No: 4');
    const byId = await fetchPlanAskiFeatureDirect(101, { fetchImpl });
    expect(byId).toEqual(direct.features[0]);
    const types = await fetchPlanAskiTypeCatalogDirect({ fetchImpl });
    expect(types.types[13]?.count).toBe(1);
  });

  it('rejects all non-finite, non-integral, and out-of-budget result limits before I/O', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([])) as typeof fetch;
    for (const limit of [0, -1, 2001, NaN, Infinity, -Infinity, 1.1]) {
      await expect(fetchPlanAskiGeoJsonDirect({ tur: 13, limit, fetchImpl }))
        .rejects.toThrow('limit');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
