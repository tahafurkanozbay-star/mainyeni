import { describe, expect, test, vi } from 'vitest';
import {
  createServiceContainer,
  createServiceToken,
  ServiceContainerError,
  type ServiceContainerClock,
} from './serviceContainer';

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const createClock = () => {
  let now = 1_000;
  let sequence = 0;
  const timers = new Map<number, () => void>();
  const clock: ServiceContainerClock & {
    advance(ms: number): void;
    fireAll(): void;
    pending(): number;
    rewind(ms: number): void;
  } = {
    now: () => now,
    setTimeout: (callback) => {
      const id = ++sequence;
      timers.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      timers.delete(Number(handle));
    },
    advance: (ms) => { now += ms; },
    rewind: (ms) => { now -= ms; },
    fireAll: () => {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    pending: () => timers.size,
  };
  return clock;
};

const configToken = createServiceToken<{ readonly endpoint: string }>('config');
const networkToken = createServiceToken<{ readonly configEndpoint: string }>('network');
const gisToken = createServiceToken<{ readonly ready: true }>('gis');
const telemetryToken = createServiceToken<{ readonly events: number }>('telemetry');
const lazyToken = createServiceToken<{ readonly loaded: true }>('lazy-service');

const registerPlatformChain = (
  container: ReturnType<typeof createServiceContainer>,
  events: string[] = [],
): void => {
  container.register({
    token: configToken,
    version: '1.0.0',
    domain: 'platform',
    provides: ['runtime-config'],
    start: () => {
      events.push('start:config');
      return Object.freeze({ endpoint: '/api' });
    },
    stop: () => {
      events.push('stop:config');
    },
  });
  container.register({
    token: networkToken,
    version: '1.0.0',
    domain: 'platform',
    dependsOn: [configToken],
    consumes: ['runtime-config'],
    provides: ['governed-http'],
    start: ({ dependency }) => {
      events.push('start:network');
      const config = dependency(configToken);
      return Object.freeze({ configEndpoint: config.endpoint });
    },
    stop: () => {
      events.push('stop:network');
    },
  });
  container.register({
    token: gisToken,
    version: '1.0.0',
    domain: 'gis',
    dependsOn: [networkToken],
    consumes: ['governed-http'],
    provides: ['spatial-runtime'],
    start: () => {
      events.push('start:gis');
      return Object.freeze({ ready: true as const });
    },
    stop: () => {
      events.push('stop:gis');
    },
  });
};

describe('service token contracts', () => {
  test('normalizes a service token id', () => {
    expect(createServiceToken<number>(' Platform.Config ')).toEqual({
      id: 'platform.config',
    });
  });

  test('returns frozen token objects', () => {
    expect(Object.isFrozen(createServiceToken('config'))).toBe(true);
  });

  test.each([
    '',
    ' ',
    '1config',
    '../config',
    'config service',
    'x'.repeat(81),
  ])('rejects invalid token %s', (id) => {
    expect(() => createServiceToken(id))
      .toThrow(expect.objectContaining({ code: 'INVALID_DEFINITION' }));
  });
});

describe('ServiceContainer registration and graph sealing', () => {
  test('registers typed services without exposing instances in snapshot', () => {
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/private-api-path' }),
    });
    const snapshot = container.snapshot();
    expect(snapshot.services).toHaveLength(1);
    expect(snapshot.services[0]).toMatchObject({
      id: 'config',
      status: 'registered',
      starts: 0,
    });
    expect(JSON.stringify(snapshot)).not.toContain('/private-api-path');
  });

  test('seal validates and freezes registration', () => {
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
    });
    expect(container.seal().valid).toBe(true);
    expect(container.sealed).toBe(true);
    expect(() => container.register({
      token: networkToken,
      version: '1',
      domain: 'platform',
      start: () => ({ configEndpoint: '/api' }),
    })).toThrow(expect.objectContaining({ code: 'REGISTRATION_CLOSED' }));
  });

  test('seal fails closed for a missing required dependency', () => {
    const missing = createServiceToken('missing');
    const container = createServiceContainer();
    container.register({
      token: networkToken,
      version: '1',
      domain: 'platform',
      dependsOn: [missing],
      start: () => ({ configEndpoint: '/api' }),
    });
    expect(() => container.seal()).toThrow(
      expect.objectContaining({ code: 'GRAPH_INVALID' }),
    );
    expect(container.state).toBe('idle');
  });

  test('seal fails closed for a missing capability', () => {
    const container = createServiceContainer();
    container.register({
      token: gisToken,
      version: '1',
      domain: 'gis',
      consumes: ['governed-http'],
      start: () => ({ ready: true }),
    });
    expect(() => container.seal()).toThrow(
      expect.objectContaining({ code: 'GRAPH_INVALID' }),
    );
  });

  test('unregister function removes a service before seal', () => {
    const container = createServiceContainer();
    const unregister = container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
    });
    expect(container.has(configToken)).toBe(true);
    unregister();
    unregister();
    expect(container.has(configToken)).toBe(false);
    expect(container.snapshot().counters.removed).toBe(1);
  });

  test('remove reports whether service existed', () => {
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
    });
    expect(container.remove(configToken)).toBe(true);
    expect(container.remove(configToken)).toBe(false);
  });

  test('rejects duplicate service registration', () => {
    const container = createServiceContainer();
    const definition = {
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
    };
    container.register(definition);
    expect(() => container.register(definition)).toThrow();
  });

  test('enforces service capacity through graph policy', () => {
    const container = createServiceContainer({ maxServices: 1 });
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
    });
    expect(() => container.register({
      token: networkToken,
      version: '1',
      domain: 'platform',
      start: () => ({ configEndpoint: '/api' }),
    })).toThrow();
  });

  test('rejects lifecycle timeout over configured maximum', () => {
    const container = createServiceContainer({
      maxLifecycleTimeoutMs: 100,
      defaultLifecycleTimeoutMs: 50,
    });
    expect(() => container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      lifecycleTimeoutMs: 101,
      start: () => ({ endpoint: '/api' }),
    })).toThrow(expect.objectContaining({ code: 'INVALID_DEFINITION' }));
  });

  test('rejects non-function start hook at runtime', () => {
    const container = createServiceContainer();
    expect(() => container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: null as unknown as () => { endpoint: string },
    })).toThrow(expect.objectContaining({ code: 'INVALID_DEFINITION' }));
  });

  test('rejects non-function stop hook at runtime', () => {
    const container = createServiceContainer();
    expect(() => container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
      stop: 'bad' as unknown as () => void,
    })).toThrow(expect.objectContaining({ code: 'INVALID_DEFINITION' }));
  });
});

