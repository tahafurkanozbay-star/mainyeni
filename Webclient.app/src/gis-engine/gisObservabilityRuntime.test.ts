import {
  createGisObservabilityRuntime,
  sanitizeDiagnosticFields,
} from './gisObservabilityRuntime';

describe('gisObservabilityRuntime', () => {
  test('redacts secrets, URLs, tokens and coordinate-bearing fields', () => {
    const fields = sanitizeDiagnosticFields({
      authorization: 'Bearer top-secret-token',
      apiKey: '123456789012345678901234567890123456',
      latitude: 39.93,
      longitude: 32.85,
      geometry: { x: 32.85, y: 39.93 },
      endpoint: 'https://example.test/arcgis/rest/services/Places/FeatureServer/0',
      note: 'safe',
    });
    expect(fields.authorization).toBe('[redacted-secret]');
    expect(fields.apiKey).toBe('[redacted-secret]');
    expect(fields.latitude).toMatch(/^\[redacted:/);
    expect(fields.longitude).toMatch(/^\[redacted:/);
    expect(fields.geometry).toMatch(/^\[redacted:/);
    expect(fields.endpoint).toBe('[redacted-url]');
    expect(fields.note).toBe('safe');
  });
  test('redacts address, where and object id fields by deterministic fingerprint', () => {
    const first = sanitizeDiagnosticFields({ address: 'Kızılay Mahallesi Atatürk Bulvarı 10', where: "NAME='secret'", objectIds: [1, 2, 3] });
    const second = sanitizeDiagnosticFields({ address: 'Kızılay Mahallesi Atatürk Bulvarı 10', where: "NAME='secret'", objectIds: [1, 2, 3] });
    expect(first).toEqual(second);
    expect(first.address).not.toContain('Kızılay');
    expect(first.where).not.toContain('NAME');
    expect(first.objectIds).not.toContain('1,2,3');
  });
  test('bounds field count and field length', () => {
    const fields = sanitizeDiagnosticFields(
      Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, 'x'.repeat(100)])),
      { maxFieldCount: 4, maxFieldLength: 12 },
    );
    expect(Object.keys(fields)).toHaveLength(4);
    expect(Object.values(fields).every((value) => String(value).length <= 12)).toBe(true);
  });
  test('records immutable diagnostic events with monotonic sequence numbers', () => {
    const runtime = createGisObservabilityRuntime({ now: () => 1000 });
    const first = runtime.record({ type: 'layer.registered', layerId: 'layer-a' });
    const second = runtime.record({ type: 'layer.visible', layerId: 'layer-a' });
    expect(first.sequence).toBeLessThan(second.sequence);
    expect(first.timestamp).toBe(1000);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.fields)).toBe(true);
  });
  test('traces emit started and completed events with duration', () => {
    let now = 100;
    const runtime = createGisObservabilityRuntime({ now: () => now });
    const trace = runtime.startTrace({ type: 'query.execute', serviceId: 'places' });
    now += 42;
    const completion = trace.complete({ ok: true, fields: { count: 4 } });
    const events = runtime.queryEvents({ traceId: trace.traceId });
    expect(events.map((event) => event.type)).toEqual(['query.execute.started', 'query.execute.completed']);
    expect(completion.durationMs).toBe(42);
    expect(completion.fields.count).toBe(4);
  });
  test('failed traces contribute to recent error rate and critical health', () => {
    let now = 0;
    const runtime = createGisObservabilityRuntime({ now: () => now, settings: { errorRateWarning: 0.2, errorRateCritical: 0.5 } });
    for (let index = 0; index < 2; index += 1) {
      const trace = runtime.startTrace({ type: 'query.execute' });
      now += 10;
      trace.complete({ ok: false, errorCode: 'FAILED' });
    }
    const snapshot = runtime.getSnapshot();
    expect(snapshot.recentErrorRate).toBe(1);
    expect(snapshot.health).toBe('critical');
    expect(snapshot.countsBySeverity.error).toBe(2);
  });
  test('cancelled traces do not count as failed completion events', () => {
    const runtime = createGisObservabilityRuntime();
    const trace = runtime.startTrace({ type: 'query.execute' });
    trace.cancel('user-navigation');
    expect(runtime.getSnapshot().recentErrorRate).toBe(0);
    expect(runtime.queryEvents({ type: 'query.execute.cancelled' })).toHaveLength(1);
  });
  test('classifies slow successful traces as warning', () => {
    let now = 0;
    const runtime = createGisObservabilityRuntime({ now: () => now, settings: { slowOperationMs: 20, verySlowOperationMs: 100 } });
    const trace = runtime.startTrace({ type: 'scene.stream' });
    now = 25;
    expect(trace.complete({ ok: true }).severity).toBe('warning');
  });
  test('sweeps stale traces into timeout failures', () => {
    let now = 0;
    const runtime = createGisObservabilityRuntime({ now: () => now, settings: { maxTraceAgeMs: 50 } });
    runtime.startTrace({ type: 'layer.attach', layerId: 'a' });
    now = 51;
    expect(runtime.sweepStaleTraces()).toBe(1);
    expect(runtime.getSnapshot().activeTraces).toBe(0);
    const failed = runtime.queryEvents({ type: 'layer.attach.failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0].fields.errorCode).toBe('TRACE_TIMEOUT');
  });
  test('rejects duplicate active trace identifiers', () => {
    const runtime = createGisObservabilityRuntime();
    runtime.startTrace({ traceId: 'same', type: 'query.execute' });
    expect(() => runtime.startTrace({ traceId: 'same', type: 'query.execute' })).toThrow(/already active/i);
  });
  test('rejects completing a trace twice', () => {
    const runtime = createGisObservabilityRuntime();
    const trace = runtime.startTrace({ type: 'query.execute' });
    trace.complete({ ok: true });
    expect(() => trace.complete({ ok: true })).toThrow(/already completed/i);
  });
  test('retains only configured capacity and counts dropped events', () => {
    const runtime = createGisObservabilityRuntime({ settings: { capacity: 3 } });
    for (let index = 0; index < 6; index += 1) runtime.record({ type: `event.${index}` });
    const snapshot = runtime.getSnapshot();
    expect(snapshot.totalEvents).toBe(6);
    expect(snapshot.retainedEvents).toBe(3);
    expect(snapshot.droppedEvents).toBe(3);
  });
  test('reconfiguring capacity evicts oldest retained events', () => {
    const runtime = createGisObservabilityRuntime({ settings: { capacity: 5 } });
    for (let index = 0; index < 5; index += 1) runtime.record({ type: `event.${index}` });
    runtime.configure({ capacity: 2 });
    expect(runtime.queryEvents().map((event) => event.type)).toEqual(['event.3', 'event.4']);
    expect(runtime.getSnapshot().droppedEvents).toBe(3);
  });
  test('filters event queries by type, severity, service, layer, trace and timestamp', () => {
    let now = 10;
    const runtime = createGisObservabilityRuntime({ now: () => now });
    runtime.record({ type: 'query.planned', severity: 'debug', serviceId: 'a', layerId: 'x', traceId: 't1' });
    now = 20;
    runtime.record({ type: 'query.failed', severity: 'error', serviceId: 'b', layerId: 'y', traceId: 't2' });
    expect(runtime.queryEvents({ type: 'query', severity: 'error', serviceId: 'b', layerId: 'y', traceId: 't2', since: 15 })).toHaveLength(1);
    expect(runtime.queryEvents({ since: 21 })).toHaveLength(0);
  });
  test('reports duration percentiles from trace completions', () => {
    let now = 0;
    const runtime = createGisObservabilityRuntime({ now: () => now });
    for (const duration of [10, 20, 30, 40]) {
      const trace = runtime.startTrace({ type: 'query.execute' });
      now += duration;
      trace.complete({ ok: true });
    }
    const duration = runtime.getSnapshot().duration;
    expect(duration.samples).toBe(4);
    expect(duration.averageMs).toBe(25);
    expect(duration.maxMs).toBe(40);
    expect(duration.p95Ms).toBe(40);
  });
  test('snapshot fingerprint is deterministic for the same retained state', () => {
    const create = () => {
      const runtime = createGisObservabilityRuntime({ now: () => 10 });
      runtime.record({ type: 'service.ready', serviceId: 'places', fields: { count: 2 } });
      return runtime.getSnapshot().fingerprint;
    };
    expect(create()).toBe(create());
  });
  test('notifies subscribers and isolates listener failures', () => {
    const listenerErrors = [];
    const seen = [];
    const runtime = createGisObservabilityRuntime({ onListenerError: (error) => listenerErrors.push(error) });
    runtime.subscribe(() => { throw new Error('listener failed'); });
    const unsubscribe = runtime.subscribe((event) => seen.push(event.type));
    runtime.record({ type: 'one' });
    unsubscribe();
    runtime.record({ type: 'two' });
    expect(seen).toEqual(['one']);
    expect(listenerErrors).toHaveLength(2);
  });
  test('clear resets retained event accounting without destroying runtime', () => {
    const runtime = createGisObservabilityRuntime();
    runtime.record({ type: 'one' });
    runtime.clear();
    expect(runtime.getSnapshot().totalEvents).toBe(0);
    runtime.record({ type: 'two' });
    expect(runtime.getSnapshot().retainedEvents).toBe(1);
  });
  test('destroy clears state and rejects subsequent writes', () => {
    const runtime = createGisObservabilityRuntime();
    runtime.record({ type: 'one' });
    runtime.destroy();
    expect(runtime.isDestroyed()).toBe(true);
    expect(() => runtime.record({ type: 'two' })).toThrow(/destroyed/i);
    expect(runtime.getSnapshot().retainedEvents).toBe(0);
  });
});
