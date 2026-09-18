import {
  HttpBusinessAbortError,
  HttpBusinessError,
  HttpBusinessTimeoutError,
  appendHttpQuery,
  requestData,
} from './HttpBusiness';
import { GoogleMapsBusiness } from './GoogleMapsBusiness';
import { AuthBusiness } from './AuthBusiness';
import { FeedbackBusiness } from './FeedbackBusiness';
import { serializeClientLog } from './LoggingBusiness';

describe('strict TypeScript business network modernization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('HttpBusiness', () => {
    test('appends encoded query values without mutating the base path', () => {
      expect(appendHttpQuery('/api/test', {
        q: 'ankara merkez',
        limit: 25,
        enabled: true,
        empty: null,
      })).toBe('/api/test?q=ankara+merkez&limit=25&enabled=true');

      expect(appendHttpQuery('/api/test?x=1', { q: 'a&b' }))
        .toBe('/api/test?x=1&q=a%26b');
    });

    test('reads bounded JSON and uses same-origin credentials by default', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (
        input,
        init,
      ) => {
        expect(input).toBe('/api/health?verbose=true');
        expect(init?.method).toBe('GET');
        expect(init?.credentials).toBe('same-origin');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      await expect(requestData<{ ok: boolean }>('/api/health', {
        params: { verbose: true },
      })).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('rejects malformed JSON when the server advertises JSON', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{bad-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

      await expect(requestData('/api/test')).rejects.toThrow(/malformed JSON/u);
    });

    test('preserves bounded server data on non-success HTTP responses', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
        JSON.stringify({ code: 'INVALID_REQUEST' }),
        {
          status: 422,
          headers: { 'content-type': 'application/json' },
        },
      ));

      const error = await requestData('/api/test').catch((candidate: unknown) => candidate);
      expect(error).toBeInstanceOf(HttpBusinessError);
      expect(error).toMatchObject({
        status: 422,
        data: { code: 'INVALID_REQUEST' },
      });
    });

    test('fails closed when advertised response size exceeds its byte budget', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('small', {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-length': '9000000',
        },
      }));

      await expect(requestData('/api/test', { maxResponseBytes: 1024 }))
        .rejects.toThrow(/byte budget/u);
    });

    test('fails closed when streamed response exceeds its byte budget', async () => {
      const payload = 'x'.repeat(4096);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(payload, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }));

      await expect(requestData('/api/test', { maxResponseBytes: 1024 }))
        .rejects.toThrow(/byte budget/u);
    });

    test('distinguishes request timeout from caller cancellation', async () => {
      vi.useFakeTimers();

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        }));

      const timedOut = requestData('/api/slow', { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(timedOut).rejects.toBeInstanceOf(HttpBusinessTimeoutError);

      const controller = new AbortController();
      const cancelled = requestData('/api/slow', {
        timeoutMs: 5000,
        signal: controller.signal,
      });
      controller.abort(new HttpBusinessAbortError());
      await expect(cancelled).rejects.toBeInstanceOf(HttpBusinessAbortError);
    });

    test('POST serializes ordinary values and honors an explicit body', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
        JSON.stringify({ ok: true }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ));

      await FeedbackBusiness.SendFeedBack({ title: 'test' });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/Feedback/Save'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ title: 'test' }),
        }),
      );
    });
  });

  describe('GoogleMapsBusiness', () => {
    test('creates encoded route URLs for valid coordinates', () => {
      const url = GoogleMapsBusiness.CreateRoutesUrlFromPoint({
        latitude: 39.9208,
        longitude: 32.8541,
      });
      expect(url).not.toBeNull();
      const parsed = new URL(url!);
      expect(parsed.origin).toBe('https://www.google.com.tr');
      expect(parsed.searchParams.get('saddr')).toBe('My Location');
      expect(parsed.searchParams.get('daddr')).toBe('39.9208,32.8541');
    });

    test('accepts x/y ArcGIS point aliases', () => {
      const url = GoogleMapsBusiness.CreateStreetViewUrlFromPoint({
        x: 32.85,
        y: 39.92,
      });
      expect(url).not.toBeNull();
      expect(new URL(url!).searchParams.get('cbll')).toBe('39.92,32.85');
    });

    test.each([
      { latitude: 91, longitude: 32 },
      { latitude: 39, longitude: 181 },
      { latitude: Number.NaN, longitude: 32 },
      { x: Number.POSITIVE_INFINITY, y: 39 },
    ])('rejects invalid coordinate pair %#', (point) => {
      expect(GoogleMapsBusiness.CreateRoutesUrlFromPoint(point)).toBeNull();
      expect(GoogleMapsBusiness.CreateStreetViewUrlFromPoint(point)).toBeNull();
    });
  });

  describe('client logging redaction', () => {
    test('redacts common secret-bearing keys recursively', () => {
      const serialized = serializeClientLog({
        message: 'request failed',
        password: 'super-secret',
        nested: {
          authorization: 'Bearer hidden',
          apiKey: 'hidden-api-key',
          safe: 'visible',
        },
      });

      expect(serialized).not.toContain('super-secret');
      expect(serialized).not.toContain('Bearer hidden');
      expect(serialized).not.toContain('hidden-api-key');
      expect(serialized).toContain('[REDACTED]');
      expect(serialized).toContain('visible');
    });

    test('bounds arrays, strings and recursive object depth', () => {
      const circular: Record<string, unknown> = { token: 'hidden' };
      circular.self = circular;
      circular.long = 'x'.repeat(10_000);
      circular.items = Array.from({ length: 100 }, (_, index) => index);

      const serialized = serializeClientLog(circular);
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      expect(parsed.token).toBe('[REDACTED]');
      expect(parsed.self).toBe('[Circular]');
      expect(String(parsed.long).length).toBeLessThanOrEqual(2048);
      expect(parsed.items).toHaveLength(40);
    });
  });

  describe('public authentication boundary', () => {
    test('returns ordinary JSON headers without a fake browser bearer token', async () => {
      const headers = await AuthBusiness.GetRequestHeaders();
      expect(headers).toEqual({
        Accept: 'application/json',
        'Content-Type': 'application/json',
      });
      expect(JSON.stringify(headers)).not.toMatch(/authorization|bearer/iu);
      expect(Object.isFrozen(headers)).toBe(true);
    });

    test('rejects through the legacy message envelope without hiding the original value', async () => {
      const source = { code: 'DENIED' };
      await expect(AuthBusiness.HandleRejection(source)).rejects.toMatchObject({
        Data: source,
      });
    });
  });
});