describe('ServiceContainer deterministic startup', () => {
  test('starts required chain in dependency order', async () => {
    const events: string[] = [];
    const container = createServiceContainer();
    registerPlatformChain(container, events);

    const snapshot = await container.start();

    expect(snapshot.state).toBe('ready');
    expect(events).toEqual([
      'start:config',
      'start:network',
      'start:gis',
    ]);
    expect(container.get(networkToken).configEndpoint).toBe('/api');
  });

  test('start is idempotent while ready', async () => {
    const start = vi.fn(() => ({ endpoint: '/api' }));
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start,
    });
    const first = await container.start();
    const second = await container.start();
    expect(start).toHaveBeenCalledOnce();
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  test('concurrent start calls share one lifecycle run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const start = vi.fn(async () => {
      await gate;
      return { endpoint: '/api' };
    });
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start,
    });

    const first = container.start();
    const second = container.start();
    await flush();
    expect(start).toHaveBeenCalledOnce();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  test('does not autostart lazy service', async () => {
    const lazyStart = vi.fn(() => ({ loaded: true as const }));
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
    });
    container.register({
      token: lazyToken,
      version: '1',
      domain: 'platform',
      startup: 'lazy',
      start: lazyStart,
    });

    const snapshot = await container.start();
    expect(snapshot.state).toBe('ready');
    expect(lazyStart).not.toHaveBeenCalled();
    expect(snapshot.services.find((service) => service.id === 'lazy-service')?.status)
      .toBe('registered');
  });

  test('autostarts lazy dependency required by eager service', async () => {
    const lazyStart = vi.fn(() => ({ loaded: true as const }));
    const consumer = createServiceToken<{ readonly ok: true }>('consumer');
    const container = createServiceContainer();
    container.register({
      token: lazyToken,
      version: '1',
      domain: 'platform',
      startup: 'lazy',
      start: lazyStart,
    });
    container.register({
      token: consumer,
      version: '1',
      domain: 'platform',
      dependsOn: [lazyToken],
      start: ({ dependency }) => {
        expect(dependency(lazyToken).loaded).toBe(true);
        return { ok: true };
      },
    });

    await container.start();
    expect(lazyStart).toHaveBeenCalledOnce();
  });

  test('resolve starts lazy service on demand', async () => {
    const container = createServiceContainer();
    container.register({
      token: lazyToken,
      version: '1',
      domain: 'platform',
      startup: 'lazy',
      start: () => ({ loaded: true }),
    });
    await container.start();
    expect(container.snapshot().services[0]?.status).toBe('registered');
    await expect(container.resolve(lazyToken)).resolves.toEqual({ loaded: true });
    expect(container.state).toBe('ready');
  });

  test('concurrent lazy resolves deduplicate factory', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const factory = vi.fn(async () => {
      await gate;
      return { loaded: true as const };
    });
    const container = createServiceContainer();
    container.register({
      token: lazyToken,
      version: '1',
      domain: 'platform',
      startup: 'lazy',
      start: factory,
    });
    await container.start();

    const first = container.resolve(lazyToken);
    const second = container.resolve(lazyToken);
    await flush();
    expect(factory).toHaveBeenCalledOnce();
    release();
    const values = await Promise.all([first, second]);
    expect(values).toEqual([{ loaded: true }, { loaded: true }]);
  });

  test('required dependency may legitimately resolve to undefined', async () => {
    const voidToken = createServiceToken<undefined>('void-service');
    const consumer = createServiceToken<{ readonly observed: boolean }>('consumer');
    const container = createServiceContainer();
    container.register({
      token: voidToken,
      version: '1',
      domain: 'platform',
      start: () => undefined,
    });
    container.register({
      token: consumer,
      version: '1',
      domain: 'platform',
      dependsOn: [voidToken],
      start: ({ dependency }) => ({
        observed: dependency(voidToken) === undefined,
      }),
    });
    await container.start();
    expect(container.get(consumer).observed).toBe(true);
  });

  test('factory only accesses declared required dependency', async () => {
    const rogue = createServiceToken<{ readonly value: string }>('rogue');
    const consumer = createServiceToken<{ readonly ok: true }>('consumer');
    const container = createServiceContainer();
    container.register({
      token: rogue,
      version: '1',
      domain: 'platform',
      start: () => ({ value: 'private' }),
    });
    container.register({
      token: consumer,
      version: '1',
      domain: 'platform',
      start: ({ dependency }) => {
        dependency(rogue);
        return { ok: true };
      },
    });

    await expect(container.start()).rejects.toMatchObject({
      code: 'DEPENDENCY_NOT_DECLARED',
      serviceId: 'consumer',
    });
  });

  test('optional dependency startup failure is retained as explicit evidence', async () => {
    const failing = createServiceToken<{ readonly ready: true }>('optional-failing');
    const consumer = createServiceToken<{ readonly ready: true }>('consumer');
    const container = createServiceContainer();

    container.register({
      token: failing,
      version: '1',
      domain: 'platform',
      criticality: 'optional',
      startup: 'lazy',
      start: () => {
        throw new Error('private optional failure detail');
      },
    });
    container.register({
      token: consumer,
      version: '1',
      domain: 'platform',
      optionalDependencies: [failing],
      start: () => ({ ready: true }),
    });

    const started = await container.start();
    expect(started.state).toBe('degraded');
    expect(started.counters.optionalDependencyFailures).toBe(1);
    expect(started.events).toContainEqual(expect.objectContaining({
      kind: 'optional-dependency-failed',
      serviceId: 'consumer',
      dependencyId: 'optional-failing',
      errorName: 'Error',
    }));
    expect(JSON.stringify(started)).not.toContain('private optional failure detail');
  });

  test('optional accessor returns undefined for absent optional dependency', async () => {
    const missing = createServiceToken<{ readonly enabled: true }>('optional-plugin');
    const consumer = createServiceToken<{ readonly plugin: boolean }>('consumer');
    const container = createServiceContainer();
    container.register({
      token: consumer,
      version: '1',
      domain: 'platform',
      optionalDependencies: [missing],
      start: ({ optional }) => ({
        plugin: optional(missing) !== undefined,
      }),
    });
    await container.start();
    expect(container.get(consumer).plugin).toBe(false);
  });

  test('optional accessor may read declared required dependency', async () => {
    const consumer = createServiceToken<{ readonly endpoint: string }>('consumer');
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
    });
    container.register({
      token: consumer,
      version: '1',
      domain: 'platform',
      dependsOn: [configToken],
      start: ({ optional }) => ({
        endpoint: optional(configToken)?.endpoint ?? 'missing',
      }),
    });
    await container.start();
    expect(container.get(consumer).endpoint).toBe('/api');
  });

  test('get fails before lazy service is ready', async () => {
    const container = createServiceContainer();
    container.register({
      token: lazyToken,
      version: '1',
      domain: 'platform',
      startup: 'lazy',
      start: () => ({ loaded: true }),
    });
    await container.start();
    expect(() => container.get(lazyToken)).toThrow(
      expect.objectContaining({ code: 'SERVICE_NOT_READY' }),
    );
  });

  test('resolve rejects unknown service', async () => {
    const container = createServiceContainer();
    await expect(container.resolve(createServiceToken('missing')))
      .rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' });
  });

  test('get rejects unknown service', () => {
    const container = createServiceContainer();
    expect(() => container.get(createServiceToken('missing')))
      .toThrow(expect.objectContaining({ code: 'SERVICE_NOT_FOUND' }));
  });
});

