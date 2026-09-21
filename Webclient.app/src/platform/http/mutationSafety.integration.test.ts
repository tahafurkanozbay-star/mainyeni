import { describe, expect, test, vi } from 'vitest';
import { AppError } from '../errors/appError';
import type {
  NormalizedRequestConfig,
  Transport,
  TransportResult,
} from './contracts';
import type { FetchImplementation } from './fetchTransport';
import type { ResponseLike } from './responseParser';
import { executeFetch } from './fetchTransport';
import { createApiClient } from './httpClient';
import { createRequestCoordinator } from './requestCoordinator';
import {
  normalizeRequestConfig,
  sanitizeRequestHeaders,
} from './requestPolicy';

const envelope = <T>(data: T, status = 200): TransportResult<T> => Object.freeze({
  data,
  status,
  statusText: status === 200 ? 'OK' : 'ERROR',
  headers: null,
  metadata: Object.freeze({
    status,
    method: 'post',
    url: '/items',
  }),
});

const transport = (
  implementation: (config: NormalizedRequestConfig) => Promise<TransportResult<unknown>>,
): Transport => ({
  defaults: Object.freeze({
    baseUrl: '/api',
    timeoutMs: 5_000,
    maxRetries: 0,
    cacheTtlMs: 30_000,
  }),
  request: vi.fn(implementation) as Transport['request'],
});

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
};

const response = (): ResponseLike => ({
  status: 200,
  ok: true,
  statusText: 'OK',
  headers: new Headers({ 'content-type': 'application/json' }),
  text: vi.fn().mockResolvedValue('{"saved":true}'),
});

const protectedMutation = (
  key: string,
  overrides: Record<string, unknown> = {},
) => ({
  method: 'post',
  url: '/items',
  data: { value: 1 },
  idempotencyKey: key,
  idempotencyPolicy: 'server-enforced' as const,
  retryUnsafe: true,
  maxRetries: 1,
  ...overrides,
});

describe('mutation safety request policy', () => {
  test('fails closed when unsafe POST retry has no idempotency proof', () => {
    expect(() => normalizeRequestConfig({
      method: 'post',
      url: '/items',
      retryUnsafe: true,
      maxRetries: 1,
    })).toThrowError(expect.objectContaining({
      code: 'UNSAFE_RETRY_REQUIRES_IDEMPOTENCY',
    }));
  });

  test('fails closed when key is supplied without server policy', () => {
    expect(() => normalizeRequestConfig({
      method: 'post',
      url: '/items',
      idempotencyKey: 'mutation-policy-key-0001',
    })).toThrowError(expect.objectContaining({
      code: 'IDEMPOTENCY_POLICY_REQUIRED',
    }));
  });

  test('fails closed when policy is supplied without key', () => {
    expect(() => normalizeRequestConfig({
      method: 'post',
      url: '/items',
      idempotencyPolicy: 'server-enforced',
    })).toThrowError(expect.objectContaining({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    }));
  });

  test('rejects idempotency metadata on safe GET', () => {
    expect(() => normalizeRequestConfig({
      method: 'get',
      url: '/items',
      idempotencyKey: 'mutation-policy-get-0001',
      idempotencyPolicy: 'server-enforced',
    })).toThrowError(expect.objectContaining({
      code: 'IDEMPOTENCY_NOT_ALLOWED_FOR_SAFE_METHOD',
    }));
  });

  test.each([
    'short',
    'contains space',
    'contains/slash',
    'contains?query',
    'ü-invalid',
  ])('rejects invalid idempotency key %p', (idempotencyKey) => {
    expect(() => normalizeRequestConfig({
      method: 'post',
      url: '/items',
      idempotencyKey,
      idempotencyPolicy: 'server-enforced',
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_IDEMPOTENCY_KEY',
    }));
  });

  test('rejects unknown idempotency policy', () => {
    expect(() => normalizeRequestConfig({
      method: 'post',
      url: '/items',
      idempotencyKey: 'mutation-policy-invalid-0001',
      idempotencyPolicy: 'client-only' as never,
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_IDEMPOTENCY_POLICY',
    }));
  });

  test('marks protected POST retryable only with explicit server policy', () => {
    const config = normalizeRequestConfig(protectedMutation(
      'mutation-policy-protected-0001',
    ));

    expect(config).toMatchObject({
      method: 'post',
      idempotencyKey: 'mutation-policy-protected-0001',
      idempotencyPolicy: 'server-enforced',
      mutationProtected: true,
      retryAllowed: true,
      idempotentMethod: false,
      safeMethod: false,
    });
  });

  test('protects POST key from duplicate local execution even without retryUnsafe', () => {
    const config = normalizeRequestConfig({
      method: 'post',
      url: '/items',
      idempotencyKey: 'mutation-policy-protected-0002',
      idempotencyPolicy: 'server-enforced',
    });

    expect(config).toMatchObject({
      mutationProtected: true,
      retryAllowed: false,
    });
  });

  test('protects PATCH mutations with the same server-enforced contract', () => {
    const config = normalizeRequestConfig({
      method: 'patch',
      url: '/items/1',
      idempotencyKey: 'mutation-policy-patch-0001',
      idempotencyPolicy: 'server-enforced',
      retryUnsafe: true,
    });

    expect(config).toMatchObject({
      method: 'patch',
      mutationProtected: true,
      retryAllowed: true,
    });
  });

  test('keeps HTTP-idempotent PUT retry behavior without forcing mutation registry ownership', () => {
    const config = normalizeRequestConfig({
      method: 'put',
      url: '/items/1',
      idempotencyKey: 'mutation-policy-put-0001',
      idempotencyPolicy: 'server-enforced',
    });

    expect(config).toMatchObject({
      idempotentMethod: true,
      retryAllowed: true,
      mutationProtected: false,
    });
  });

  test('blocks caller-controlled Idempotency-Key header', () => {
    expect(() => sanitizeRequestHeaders({
      'Idempotency-Key': 'caller-controlled-value',
    })).toThrowError(expect.objectContaining({
      code: 'MANAGED_HEADER_BLOCKED',
    }));
  });
});

