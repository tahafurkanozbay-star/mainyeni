import { describe, expect, test, vi } from 'vitest';
import {
  ComponentUnavailableError,
  RuntimeNotReadyError,
  RuntimeSupervisor,
} from './runtimeSupervisor';

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('RuntimeSupervisor composition', () => {
  test('starts registered runtime components and exposes one aggregate snapshot', async () => {
    let now = 100;
    const supervisor = new RuntimeSupervisor({
      lifecycle: { clock: { now: () => now } },
      requests: { now: () => now },
    });
    supervisor.register({
      id: 'config',
      phase: 'bootstrap',
      criticality: 'critical',
      start: () => undefined,
      stop: () => undefined,
    });
    supervisor.register({
      id: 'http',
      phase: 'core',
      criticality: 'critical',
      dependencies: [{ id: 'config' }],
      start: () => undefined,
      stop: () => undefined,
    });

    const result = await supervisor.start();
    expect(result.success).toBe(true);
    expect(supervisor.started).toBe(true);
    now = 150;
    const snapshot = supervisor.snapshot();
    expect(snapshot.generatedAt).toBe(150);
    expect(snapshot.graph.startupOrder).toEqual(['config', 'http']);
    expect(snapshot.lifecycle.map((entry) => [entry.id, entry.state])).toEqual([
      ['config', 'running'],
      ['http', 'running'],
    ]);
    expect(snapshot.readiness.status).toBe('ready');
    expect(snapshot.requests).toMatchObject({ active: 0, queued: 0 });
  });

  test('rejects readiness-gated work before critical components are healthy', async () => {
    const supervisor = new RuntimeSupervisor();
    supervisor.register({
      id: 'config', criticality: 'critical', start: () => undefined,
    });
    await expect(supervisor.execute(async () => 'nope', { key: 'early' }))
      .rejects.toBeInstanceOf(RuntimeNotReadyError);
  });

  test('executes coordinated work once runtime readiness is satisfied', async () => {
    const supervisor = new RuntimeSupervisor();
    supervisor.register({
      id: 'config', criticality: 'critical', start: () => undefined,
    });
    await supervisor.start();
    const result = supervisor.execute(async ({ key, lane }) => `${lane}:${key}`, {
      key: 'districts',
      lane: 'search',
      componentId: 'config',
    });
    await expect(result).resolves.toBe('search:districts');
    expect(supervisor.snapshot().requests.completed).toBe(1);
  });

  test('caller can explicitly bypass readiness for recovery work', async () => {
    const supervisor = new RuntimeSupervisor();
    supervisor.register({ id: 'config', criticality: 'critical', start: () => undefined });
    await expect(supervisor.execute(async () => 'recovery', {
      key: 'recovery', requireReady: false,
    })).resolves.toBe('recovery');
  });

  test('component-bound work fails closed when component is unhealthy', async () => {
    const supervisor = new RuntimeSupervisor();
    supervisor.register({ id: 'config', criticality: 'critical', start: () => undefined });
    await supervisor.start();
    supervisor.reportHealth({ componentId: 'config', status: 'unhealthy', message: 'bad config' });
    await expect(supervisor.execute(async () => 'work', {
      key: 'work', componentId: 'config', requireReady: false,
    })).rejects.toBeInstanceOf(ComponentUnavailableError);
  });

  test('same-key supervisor work inherits request deduplication', async () => {
    const supervisor = new RuntimeSupervisor();
    const operation = vi.fn(async () => 'shared');
    const first = supervisor.execute(operation, { key: 'same', requireReady: false });
    const second = supervisor.execute(operation, { key: 'same', requireReady: false });
    await expect(Promise.all([first, second])).resolves.toEqual(['shared', 'shared']);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(supervisor.snapshot().requests.deduplicated).toBe(1);
  });
});

describe('RuntimeSupervisor events and restart', () => {
  test('records bounded lifecycle, health, request and supervisor events', async () => {
    const observer = vi.fn();
    const supervisor = new RuntimeSupervisor({ eventHistoryLimit: 16, onEvent: observer });
    supervisor.register({
      id: 'config', criticality: 'critical', start: () => undefined, stop: () => undefined,
    });
    await supervisor.start();
    await supervisor.execute(async () => 'ok', { key: 'work' });
    supervisor.reportHealth({ componentId: 'config', status: 'degraded' });

    const events = supervisor.events();
    expect(events.some((event) => event.name === 'component-registered')).toBe(true);
    expect(events.some((event) => event.name === 'component-started')).toBe(true);
    expect(events.some((event) => event.name === 'request-state')).toBe(true);
    expect(events.some((event) => event.name === 'health-change')).toBe(true);
    expect(observer).toHaveBeenCalled();
  });

  test('event observer failures are isolated from supervisor control flow', async () => {
    const supervisor = new RuntimeSupervisor({
      onEvent: () => { throw new Error('event sink unavailable'); },
    });
    supervisor.register({ id: 'config', criticality: 'critical', start: () => undefined });
    await expect(supervisor.start()).resolves.toMatchObject({ success: true });
  });

  test('event history is bounded and can be cleared', async () => {
    const supervisor = new RuntimeSupervisor({ eventHistoryLimit: 16 });
    for (let index = 0; index < 20; index += 1) {
      supervisor.reportHealth({ componentId: `component-${index}`, status: 'healthy' });
    }
    expect(supervisor.events().length).toBe(16);
    supervisor.clearEvents();
    expect(supervisor.events()).toEqual([]);
  });

  test('restart uses lifecycle dependency-aware restart semantics', async () => {
    const events: string[] = [];
    const supervisor = new RuntimeSupervisor();
    supervisor.register({
      id: 'http', criticality: 'critical',
      start: () => { events.push('start:http'); },
      stop: () => { events.push('stop:http'); },
    });
    supervisor.register({
      id: 'search', dependencies: [{ id: 'http' }],
      start: () => { events.push('start:search'); },
      stop: () => { events.push('stop:search'); },
    });
    await supervisor.start();
    events.splice(0);
    await supervisor.restart('http');
    expect(events).toEqual(['stop:search', 'stop:http', 'start:http', 'start:search']);
  });

  test('unregister removes idle components and records the action', () => {
    const supervisor = new RuntimeSupervisor();
    supervisor.register({ id: 'temporary', start: () => undefined });
    expect(supervisor.unregister('temporary')).toBe(true);
    expect(supervisor.snapshot().graph.startupOrder).toEqual([]);
    expect(supervisor.events().at(-1)?.name).toBe('component-unregistered');
  });
});

describe('RuntimeSupervisor shutdown', () => {
  test('stop disposes queued request work before lifecycle shutdown', async () => {
    const supervisor = new RuntimeSupervisor({ requests: { concurrency: 1 } });
    supervisor.register({
      id: 'config', criticality: 'critical', start: () => undefined, stop: () => undefined,
    });
    await supervisor.start();
    const active = supervisor.execute(async ({ signal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { key: 'active' });
    const queued = supervisor.execute(async () => undefined, { key: 'queued' });
    await flush();

    const stop = supervisor.stop();
    await expect(active).rejects.toMatchObject({ name: 'AbortError' });
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await expect(stop).resolves.toMatchObject({ success: true });
    expect(supervisor.started).toBe(false);
  });

  test('cancelRequest delegates to bounded request coordination', async () => {
    const supervisor = new RuntimeSupervisor();
    const pending = supervisor.execute(async ({ signal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { key: 'cancel-me', requireReady: false });
    await flush();
    expect(supervisor.cancelRequest('cancel-me')).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