describe('ServiceContainer failure containment', () => {
  test('optional eager service failure degrades without blocking required service', async () => {
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
    });
    container.register({
      token: telemetryToken,
      version: '1',
      domain: 'platform',
      criticality: 'optional',
      start: () => {
        throw new Error('private telemetry detail');
      },
    });

    const snapshot = await container.start();
    expect(snapshot.state).toBe('degraded');
    expect(container.get(configToken).endpoint).toBe('/api');
    expect(snapshot.services.find((service) => service.id === 'telemetry'))
      .toMatchObject({
        status: 'failed',
        errorName: 'Error',
        failureCode: 'START_FAILED',
      });
    expect(JSON.stringify(snapshot)).not.toContain('private telemetry detail');
  });

  test('required service failure rolls back already started services in reverse order', async () => {
    const events: string[] = [];
    const failing = createServiceToken('failing');
    const container = createServiceContainer();
    registerPlatformChain(container, events);
    container.register({
      token: failing,
      version: '1',
      domain: 'platform',
      dependsOn: [gisToken],
      start: () => {
        events.push('start:failing');
        throw new Error('boom');
      },
    });

    await expect(container.start()).rejects.toBeInstanceOf(ServiceContainerError);
    expect(container.state).toBe('failed');
    expect(events).toEqual([
      'start:config',
      'start:network',
      'start:gis',
      'start:failing',
      'stop:gis',
      'stop:network',
      'stop:config',
    ]);
    expect(container.snapshot().counters.rollbacks).toBe(1);
  });

  test('required dependency failure is surfaced as unavailable to dependent', async () => {
    const failing = createServiceToken('failing');
    const consumer = createServiceToken('consumer');
    const container = createServiceContainer();
    container.register({
      token: failing,
      version: '1',
      domain: 'platform',
      criticality: 'optional',
      start: () => {
        throw new Error('fail');
      },
    });
    container.register({
      token: consumer,
      version: '1',
      domain: 'platform',
      dependsOn: [failing],
      start: () => ({ ok: true }),
    });

    await expect(container.start()).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      serviceId: 'consumer',
    });
  });

  test('lazy required service failure updates container state to failed', async () => {
    const failing = createServiceToken('lazy-failing');
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
    });
    container.register({
      token: failing,
      version: '1',
      domain: 'platform',
      startup: 'lazy',
      start: () => {
        throw new Error('lazy fail');
      },
    });
    await container.start();
    await expect(container.resolve(failing)).rejects.toBeDefined();
    expect(container.state).toBe('failed');
  });

  test('lazy optional service failure degrades an otherwise ready container', async () => {
    const failing = createServiceToken('optional-lazy');
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
    });
    container.register({
      token: failing,
      version: '1',
      domain: 'platform',
      startup: 'lazy',
      criticality: 'optional',
      start: () => {
        throw new Error('optional lazy fail');
      },
    });
    await container.start();
    await expect(container.resolve(failing)).rejects.toBeDefined();
    expect(container.state).toBe('degraded');
  });

  test('factory receives abort signal', async () => {
    const observed: AbortSignal[] = [];
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: ({ signal }) => {
        observed.push(signal);
        return { endpoint: '/api' };
      },
    });
    await container.start();
    expect(observed[0]?.aborted).toBe(false);
    await container.stop();
    expect(observed[0]?.aborted).toBe(true);
  });
});