describe('mutation safety fetch boundary', () => {
  test('injects one governed Idempotency-Key header for protected POST', async () => {
    const fetchImpl = vi.fn<FetchImplementation>().mockResolvedValue(response());

    await executeFetch(protectedMutation('mutation-fetch-header-0001'), {
      defaults: {
        baseUrl: '/api',
        timeoutMs: 5_000,
        maxRetries: 1,
        cacheTtlMs: 0,
      },
      baseUrl: '/api',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get('Idempotency-Key')).toBe('mutation-fetch-header-0001');
    expect(headers.get('Content-Type')).toBe('application/json;charset=UTF-8');
  });

  test('does not inject idempotency header for ordinary POST', async () => {
    const fetchImpl = vi.fn<FetchImplementation>().mockResolvedValue(response());

    await executeFetch({
      method: 'post',
      url: '/items',
      data: { value: 1 },
    }, {
      defaults: {
        baseUrl: '/api',
        timeoutMs: 5_000,
        maxRetries: 0,
        cacheTtlMs: 0,
      },
      baseUrl: '/api',
      fetchImpl,
    });

    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.has('Idempotency-Key')).toBe(false);
  });

  test('rejects raw idempotency header before native fetch', async () => {
    const fetchImpl = vi.fn<FetchImplementation>().mockResolvedValue(response());

    await expect(executeFetch({
      method: 'post',
      url: '/items',
      headers: {
        'Idempotency-Key': 'manual-key-0001',
      },
      data: { value: 1 },
    }, {
      defaults: {
        baseUrl: '/api',
        timeoutMs: 5_000,
        maxRetries: 0,
        cacheTtlMs: 0,
      },
      fetchImpl,
    })).rejects.toMatchObject({
      code: 'MANAGED_HEADER_BLOCKED',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('does not leak idempotency key through response metadata', async () => {
    const secretKey = 'mutation-fetch-private-0001';
    const fetchImpl = vi.fn<FetchImplementation>().mockResolvedValue(response());

    const result = await executeFetch(protectedMutation(secretKey), {
      defaults: {
        baseUrl: '/api',
        timeoutMs: 5_000,
        maxRetries: 1,
        cacheTtlMs: 0,
      },
      fetchImpl,
    });

    expect(JSON.stringify(result.metadata)).not.toContain(secretKey);
  });
});

describe('RequestCoordinator protected retry integration', () => {
  test('retries protected POST under one mutation lease', async () => {
    const retryable = new AppError('private upstream detail', {
      code: 'SERVER_ERROR',
      status: 503,
      retryable: true,
    });
    const custom = transport(
      vi.fn()
        .mockRejectedValueOnce(retryable)
        .mockResolvedValueOnce(envelope({ saved: true })),
    );
    const coordinator = createRequestCoordinator({
      transport: custom,
      wait: async () => undefined,
      retryOptions: { random: () => 0 },
    });

    await expect(coordinator.request(protectedMutation(
      'mutation-coordinator-retry-0001',
    ))).resolves.toMatchObject({
      data: { saved: true },
    });

    expect(custom.request).toHaveBeenCalledTimes(2);
    expect(custom.request).toHaveBeenNthCalledWith(1, expect.objectContaining({
      idempotencyKey: 'mutation-coordinator-retry-0001',
      attempt: 0,
      mutationProtected: true,
    }));
    expect(custom.request).toHaveBeenNthCalledWith(2, expect.objectContaining({
      idempotencyKey: 'mutation-coordinator-retry-0001',
      attempt: 1,
      mutationProtected: true,
    }));
    expect(coordinator.getMutationSafetySnapshot()).toMatchObject({
      protectedExecutions: 1,
      completedExecutions: 1,
      registry: {
        history: [
          expect.objectContaining({
            logicalAttempts: 2,
            state: 'completed',
          }),
        ],
      },
    });
  });

  test('unsafe retry rejection happens before transport admission', async () => {
    const custom = transport(async () => envelope({ saved: true }));
    const coordinator = createRequestCoordinator({ transport: custom });

    await expect(coordinator.request({
      method: 'post',
      url: '/items',
      retryUnsafe: true,
      maxRetries: 2,
    })).rejects.toMatchObject({
      code: 'UNSAFE_RETRY_REQUIRES_IDEMPOTENCY',
    });
    expect(custom.request).not.toHaveBeenCalled();
  });

  test('second concurrent request with same key never starts a second transport', async () => {
    const gate = deferred<TransportResult<unknown>>();
    const custom = transport(async () => gate.promise);
    const coordinator = createRequestCoordinator({ transport: custom });
    const config = protectedMutation('mutation-coordinator-duplicate-0001', {
      maxRetries: 0,
      retryUnsafe: false,
    });

    const first = coordinator.request(config);
    await flush();

    await expect(coordinator.request(config)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_IN_FLIGHT',
    });
    expect(custom.request).toHaveBeenCalledTimes(1);

    gate.resolve(envelope({ saved: true }));
    await expect(first).resolves.toMatchObject({
      data: { saved: true },
    });
  });

  test('same key replay after success is blocked before transport', async () => {
    const custom = transport(async () => envelope({ saved: true }));
    const coordinator = createRequestCoordinator({ transport: custom });
    const config = protectedMutation('mutation-coordinator-replay-0001', {
      maxRetries: 0,
      retryUnsafe: false,
    });

    await coordinator.request(config);
    await expect(coordinator.request(config)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(custom.request).toHaveBeenCalledTimes(1);
  });

  test('different keys may execute concurrently', async () => {
    const gates = [
      deferred<TransportResult<unknown>>(),
      deferred<TransportResult<unknown>>(),
    ];
    let call = 0;
    const custom = transport(async () => gates[call++]!.promise);
    const coordinator = createRequestCoordinator({ transport: custom });

    const first = coordinator.request(protectedMutation(
      'mutation-coordinator-parallel-0001',
      { maxRetries: 0, retryUnsafe: false },
    ));
    const second = coordinator.request(protectedMutation(
      'mutation-coordinator-parallel-0002',
      { maxRetries: 0, retryUnsafe: false },
    ));
    await flush();

    expect(custom.request).toHaveBeenCalledTimes(2);
    expect(coordinator.getMutationSafetySnapshot()).toMatchObject({
      registry: {
        inFlight: 2,
      },
    });

    gates[0]!.resolve(envelope({ id: 1 }));
    gates[1]!.resolve(envelope({ id: 2 }));
    await Promise.all([first, second]);
  });

  test('getInFlightSize includes active protected mutation lease', async () => {
    const gate = deferred<TransportResult<unknown>>();
    const custom = transport(async () => gate.promise);
    const coordinator = createRequestCoordinator({ transport: custom });

    const running = coordinator.request(protectedMutation(
      'mutation-coordinator-flight-size-0001',
      { maxRetries: 0, retryUnsafe: false },
    ));
    await flush();

    expect(coordinator.getInFlightSize()).toBe(1);
    gate.resolve(envelope({ saved: true }));
    await running;
    expect(coordinator.getInFlightSize()).toBe(0);
  });

  test('retention expiration permits explicit key reuse only after pruning window', async () => {
    let now = 1_000;
    const custom = transport(async () => envelope({ saved: true }));
    const coordinator = createRequestCoordinator({
      transport: custom,
      clock: () => now,
      mutationSafetyOptions: {
        registryOptions: {
          retentionMs: 1_000,
        },
      },
    });
    const config = protectedMutation('mutation-coordinator-expire-0001', {
      maxRetries: 0,
      retryUnsafe: false,
    });

    await coordinator.request(config);
    await expect(coordinator.request(config)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });

    now += 1_000;
    await expect(coordinator.request(config)).resolves.toMatchObject({
      data: { saved: true },
    });
    expect(custom.request).toHaveBeenCalledTimes(2);
  });
});

describe('RequestCoordinator mutation observability', () => {
  test('diagnostics report mutation lifecycle without raw key', async () => {
    const secretKey = 'mutation-diagnostic-secret-0001';
    const custom = transport(async () => envelope({ saved: true }));
    const coordinator = createRequestCoordinator({ transport: custom });

    await coordinator.request(protectedMutation(secretKey, {
      maxRetries: 0,
      retryUnsafe: false,
    }));

    const serialized = JSON.stringify(coordinator.getDiagnostics());
    expect(serialized).toContain('network.mutation.admitted');
    expect(serialized).toContain('network.mutation.completed');
    expect(serialized).not.toContain(secretKey);
  });

  test('duplicate conflict is visible in mutation health without key identity', async () => {
    const gate = deferred<TransportResult<unknown>>();
    const custom = transport(async () => gate.promise);
    const coordinator = createRequestCoordinator({ transport: custom });
    const config = protectedMutation('mutation-health-conflict-0001', {
      maxRetries: 0,
      retryUnsafe: false,
    });

    const first = coordinator.request(config);
    await flush();
    await expect(coordinator.request(config)).rejects.toBeDefined();

    expect(coordinator.getMutationSafetyHealth()).toMatchObject({
      status: 'degraded',
      inFlightConflicts: 1,
      risks: [
        expect.objectContaining({
          code: 'in-flight-conflict',
        }),
      ],
    });
    expect(JSON.stringify(coordinator.getMutationSafetyHealth()))
      .not.toContain('mutation-health-conflict-0001');

    gate.resolve(envelope({ saved: true }));
    await first;
  });

  test('ordinary safe GET does not create network.mutation diagnostics', async () => {
    const custom = transport(async () => envelope({ ok: true }));
    const coordinator = createRequestCoordinator({ transport: custom });

    await coordinator.request({
      method: 'get',
      url: '/items',
    });

    expect(JSON.stringify(coordinator.getDiagnostics()))
      .not.toContain('network.mutation.');
  });

  test('dispose clears active mutation registry ownership', async () => {
    const custom = transport(async (config) =>
      new Promise<TransportResult<unknown>>((_resolve, reject) => {
        const signal = config.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
    const coordinator = createRequestCoordinator({ transport: custom });
    const running = coordinator.request(protectedMutation(
      'mutation-coordinator-dispose-0001',
      { maxRetries: 0, retryUnsafe: false },
    ));
    await flush();

    coordinator.dispose(new Error('application shutdown'));

    await expect(running).rejects.toBeDefined();
    expect(coordinator.getMutationSafetySnapshot()).toMatchObject({
      disposed: true,
      registry: {
        disposed: true,
        inFlight: 0,
      },
    });
  });
});

describe('ModernApiClient mutation safety facade', () => {
  test('exposes mutation snapshot and health methods without changing data facade', async () => {
    const custom = transport(async () => envelope({ saved: true }));
    const client = createApiClient({
      runtimeConfig: {
        apiBaseUrl: '/api',
        requestTimeoutMs: 5_000,
        maxRetries: 0,
        cacheTtlMs: 30_000,
      },
      transport: custom,
    });

    await expect(client.post('/items', { value: 1 }, {
      idempotencyKey: 'mutation-client-facade-0001',
      idempotencyPolicy: 'server-enforced',
    })).resolves.toEqual({ saved: true });

    expect(client.getMutationSafetySnapshot()).toMatchObject({
      protectedExecutions: 1,
      completedExecutions: 1,
    });
    expect(client.getMutationSafetyHealth()).toMatchObject({
      status: 'healthy',
      protectedExecutions: 1,
    });
  });
});
