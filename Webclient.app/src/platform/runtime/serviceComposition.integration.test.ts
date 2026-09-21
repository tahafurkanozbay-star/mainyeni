import { describe, expect, test, vi } from 'vitest';
import {
  createServiceContainer,
  createServiceToken,
} from './serviceContainer';
import {
  createServiceContainerHealthMonitor,
  evaluateServiceContainerHealth,
} from './serviceHealth';
import { createResourceScope } from './resourceScope';

describe('Platform service composition integration', () => {
  test('composes Platform -> GIS -> Experience without a second transport stack', async () => {
    const config = createServiceToken<{ readonly apiBase: string }>('platform-config');
    const network = createServiceToken<{ readonly sameOrigin: boolean }>('platform-network');
    const runtime = createServiceToken<{ readonly supervised: true }>('platform-runtime');
    const gis = createServiceToken<{ readonly spatial: true }>('gis-runtime');
    const experience = createServiceToken<{ readonly shell: true }>('experience-runtime');

    const container = createServiceContainer();
    container.register({
      token: config,
      version: '1.0.0',
      domain: 'platform',
      provides: ['runtime-config'],
      start: () => ({ apiBase: '/api' }),
    });
    container.register({
      token: network,
      version: '1.0.0',
      domain: 'platform',
      dependsOn: [config],
      consumes: ['runtime-config'],
      provides: ['governed-http'],
      start: ({ dependency }) => ({
        sameOrigin: dependency(config).apiBase.startsWith('/'),
      }),
    });
    container.register({
      token: runtime,
      version: '1.0.0',
      domain: 'platform',
      dependsOn: [network],
      consumes: ['governed-http'],
      provides: ['runtime-supervision'],
      start: () => ({ supervised: true }),
    });
    container.register({
      token: gis,
      version: '1.0.0',
      domain: 'gis',
      dependsOn: [runtime],
      consumes: ['runtime-supervision'],
      provides: ['spatial-runtime'],
      start: () => ({ spatial: true }),
    });
    container.register({
      token: experience,
      version: '1.0.0',
      domain: 'experience',
      dependsOn: [gis],
      consumes: ['spatial-runtime'],
      start: ({ dependency }) => ({
        shell: dependency(gis).spatial,
      }),
    });

    const snapshot = await container.start();

    expect(snapshot.state).toBe('ready');
    expect(snapshot.graph.startupOrder).toEqual([
      'platform-config',
      'platform-network',
      'platform-runtime',
      'gis-runtime',
      'experience-runtime',
    ]);
    expect(container.get(experience).shell).toBe(true);

    const serialized = JSON.stringify(snapshot).toLowerCase();
    expect(serialized).not.toContain('fetch(');
    expect(serialized).not.toContain('axios');
    expect(serialized).not.toContain('xmlhttprequest');
    expect(serialized).not.toContain('websocket');
    expect(serialized).not.toContain('eventsource');
  });

  test('resource scope abort owns the service container lifecycle', async () => {
    const scope = createResourceScope('application-runtime');
    const config = createServiceToken<{ readonly ready: true }>('config');
    const stopped: string[] = [];
    const container = createServiceContainer({
      parentSignal: scope.signal,
    });

    container.register({
      token: config,
      version: '1',
      domain: 'platform',
      start: () => ({ ready: true }),
      stop: () => {
        stopped.push('config');
      },
    });

    await container.start();
    expect(container.state).toBe('ready');

    await scope.dispose('application-unmount');
    await container.dispose('join-scope-disposal');

    expect(container.state).toBe('disposed');
    expect(stopped).toEqual(['config']);
  });

  test('required startup failure rolls back resources while health reports critical', async () => {
    const config = createServiceToken<{ readonly ready: true }>('config');
    const network = createServiceToken<{ readonly ready: true }>('network');
    const stopped: string[] = [];
    const container = createServiceContainer();

    container.register({
      token: config,
      version: '1',
      domain: 'platform',
      start: () => ({ ready: true }),
      stop: () => {
        stopped.push('config');
      },
    });
    container.register({
      token: network,
      version: '1',
      domain: 'platform',
      dependsOn: [config],
      start: () => {
        throw new Error('private upstream failure detail');
      },
    });

    await expect(container.start()).rejects.toBeDefined();

    const snapshot = container.snapshot();
    const health = evaluateServiceContainerHealth(snapshot);

    expect(snapshot.state).toBe('failed');
    expect(stopped).toEqual(['config']);
    expect(health.status).toBe('critical');
    expect(health.requiredFailures).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain('private upstream failure detail');
    expect(JSON.stringify(health)).not.toContain('private upstream failure detail');
  });

  test('optional diagnostic service failure degrades without blocking spatial runtime', async () => {
    const spatial = createServiceToken<{ readonly ready: true }>('spatial-runtime');
    const diagnostics = createServiceToken<{ readonly enabled: true }>('diagnostics');
    const container = createServiceContainer();

    container.register({
      token: spatial,
      version: '1',
      domain: 'gis',
      provides: ['spatial-runtime'],
      start: () => ({ ready: true }),
    });
    container.register({
      token: diagnostics,
      version: '1',
      domain: 'platform',
      criticality: 'optional',
      optionalDependencies: [spatial],
      start: () => {
        throw new Error('diagnostics unavailable');
      },
    });

    const snapshot = await container.start();
    const health = evaluateServiceContainerHealth(snapshot);

    expect(snapshot.state).toBe('degraded');
    expect(container.get(spatial).ready).toBe(true);
    expect(health.status).toBe('degraded');
    expect(health.optionalFailures).toBe(1);
  });

  test('lazy optional service does not consume startup budget until requested', async () => {
    const core = createServiceToken<{ readonly ready: true }>('core');
    const optional = createServiceToken<{ readonly ready: true }>('optional-tools');
    const startOptional = vi.fn(() => ({ ready: true as const }));
    const container = createServiceContainer();

    container.register({
      token: core,
      version: '1',
      domain: 'platform',
      start: () => ({ ready: true }),
    });
    container.register({
      token: optional,
      version: '1',
      domain: 'platform',
      criticality: 'optional',
      startup: 'lazy',
      optionalDependencies: [core],
      start: startOptional,
    });

    const started = await container.start();
    expect(started.state).toBe('ready');
    expect(startOptional).not.toHaveBeenCalled();

    const instance = await container.resolve(optional);
    expect(instance.ready).toBe(true);
    expect(startOptional).toHaveBeenCalledOnce();
  });

  test('health monitor observes lifecycle transitions only when sampled', async () => {
    let now = 10;
    const monitor = createServiceContainerHealthMonitor({
      historyLimit: 3,
      now: () => now,
    });
    const token = createServiceToken<{ readonly ready: true }>('core');
    const container = createServiceContainer();
    container.register({
      token,
      version: '1',
      domain: 'platform',
      start: () => ({ ready: true }),
    });

    await container.start();
    const ready = monitor.sample(container.snapshot());
    now += 1;
    await container.stop();
    const stopped = monitor.sample(container.snapshot());

    expect(ready.status).toBe('healthy');
    expect(stopped.status).toBe('healthy');
    expect(monitor.snapshot().samples).toBe(2);
    expect(monitor.snapshot().history).toHaveLength(2);
  });

  test('support snapshots expose topology and status but never service instance payloads', async () => {
    const token = createServiceToken<{ readonly token: string }>('credential-safe-service');
    const container = createServiceContainer();
    container.register({
      token,
      version: '1',
      domain: 'platform',
      start: () => ({
        token: 'do-not-expose-runtime-instance',
      }),
    });

    const snapshot = await container.start();
    const health = evaluateServiceContainerHealth(snapshot);
    const serialized = JSON.stringify({ snapshot, health });

    expect(serialized).not.toContain('do-not-expose-runtime-instance');
    expect(serialized).toContain('credential-safe-service');
  });

  test('composition remains network-agnostic and GIS protocol-neutral', async () => {
    const runtime = createServiceToken('runtime');
    const gis = createServiceToken('gis');
    const container = createServiceContainer();

    container.register({
      token: runtime,
      version: '1',
      domain: 'platform',
      provides: ['runtime-supervision'],
      start: () => ({ ready: true }),
    });
    container.register({
      token: gis,
      version: '1',
      domain: 'gis',
      dependsOn: [runtime],
      consumes: ['runtime-supervision'],
      start: () => ({ ready: true }),
    });

    const snapshot = await container.start();
    const serialized = JSON.stringify(snapshot).toLowerCase();

    expect(serialized).not.toContain('wms');
    expect(serialized).not.toContain('wfs');
    expect(serialized).not.toContain('wmts');
    expect(serialized).not.toContain('http://');
    expect(serialized).not.toContain('https://');
  });

  test('service container can be restarted after a controlled drain', async () => {
    const token = createServiceToken<{ readonly generation: number }>('restartable');
    let generation = 0;
    const container = createServiceContainer();
    container.register({
      token,
      version: '1',
      domain: 'platform',
      start: () => ({ generation: ++generation }),
    });

    const first = await container.start();
    expect(container.get(token).generation).toBe(1);
    await container.stop({ reason: 'deployment-drain' });
    const second = await container.start();

    expect(container.get(token).generation).toBe(2);
    expect(second.generation).toBe(first.generation + 1);
  });
});