describe('ServiceContainer lifecycle timeouts', () => {
  test('times out a stuck service startup', async () => {
    const clock = createClock();
    const container = createServiceContainer({
      clock,
      defaultLifecycleTimeoutMs: 50,
      maxLifecycleTimeoutMs: 500,
    });
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => new Promise(() => undefined),
    });

    const start = container.start();
    await flush();
    expect(clock.pending()).toBe(1);
    clock.advance(50);
    clock.fireAll();

    await expect(start).rejects.toMatchObject({
      code: 'START_TIMEOUT',
      serviceId: 'config',
    });
    expect(container.snapshot().services[0]).toMatchObject({
      status: 'failed',
      failureCode: 'START_TIMEOUT',
    });
  });

  test('uses per-service startup timeout override', async () => {
    const clock = createClock();
    const container = createServiceContainer({
      clock,
      defaultLifecycleTimeoutMs: 100,
      maxLifecycleTimeoutMs: 500,
    });
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      lifecycleTimeoutMs: 25,
      start: () => new Promise(() => undefined),
    });

    const start = container.start();
    await flush();
    clock.advance(25);
    clock.fireAll();
    await expect(start).rejects.toMatchObject({ code: 'START_TIMEOUT' });
  });

  test('clears lifecycle timer after successful startup', async () => {
    const clock = createClock();
    const container = createServiceContainer({
      clock,
      defaultLifecycleTimeoutMs: 100,
    });
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
    });
    await container.start();
    expect(clock.pending()).toBe(0);
  });

  test('rejects backward moving injected clock', async () => {
    const clock = createClock();
    const container = createServiceContainer({ clock });
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
    });
    await container.start();
    clock.rewind(1);
    expect(() => container.snapshot()).not.toThrow();
    expect(() => container.stop()).not.toThrow();
    await expect(container.stop()).rejects.toBeDefined();
  });
});

