import { createServiceHealthRuntime } from './serviceHealthRuntime';

const SERVICE_URL = 'https://example.test/arcgis/rest/services/Places/FeatureServer/0';

const createHarness = (overrides = {}) => {
  let now = 1000;
  const events = [];
  const runtime = createServiceHealthRuntime({
    now: () => now,
    policy: {
      sampleWindow: 8,
      consecutiveFailureLimit: 2,
      openCircuitMs: 100,
      maxOpenCircuitMs: 800,
      halfOpenProbeLimit: 2,
      degradeFailureRatio: 0.2,
      unavailableFailureRatio: 0.5,
      ...overrides.policy,
    },
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  runtime.registerService({
    serviceId: 'places',
    resourceUrl: SERVICE_URL,
    resourceKind: 'feature-layer',
    maxRecordCount: 1000,
  });
  return {
    runtime,
    events,
    now: () => now,
    advance: (milliseconds) => { now += milliseconds; },
  };
};

describe('serviceHealthRuntime', () => {
  test('registers a verified ArcGIS REST service', () => {
    const { runtime } = createHarness();
    const snapshot = runtime.getSnapshot('places');
    expect(snapshot.serviceId).toBe('places');
    expect(snapshot.resourceUrl).toBe(SERVICE_URL);
    expect(snapshot.state).toBe('unknown');
    expect(snapshot.circuit).toBe('closed');
  });

  test('rejects WMS/WFS resources through the shared ArcGIS contract', () => {
    const runtime = createServiceHealthRuntime();
    expect(() => runtime.registerService({
      serviceId: 'bad',
      resourceUrl: 'https://example.test/geoserver/wms?service=WMS',
    })).toThrow();
  });

  test('tracks request tickets and transitions to healthy after successful samples', () => {
    const { runtime, advance } = createHarness();
    const ticket = runtime.beginRequest('places');
    advance(24);
    const snapshot = runtime.completeRequest(ticket, { ok: true, status: 200, bytes: 2048 });
    expect(snapshot.successes).toBe(1);
    expect(snapshot.failures).toBe(0);
    expect(snapshot.averageLatencyMs).toBe(24);
    expect(snapshot.state).toBe('healthy');
  });

  test('records transfer-limit pressure without marking a request failed', () => {
    const { runtime } = createHarness();
    const ticket = runtime.beginRequest('places');
    const snapshot = runtime.completeRequest(ticket, {
      ok: true,
      status: 200,
      durationMs: 12,
      transferLimitExceeded: true,
    });
    expect(snapshot.successes).toBe(1);
    expect(snapshot.transferLimitCount).toBe(1);
    expect(snapshot.failures).toBe(0);
  });

  test('opens the circuit after consecutive failures', () => {
    const { runtime } = createHarness();
    for (let index = 0; index < 2; index += 1) {
      const ticket = runtime.beginRequest('places');
      runtime.completeRequest(ticket, { ok: false, status: 503, durationMs: 30 });
    }
    const snapshot = runtime.getSnapshot('places');
    expect(snapshot.circuit).toBe('open');
    expect(snapshot.state).toBe('unavailable');
    expect(runtime.getAvailability('places').allowed).toBe(false);
  });

  test('moves an open circuit to half-open when the probe window is due', () => {
    const { runtime, advance } = createHarness();
    for (let index = 0; index < 2; index += 1) {
      const ticket = runtime.beginRequest('places');
      runtime.completeRequest(ticket, { ok: false, status: 500 });
    }
    advance(100);
    const availability = runtime.getAvailability('places');
    expect(availability.circuit).toBe('half-open');
    expect(availability.allowed).toBe(true);
  });

  test('closes a half-open circuit after the configured successful probes', () => {
    const { runtime, advance } = createHarness();
    for (let index = 0; index < 2; index += 1) {
      const ticket = runtime.beginRequest('places');
      runtime.completeRequest(ticket, { ok: false, status: 503 });
    }
    advance(100);
    for (let index = 0; index < 2; index += 1) {
      const ticket = runtime.beginRequest('places');
      runtime.completeRequest(ticket, { ok: true, status: 200, durationMs: 10 });
    }
    expect(runtime.getSnapshot('places').circuit).toBe('closed');
  });

  test('reopens a half-open circuit when a probe fails', () => {
    const { runtime, advance } = createHarness();
    for (let index = 0; index < 2; index += 1) {
      const ticket = runtime.beginRequest('places');
      runtime.completeRequest(ticket, { ok: false, status: 500 });
    }
    advance(100);
    const ticket = runtime.beginRequest('places');
    runtime.completeRequest(ticket, { ok: false, status: 503 });
    expect(runtime.getSnapshot('places').circuit).toBe('open');
  });

  test('does not count subscriber cancellation as a service failure', () => {
    const { runtime } = createHarness();
    const ticket = runtime.beginRequest('places');
    const snapshot = runtime.completeRequest(ticket, { cancelled: true, durationMs: 4 });
    expect(snapshot.cancellationCount).toBe(1);
    expect(snapshot.failures).toBe(0);
    expect(snapshot.consecutiveFailures).toBe(0);
  });

  test('counts timeouts as failures', () => {
    const { runtime } = createHarness();
    const ticket = runtime.beginRequest('places');
    const snapshot = runtime.completeRequest(ticket, { timeout: true, durationMs: 1000 });
    expect(snapshot.failures).toBe(1);
    expect(snapshot.timeoutCount).toBe(1);
  });

  test('records metrics without a ticket for imported diagnostics', () => {
    const { runtime, now } = createHarness();
    const snapshot = runtime.recordMetric({
      serviceId: 'places',
      startedAt: now() - 20,
      durationMs: 20,
      ok: true,
      status: 200,
      bytes: 512,
    });
    expect(snapshot.samples).toBe(1);
    expect(snapshot.successes).toBe(1);
  });

  test('bounds the sample window while keeping lifetime counters', () => {
    const { runtime } = createHarness({ policy: { sampleWindow: 3 } });
    for (let index = 0; index < 5; index += 1) {
      runtime.recordMetric({ serviceId: 'places', startedAt: 0, durationMs: 10, ok: true, status: 200 });
    }
    const snapshot = runtime.getSnapshot('places');
    expect(snapshot.samples).toBe(3);
    expect(snapshot.successes).toBe(5);
  });

  test('blocks unregister while tracked requests are in flight', () => {
    const { runtime } = createHarness();
    const ticket = runtime.beginRequest('places');
    expect(() => runtime.unregisterService('places')).toThrow(/in flight/i);
    runtime.completeRequest(ticket, { ok: true, status: 200 });
    expect(runtime.unregisterService('places')).toBe(true);
  });

  test('rejects rebinding a service id to a different resource URL', () => {
    const { runtime } = createHarness();
    expect(() => runtime.registerService({
      serviceId: 'places',
      resourceUrl: 'https://example.test/arcgis/rest/services/Other/FeatureServer/0',
    })).toThrow(/different/i);
  });

  test('can reset health history once the service is idle', () => {
    const { runtime } = createHarness();
    runtime.recordMetric({ serviceId: 'places', startedAt: 0, durationMs: 10, ok: false, status: 503 });
    const reset = runtime.resetService('places');
    expect(reset.samples).toBe(0);
    expect(reset.successes).toBe(0);
    expect(reset.failures).toBe(0);
    expect(reset.state).toBe('unknown');
  });

  test('reconfiguration trims retained samples', () => {
    const { runtime } = createHarness({ policy: { sampleWindow: 8 } });
    for (let index = 0; index < 6; index += 1) {
      runtime.recordMetric({ serviceId: 'places', startedAt: 0, durationMs: 5, ok: true, status: 200 });
    }
    runtime.configure({ sampleWindow: 2 });
    expect(runtime.getSnapshot('places').samples).toBe(2);
  });

  test('summarizes registered service health', () => {
    const { runtime } = createHarness();
    runtime.recordMetric({ serviceId: 'places', startedAt: 0, durationMs: 10, ok: true, status: 200 });
    const summary = runtime.getSummary();
    expect(summary.registered).toBe(1);
    expect(summary.healthy).toBe(1);
    expect(summary.inFlight).toBe(0);
  });

  test('emits deterministic lifecycle and transition events', () => {
    const { runtime, events } = createHarness();
    const ticket = runtime.beginRequest('places');
    runtime.completeRequest(ticket, { ok: true, status: 200 });
    expect(events.some((event) => event.type === 'service-registered')).toBe(true);
    expect(events.some((event) => event.type === 'service-request-started')).toBe(true);
    expect(events.some((event) => event.type === 'service-health-transition')).toBe(true);
  });

  test('unsubscribe prevents later listener delivery', () => {
    const { runtime } = createHarness();
    const listener = jest.fn();
    const unsubscribe = runtime.subscribe(listener);
    unsubscribe();
    const ticket = runtime.beginRequest('places');
    runtime.completeRequest(ticket, { ok: true, status: 200 });
    expect(listener).not.toHaveBeenCalled();
  });

  test('destroy makes future operations fail closed', () => {
    const { runtime } = createHarness();
    runtime.destroy();
    expect(runtime.isDestroyed()).toBe(true);
    expect(runtime.getAvailability('places').allowed).toBe(false);
    expect(() => runtime.beginRequest('places')).toThrow(/destroyed/i);
  });
});
