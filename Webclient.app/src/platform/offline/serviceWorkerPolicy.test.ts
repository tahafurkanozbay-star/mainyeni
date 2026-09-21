import { describe, expect, it, vi } from 'vitest';
import { ServiceWorkerPolicy, type ServiceWorkerHandle, type ServiceWorkerNavigatorPort, type ServiceWorkerRegistrationPort } from './serviceWorkerPolicy';

class Worker implements ServiceWorkerHandle {
  state = 'installed';
  readonly messages: Readonly<Record<string, unknown>>[] = [];
  readonly #listeners = new Set<() => void>();
  postMessage(message: Readonly<Record<string, unknown>>): void { (this.messages as Readonly<Record<string, unknown>>[]).push(message); }
  addEventListener(_type: 'statechange', listener: () => void): void { this.#listeners.add(listener); }
  removeEventListener(_type: 'statechange', listener: () => void): void { this.#listeners.delete(listener); }
  emit(state: string): void { this.state = state; for (const listener of this.#listeners) listener(); }
}

class Registration implements ServiceWorkerRegistrationPort {
  scope = '/';
  active: ServiceWorkerHandle | null = null;
  waiting: ServiceWorkerHandle | null = null;
  installing: ServiceWorkerHandle | null = null;
  updates = 0;
  readonly #listeners = new Set<() => void>();
  async update(): Promise<void> { this.updates += 1; }
  async unregister(): Promise<boolean> { return true; }
  addEventListener(_type: 'updatefound', listener: () => void): void { this.#listeners.add(listener); }
  removeEventListener(_type: 'updatefound', listener: () => void): void { this.#listeners.delete(listener); }
  emitUpdateFound(): void { for (const listener of this.#listeners) listener(); }
}

class NavigatorPort implements ServiceWorkerNavigatorPort {
  controller: ServiceWorkerHandle | null = null;
  readonly registration = new Registration();
  registrations = 0;
  lastScript = '';
  lastOptions: { scope: string; updateViaCache: 'none' } | undefined;
  readonly #listeners = new Set<() => void>();
  get ready(): Promise<ServiceWorkerRegistrationPort> { return Promise.resolve(this.registration); }
  async register(scriptUrl: string, options: { scope: string; updateViaCache: 'none' }): Promise<ServiceWorkerRegistrationPort> {
    this.registrations += 1; this.lastScript = scriptUrl; this.lastOptions = options; return this.registration;
  }
  addEventListener(_type: 'controllerchange', listener: () => void): void { this.#listeners.add(listener); }
  removeEventListener(_type: 'controllerchange', listener: () => void): void { this.#listeners.delete(listener); }
  emitControllerChange(): void { for (const listener of this.#listeners) listener(); }
}

describe('ServiceWorkerPolicy', () => {
  it('starts idle and unsupported until a port is attached', () => {
    expect(new ServiceWorkerPolicy().snapshot()).toMatchObject({ phase: 'idle', supported: false, registered: false });
  });

  it('registers only a same-origin absolute script path', async () => {
    const port = new NavigatorPort();
    const policy = new ServiceWorkerPolicy();
    policy.attach(port);
    await policy.register();
    expect(port.lastScript).toBe('/service-worker.js');
    expect(port.lastOptions).toEqual({ scope: '/', updateViaCache: 'none' });
    expect(policy.snapshot()).toMatchObject({ phase: 'active', supported: true, registered: true });
  });

  it('rejects remote script URLs', () => {
    expect(() => new ServiceWorkerPolicy({ scriptUrl: 'https://example.com/sw.js' })).toThrow(TypeError);
    expect(() => new ServiceWorkerPolicy({ scriptUrl: '//example.com/sw.js' })).toThrow(TypeError);
  });

  it('rejects remote-looking scope', () => {
    expect(() => new ServiceWorkerPolicy({ scope: '//example.com/' })).toThrow(TypeError);
  });

  it('rejects control characters in paths', () => {
    expect(() => new ServiceWorkerPolicy({ scriptUrl: '/sw.js\n' })).toThrow(TypeError);
  });

  it('does not throw when service workers are unsupported', async () => {
    const policy = new ServiceWorkerPolicy();
    await policy.register();
    expect(policy.snapshot()).toMatchObject({ phase: 'degraded', reason: 'unsupported' });
  });

  it('coalesces concurrent registration calls', async () => {
    const port = new NavigatorPort();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = port.register.bind(port);
    port.register = async (...args) => { await gate; return original(...args); };
    const policy = new ServiceWorkerPolicy();
    policy.attach(port);
    const first = policy.register();
    const second = policy.register();
    release();
    await Promise.all([first, second]);
    expect(port.registrations).toBe(1);
  });

  it('records registration history without unbounded growth', async () => {
    const port = new NavigatorPort();
    const policy = new ServiceWorkerPolicy({ historyLimit: 2 });
    policy.attach(port);
    await policy.register();
    await policy.checkForUpdate('manual');
    expect(policy.history()).toHaveLength(2);
    expect(policy.history().map(item => item.action)).toEqual(['registered', 'check']);
  });

  it('can disable diagnostics history', async () => {
    const port = new NavigatorPort();
    const policy = new ServiceWorkerPolicy({ historyLimit: 0 });
    policy.attach(port);
    await policy.register();
    expect(policy.history()).toEqual([]);
  });

  it('rate limits automatic focus update checks', async () => {
    let now = 1_000;
    const port = new NavigatorPort();
    const policy = new ServiceWorkerPolicy({ clock: () => now, minUpdateIntervalMs: 10_000 });
    policy.attach(port);
    await policy.register();
    expect(await policy.checkForUpdate('focus')).toBe(true);
    now += 1_000;
    expect(await policy.checkForUpdate('focus')).toBe(false);
    expect(port.registration.updates).toBe(1);
    now += 10_000;
    expect(await policy.checkForUpdate('focus')).toBe(true);
    expect(port.registration.updates).toBe(2);
  });

  it('allows explicit manual checks inside the automatic interval', async () => {
    const port = new NavigatorPort();
    const policy = new ServiceWorkerPolicy({ clock: () => 1_000, minUpdateIntervalMs: 10_000 });
    policy.attach(port);
    await policy.register();
    await policy.checkForUpdate('manual');
    await policy.checkForUpdate('manual');
    expect(port.registration.updates).toBe(2);
  });

  it('captures a waiting worker after update', async () => {
    const port = new NavigatorPort();
    const policy = new ServiceWorkerPolicy();
    policy.attach(port);
    await policy.register();
    port.registration.waiting = new Worker();
    await policy.checkForUpdate('manual');
    expect(policy.snapshot()).toMatchObject({ phase: 'update-available', updateAvailable: true });
  });

  it('tracks installing worker transition to installed', async () => {
    const port = new NavigatorPort();
    const worker = new Worker();
    worker.state = 'installing';
    const policy = new ServiceWorkerPolicy();
    policy.attach(port);
    await policy.register();
    port.registration.installing = worker;
    port.registration.emitUpdateFound();
    port.registration.waiting = worker;
    worker.emit('installed');
    expect(policy.snapshot().updateAvailable).toBe(true);
    expect(policy.history().some(event => event.action === 'update-found')).toBe(true);
  });

  it('degrades on redundant installation', async () => {
    const port = new NavigatorPort();
    const worker = new Worker();
    worker.state = 'installing';
    const policy = new ServiceWorkerPolicy();
    policy.attach(port);
    await policy.register();
    port.registration.installing = worker;
    port.registration.emitUpdateFound();
    worker.emit('redundant');
    expect(policy.snapshot()).toMatchObject({ phase: 'degraded', consecutiveFailures: 1, reason: 'Error' });
  });

  it('sends only the controlled activation message to a waiting worker', async () => {
    const port = new NavigatorPort();
    const worker = new Worker();
    port.registration.waiting = worker;
    const policy = new ServiceWorkerPolicy({ activationTimeoutMs: 1_000 });
    policy.attach(port);
    await policy.register();
    const activation = policy.activateWaiting();
    port.controller = worker;
    port.emitControllerChange();
    await expect(activation).resolves.toBe(true);
    expect(worker.messages).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(policy.snapshot().phase).toBe('active');
  });

  it('does not activate when no worker is waiting', async () => {
    const port = new NavigatorPort();
    const policy = new ServiceWorkerPolicy();
    policy.attach(port);
    await policy.register();
    await expect(policy.activateWaiting()).resolves.toBe(false);
  });

  it('reports registration failures without leaking messages', async () => {
    const port = new NavigatorPort();
    port.register = async () => { throw new Error('secret-bearing-message'); };
    const policy = new ServiceWorkerPolicy();
    policy.attach(port);
    await policy.register();
    expect(policy.snapshot()).toMatchObject({ phase: 'degraded', reason: 'Error', consecutiveFailures: 1 });
    expect(JSON.stringify(policy.history())).not.toContain('secret-bearing-message');
  });

  it('reports update failures and remains bounded', async () => {
    const port = new NavigatorPort();
    port.registration.update = async () => { throw new TypeError('private'); };
    const policy = new ServiceWorkerPolicy();
    policy.attach(port);
    await policy.register();
    await expect(policy.checkForUpdate('manual')).resolves.toBe(false);
    expect(policy.snapshot()).toMatchObject({ phase: 'degraded', reason: 'TypeError', consecutiveFailures: 1 });
  });

  it('resets failures after a successful update', async () => {
    const port = new NavigatorPort();
    let fail = true;
    port.registration.update = async () => { if (fail) throw new Error('x'); };
    const policy = new ServiceWorkerPolicy();
    policy.attach(port);
    await policy.register();
    await policy.checkForUpdate('manual');
    fail = false;
    await policy.checkForUpdate('manual');
    expect(policy.snapshot().consecutiveFailures).toBe(0);
  });

  it('disposes deterministically and ignores later work', async () => {
    const port = new NavigatorPort();
    const policy = new ServiceWorkerPolicy();
    policy.attach(port);
    await policy.register();
    policy.dispose();
    expect(policy.snapshot().phase).toBe('disposed');
    expect(await policy.checkForUpdate()).toBe(false);
    await policy.register();
    expect(port.registrations).toBe(1);
  });

  it('validates interval bounds', () => {
    expect(() => new ServiceWorkerPolicy({ minUpdateIntervalMs: 9_999 })).toThrow(RangeError);
    expect(() => new ServiceWorkerPolicy({ registrationTimeoutMs: 999 })).toThrow(RangeError);
    expect(() => new ServiceWorkerPolicy({ activationTimeoutMs: 60_001 })).toThrow(RangeError);
    expect(() => new ServiceWorkerPolicy({ historyLimit: 513 })).toThrow(RangeError);
  });

  it('returns frozen snapshots and history entries', async () => {
    const port = new NavigatorPort();
    const policy = new ServiceWorkerPolicy();
    policy.attach(port);
    await policy.register();
    expect(Object.isFrozen(policy.snapshot())).toBe(true);
    expect(Object.isFrozen(policy.history())).toBe(true);
    expect(Object.isFrozen(policy.history()[0])).toBe(true);
  });

  it('records monotonic sequence values', async () => {
    const port = new NavigatorPort();
    const policy = new ServiceWorkerPolicy();
    policy.attach(port);
    await policy.register();
    await policy.checkForUpdate('manual');
    expect(policy.history().map(item => item.sequence)).toEqual([1, 2, 3]);
  });

  it('uses the injected clock for lifecycle timestamps', async () => {
    let now = 42;
    const port = new NavigatorPort();
    const policy = new ServiceWorkerPolicy({ clock: () => now });
    policy.attach(port);
    await policy.register();
    expect(policy.snapshot().lastRegistrationAt).toBe(42);
    now = 50;
    await policy.checkForUpdate('manual');
    expect(policy.snapshot().lastUpdateCheckAt).toBe(50);
  });

  it('does not unregister an existing worker on dispose', async () => {
    const port = new NavigatorPort();
    const unregister = vi.spyOn(port.registration, 'unregister');
    const policy = new ServiceWorkerPolicy();
    policy.attach(port);
    await policy.register();
    policy.dispose();
    expect(unregister).not.toHaveBeenCalled();
  });
});