describe('ServiceContainer deterministic shutdown', () => {
  test('stops services in reverse dependency order', async () => {
    const events: string[] = [];
    const container = createServiceContainer();
    registerPlatformChain(container, events);
    await container.start();
    events.splice(0, events.length);

    const snapshot = await container.stop({ reason: 'route-change' });

    expect(snapshot.state).toBe('stopped');
    expect(events).toEqual([
      'stop:gis',
      'stop:network',
      'stop:config',
    ]);
  });

  test('stop is idempotent after already stopped', async () => {
    const stop = vi.fn();
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
      stop,
    });
    await container.start();
    await container.stop();
    await container.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  test('calls stop hook even when service instance is undefined', async () => {
    const voidToken = createServiceToken<undefined>('void-service');
    const stop = vi.fn();
    const container = createServiceContainer();
    container.register({
      token: voidToken,
      version: '1',
      domain: 'platform',
      start: () => undefined,
      stop,
    });
    await container.start();
    await container.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  test('passes bounded reason into stop context', async () => {
    const reasons: string[] = [];
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
      stop: (_instance, context) => {
        reasons.push(context.reason);
      },
    });
    await container.start();
    await container.stop({ reason: 'line-one\nline-two\tprivate' });
    expect(reasons).toEqual(['line-one line-two private']);
  });

  test('continues stopping after one stop hook fails', async () => {
    const first = createServiceToken('first');
    const second = createServiceToken('second');
    const stopped: string[] = [];
    const container = createServiceContainer();
    container.register({
      token: first,
      version: '1',
      domain: 'platform',
      start: () => ({ ok: true }),
      stop: () => {
        stopped.push('first');
      },
    });
    container.register({
      token: second,
      version: '1',
      domain: 'platform',
      dependsOn: [first],
      start: () => ({ ok: true }),
      stop: () => {
        stopped.push('second');
        throw new Error('private stop detail');
      },
    });
    await container.start();
    await expect(container.stop()).rejects.toBeInstanceOf(AggregateError);
    expect(stopped).toEqual(['second', 'first']);
    expect(container.state).toBe('stopped');
    expect(JSON.stringify(container.snapshot())).not.toContain('private stop detail');
  });

  test('can suppress aggregate stop throw while retaining evidence', async () => {
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
      stop: () => {
        throw new Error('stop failed');
      },
    });
    await container.start();
    const snapshot = await container.stop({ throwOnStopError: false });
    expect(snapshot.state).toBe('stopped');
    expect(snapshot.counters.stopFailures).toBe(1);
  });

  test('times out stuck stop hook and aborts stop signal', async () => {
    const clock = createClock();
    let stopSignal: AbortSignal | undefined;
    const container = createServiceContainer({
      clock,
      defaultLifecycleTimeoutMs: 20,
      maxLifecycleTimeoutMs: 100,
    });
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
      stop: (_instance, context) => {
        stopSignal = context.signal;
        return new Promise(() => undefined);
      },
    });
    await container.start();

    const stop = container.stop();
    await flush();
    clock.advance(20);
    clock.fireAll();

    await expect(stop).rejects.toBeInstanceOf(AggregateError);
    expect(stopSignal?.aborted).toBe(true);
    expect(container.snapshot().services[0]?.failureCode).toBe('STOP_TIMEOUT');
  });

  test('can restart after stop using immutable definitions', async () => {
    const start = vi.fn(() => ({ endpoint: '/api' }));
    const stop = vi.fn();
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start,
      stop,
    });
    await container.start();
    await container.stop();
    const restarted = await container.start();
    expect(restarted.state).toBe('ready');
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
    expect(restarted.generation).toBe(2);
  });
});

