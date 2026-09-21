import {
  AdminApiError,
  adminApiGet,
  adminApiPost,
  adminApiPostForm,
  adminApiRequest,
} from './adminApiClient';
import {
  ADMIN_SESSION_STORAGE_KEY,
  writeAdminSession,
} from './adminSession';

describe('adminApiClient', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.useRealTimers();
  });

  test('encodes query values and attaches bearer auth once', async () => {
    writeAdminSession({ accessToken: 'token-123' });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/AppSettings/List?key=Gis+Map%2FConfig');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer token-123');
      expect(headers.get('Accept')).toBe('application/json');
      expect(init?.credentials).toBe('same-origin');
      expect(init?.method).toBe('GET');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(adminApiGet('/AppSettings/List', {
      query: { key: 'Gis Map/Config' },
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: '/api',
    })).resolves.toEqual({ ok: true });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('serializes JSON posts without reflecting server internals', async () => {
    writeAdminSession({ accessToken: 'token' });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
      expect(init?.body).toBe(JSON.stringify({ id: 7, title: 'Katman' }));
      return new Response('database host=private; password=do-not-reflect', {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      });
    });

    const promise = adminApiPost('/Gis/Layer/Save', { id: 7, title: 'Katman' }, {
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: '/api',
    });

    await expect(promise).rejects.toMatchObject({
      code: 'http-error',
      status: 503,
    });
    await expect(promise).rejects.not.toThrow(/database|password|private/u);
  });

  test('sends FormData without manually setting multipart content type', async () => {
    writeAdminSession({ accessToken: 'token' });
    const formData = new FormData();
    formData.append('file', new Blob(['x']), 'config.csv');

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.has('Content-Type')).toBe(false);
      expect(init?.body).toBe(formData);
      return new Response(JSON.stringify({ imported: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(adminApiPostForm('/Gis/ConfigService/Import', formData, {
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: '/api',
    })).resolves.toEqual({ imported: 1 });
  });

  test('allows unauthenticated login requests without bearer headers', async () => {
    const data = new FormData();
    data.append('UserName', 'operator');

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return new Response(JSON.stringify({ isSuccess: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(adminApiPostForm('/Auth/Login', data, {
      authenticated: false,
      redirectOnUnauthorized: false,
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: '/api',
    })).resolves.toEqual({ isSuccess: false });
  });

  test('fails fast before fetch when an authenticated request has no session', async () => {
    const fetchImpl = vi.fn();

    await expect(adminApiGet('/UserRole/List', {
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: '/api',
    })).rejects.toMatchObject({
      code: 'unauthenticated',
      status: 401,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('clears session on 401 without parsing or reflecting the body', async () => {
    writeAdminSession({ accessToken: 'expired' });
    const fetchImpl = vi.fn(async () => new Response(
      'internal token verifier stack',
      { status: 401, headers: { 'content-type': 'text/plain' } },
    ));

    await expect(adminApiGet('/UserRole/List', {
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: '/api',
    })).rejects.toMatchObject({
      code: 'unauthenticated',
      status: 401,
    });

    expect(sessionStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).toBeNull();
  });

  test('rejects protocol-relative, absolute and traversal endpoint paths', async () => {
    const fetchImpl = vi.fn();
    writeAdminSession({ accessToken: 'token' });

    for (const endpoint of [
      '//evil.example/api',
      'https://evil.example/api',
      '/Gis/../Auth/Login',
    ]) {
      await expect(adminApiGet(endpoint, {
        fetchImpl: fetchImpl as typeof fetch,
        baseUrl: '/api',
      })).rejects.toMatchObject({ code: 'invalid-request' });
    }

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('enforces advertised response size before reading the body', async () => {
    writeAdminSession({ accessToken: 'token' });
    const fetchImpl = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': '9000000',
      },
    }));

    await expect(adminApiGet('/Large', {
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: '/api',
      maxResponseBytes: 1024,
    })).rejects.toMatchObject({ code: 'response-too-large' });
  });

  test('enforces actual response bytes when content-length is absent', async () => {
    writeAdminSession({ accessToken: 'token' });
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ data: 'x'.repeat(2048) }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    ));

    await expect(adminApiGet('/Large', {
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: '/api',
      maxResponseBytes: 128,
    })).rejects.toMatchObject({ code: 'response-too-large' });
  });

  test('rejects malformed JSON with a sanitized error', async () => {
    writeAdminSession({ accessToken: 'token' });
    const fetchImpl = vi.fn(async () => new Response('{broken', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(adminApiGet('/Broken', {
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: '/api',
    })).rejects.toMatchObject({ code: 'invalid-json' });
  });

  test('rejects unexpected content types', async () => {
    writeAdminSession({ accessToken: 'token' });
    const fetchImpl = vi.fn(async () => new Response('<html>proxy error</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));

    await expect(adminApiGet('/WrongType', {
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: '/api',
    })).rejects.toMatchObject({ code: 'invalid-content-type' });
  });

  test('propagates external cancellation as an aborted request', async () => {
    writeAdminSession({ accessToken: 'token' });
    const controller = new AbortController();
    controller.abort('navigation');

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true);
      throw new DOMException('aborted', 'AbortError');
    });

    await expect(adminApiGet('/Slow', {
      signal: controller.signal,
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: '/api',
    })).rejects.toMatchObject({ code: 'aborted' });
  });

  test('maps a bounded timeout to timeout instead of network-error', async () => {
    vi.useFakeTimers();
    writeAdminSession({ accessToken: 'token' });

    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }));

    const request = adminApiGet('/Slow', {
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: '/api',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(request).rejects.toMatchObject({ code: 'timeout' });
  });

  test('rejects simultaneous JSON and FormData bodies', async () => {
    await expect(adminApiRequest('/Invalid', {
      authenticated: false,
      body: { x: 1 },
      formData: new FormData(),
      fetchImpl: vi.fn() as typeof fetch,
      baseUrl: '/api',
    })).rejects.toBeInstanceOf(AdminApiError);
  });
});