describe('ServiceContainer events and support snapshots', () => {
  test('records bounded lifecycle events', async () => {
    const container = createServiceContainer({ historyLimit: 4 });
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
      stop: () => undefined,
    });
    await container.start();
    await container.stop();
    const events = container.snapshot().events;
    expect(events).toHaveLength(4);
    expect(events.at(-1)?.kind).toBe('container-stopped');
  });

  test('history can be disabled', async () => {
    const container = createServiceContainer({ historyLimit: 0 });
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
    });
    await container.start();
    expect(container.snapshot().events).toEqual([]);
  });

  test('observer failure is isolated and recorded without recursive callback', async () => {
    const observer = vi.fn(() => {
      throw new Error('observer private detail');
    });
    const container = createServiceContainer({ onEvent: observer });
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
    });
    await expect(container.start()).resolves.toMatchObject({ state: 'ready' });
    const snapshot = container.snapshot();
    expect(snapshot.counters.observerFailures).toBeGreaterThan(0);
    expect(snapshot.events.some((event) => event.kind === 'observer-failed')).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('observer private detail');
  });

  test('snapshot is deeply support-safe and immutable at top-level collections', async () => {
    const secret = 'secret-instance-value';
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: secret }),
    });
    const snapshot = await container.start();
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.services)).toBe(true);
    expect(Object.isFrozen(snapshot.events)).toBe(true);
    expect(Object.isFrozen(snapshot.counters)).toBe(true);
  });

  test('snapshot fingerprint is stable across repeated reads', async () => {
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
    });
    await container.start();
    expect(container.snapshot().fingerprint).toBe(container.snapshot().fingerprint);
  });

  test('snapshot fingerprint changes across lifecycle generation', async () => {
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
    });
    const first = await container.start();
    await container.stop();
    const second = await container.start();
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  test('service timings use injected monotonic clock', async () => {
    const clock = createClock();
    const container = createServiceContainer({ clock });
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: async () => {
        clock.advance(7);
        return { endpoint: '/api' };
      },
      stop: async () => {
        clock.advance(3);
      },
    });
    await container.start();
    await container.stop();
    expect(container.snapshot().services[0]).toMatchObject({
      startDurationMs: 7,
      stopDurationMs: 3,
    });
  });
});

describe('ServiceContainer parent cancellation and disposal', () => {
  test('parent abort disposes child container without throwing to caller', async () => {
    const parent = new AbortController();
    const stop = vi.fn();
    const container = createServiceContainer({ parentSignal: parent.signal });
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
      stop,
    });
    await container.start();
    parent.abort('application-shutdown');
    await flush();
    expect(container.state).toBe('disposed');
    expect(stop).toHaveBeenCalledOnce();
  });

  test('already aborted parent creates disposed container', () => {
    const parent = new AbortController();
    parent.abort('already-stopped');
    const container = createServiceContainer({ parentSignal: parent.signal });
    expect(container.state).toBe('disposed');
    expect(() => container.has(configToken)).toThrow(
      expect.objectContaining({ code: 'CONTAINER_DISPOSED' }),
    );
  });

  test('dispose stops services and rejects subsequent access', async () => {
    const stop = vi.fn();
    const container = createServiceContainer();
    container.register({
      token: configToken,
      version: '1',
      domain: 'platform',
      start: () => ({ endpoint: '/api' }),
      stop,
    });
    await container.start();
    await container.dispose('test-dispose');
    expect(stop).toHaveBeenCalledOnce();
    expect(container.state).toBe('disposed');
    expect(() => container.get(configToken)).toThrow(
      expect.objectContaining({ code: 'CONTAINER_DISPOSED' }),
    );
    expect(() => container.snapshot()).toThrow(
      expect.objectContaining({ code: 'CONTAINER_DISPOSED' }),
    );
  });

  test('dispose is idempotent', async () => {
    const container = createServiceContainer();
    await container.dispose();
    await expect(container.dispose()).resolves.toBeUndefined();
  });
});

describe('Platform composition integration contract', () => {
  test('models config, governed network, GIS and optional telemetry without duplicate transport', async () => {
    const shell = createServiceToken<{ readonly ready: boolean }>('experience-shell');
    const container = createServiceContainer();
    registerPlatformChain(container);
    container.register({
      token: telemetryToken,
      version: '1',
      domain: 'platform',
      criticality: 'optional',
      startup: 'lazy',
      optionalDependencies: [networkToken],
      start: ({ optional }) => ({
        events: optional(networkToken) ? 0 : 0,
      }),
    });
    container.register({
      token: shell,
      version: '1',
      domain: 'experience',
      dependsOn: [gisToken],
      consumes: ['spatial-runtime'],
      start: ({ dependency }) => ({
        ready: dependency(gisToken).ready,
      }),
    });

    const snapshot = await container.start();
    expect(snapshot.state).toBe('ready');
    expect(container.get(shell).ready).toBe(true);
    expect(snapshot.services.find((service) => service.id === 'telemetry')?.status)
      .toBe('registered');

    const serialized = JSON.stringify(snapshot).toLowerCase();
    expect(serialized).not.toContain('fetch(');
    expect(serialized).not.toContain('axios');
    expect(serialized).not.toContain('xmlhttprequest');
    expect(serialized).not.toContain('websocket');
    expect(serialized).not.toContain('wms');
    expect(serialized).not.toContain('wfs');
  });

  test('graph startup order remains Platform -> GIS -> Experience', async () => {
    const shell = createServiceToken('experience-shell');
    const container = createServiceContainer();
    registerPlatformChain(container);
    container.register({
      token: shell,
      version: '1',
      domain: 'experience',
      dependsOn: [gisToken],
      consumes: ['spatial-runtime'],
      start: () => ({ ready: true }),
    });
    const snapshot = await container.start();
    expect(snapshot.graph.startupOrder).toEqual([
      'config',
      'network',
      'gis',
      'experience-shell',
    ]);
  });
});
