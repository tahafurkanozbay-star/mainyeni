import { describe, expect, it, vi } from 'vitest';

import {
  createTemporalLayerRuntime,
  type TemporalRuntimeEvent,
} from './temporalLayerRuntime';

const minute = 60_000;
const hour = 60 * minute;

describe('createTemporalLayerRuntime', () => {
  it('registers bounded temporal layers and creates deterministic range plans', () => {
    const runtime = createTemporalLayerRuntime({
      initialRange: { start: 0, end: 24 * hour },
      initialCursor: 12 * hour,
      defaultStepMs: hour,
      defaultWindowMs: 2 * hour,
    });

    const first = runtime.registerLayer({
      layerId: 'traffic',
      minimum: 2 * hour,
      maximum: 20 * hour,
      metadataRevision: 'r1',
    });

    const second = runtime.getLayerPlan('traffic', 'range');

    expect(first.layerId).toBe('traffic');
    expect(first.range).toEqual({ start: 2 * hour, end: 20 * hour });
    expect(first.cursor).toBe(12 * hour);
    expect(first.stepMs).toBe(hour);
    expect(first.windowMs).toBe(2 * hour);
    expect(first.metadataRevision).toBe('r1');
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('builds instant, window and range plans without generating service endpoints', () => {
    const runtime = createTemporalLayerRuntime({
      initialRange: { start: 0, end: 10 * hour },
      initialCursor: 5 * hour,
      defaultWindowMs: 2 * hour,
    });

    runtime.registerLayer({
      layerId: 'events',
      minimum: hour,
      maximum: 9 * hour,
    });

    expect(runtime.getLayerPlan('events', 'instant').timeExtent).toEqual({
      start: 5 * hour,
      end: 5 * hour,
    });
    expect(runtime.getLayerPlan('events', 'window').timeExtent).toEqual({
      start: 4 * hour,
      end: 6 * hour,
    });
    expect(runtime.getLayerPlan('events', 'range').timeExtent).toEqual({
      start: hour,
      end: 9 * hour,
    });
  });

  it('clips window plans to both runtime and layer ranges', () => {
    const runtime = createTemporalLayerRuntime({
      initialRange: { start: 3 * hour, end: 7 * hour },
      initialCursor: 3 * hour,
      defaultWindowMs: 6 * hour,
    });

    runtime.registerLayer({
      layerId: 'works',
      minimum: 2 * hour,
      maximum: 6 * hour,
    });

    expect(runtime.getLayerPlan('works', 'window').range).toEqual({
      start: 3 * hour,
      end: 6 * hour,
    });

    runtime.setCursor(7 * hour);

    expect(runtime.getLayerPlan('works', 'window').range).toEqual({
      start: 3 * hour,
      end: 6 * hour,
    });
    expect(runtime.getLayerPlan('works', 'window').cursor).toBe(6 * hour);
  });

  it('clamps cursor changes to the active runtime range', () => {
    const runtime = createTemporalLayerRuntime({
      initialRange: { start: 10, end: 20 },
      initialCursor: 15,
    });

    runtime.setCursor(5);
    expect(runtime.getSnapshot().cursor).toBe(10);

    runtime.setCursor(30);
    expect(runtime.getSnapshot().cursor).toBe(20);
  });

  it('clamps the cursor when the active range changes', () => {
    const runtime = createTemporalLayerRuntime({
      initialRange: { start: 0, end: 100 },
      initialCursor: 90,
    });

    const snapshot = runtime.setRange({ start: 20, end: 50 });

    expect(snapshot.range).toEqual({ start: 20, end: 50 });
    expect(snapshot.cursor).toBe(50);
  });

  it('rejects inverted ranges and invalid layer extents', () => {
    expect(() => createTemporalLayerRuntime({
      initialRange: { start: 10, end: 5 },
    })).toThrow(/end cannot be earlier/i);

    const runtime = createTemporalLayerRuntime();

    expect(() => runtime.registerLayer({
      layerId: 'broken',
      minimum: 20,
      maximum: 10,
    })).toThrow(/maximum cannot be earlier/i);
  });

  it('enforces the configured temporal layer capacity', () => {
    const runtime = createTemporalLayerRuntime({ maxLayers: 1 });

    runtime.registerLayer({
      layerId: 'one',
      minimum: 0,
      maximum: 10,
    });

    expect(() => runtime.registerLayer({
      layerId: 'two',
      minimum: 0,
      maximum: 10,
    })).toThrow(/capacity exceeded/i);
  });

  it('allows replacement of an existing layer without consuming additional capacity', () => {
    const runtime = createTemporalLayerRuntime({ maxLayers: 1 });

    runtime.registerLayer({
      layerId: 'one',
      minimum: 0,
      maximum: 10,
      metadataRevision: 1,
    });

    runtime.registerLayer({
      layerId: 'one',
      minimum: 0,
      maximum: 20,
      metadataRevision: 2,
    });

    expect(runtime.getSnapshot().registeredLayerCount).toBe(1);
    expect(runtime.getLayerPlan('one', 'range').metadataRevision).toBe(2);
  });

  it('honors layer-specific step and window defaults', () => {
    const runtime = createTemporalLayerRuntime({
      initialRange: { start: 0, end: 20 * hour },
      initialCursor: 10 * hour,
      defaultStepMs: hour,
      defaultWindowMs: hour,
    });

    runtime.registerLayer({
      layerId: 'layer',
      minimum: 0,
      maximum: 20 * hour,
      defaultStepMs: 2 * hour,
      defaultWindowMs: 4 * hour,
    });

    const plan = runtime.getLayerPlan('layer');

    expect(plan.stepMs).toBe(hour);
    expect(plan.windowMs).toBe(hour);

    runtime.configurePlayback({ stepMs: 3 * hour, windowMs: 6 * hour });

    const configured = runtime.getLayerPlan('layer');

    expect(configured.stepMs).toBe(3 * hour);
    expect(configured.windowMs).toBe(6 * hour);
  });

  it('starts and pauses playback deterministically', () => {
    let clock = 100;
    const runtime = createTemporalLayerRuntime({
      now: () => clock,
      initialRange: { start: 0, end: 1000 },
    });

    const playing = runtime.play('user');

    expect(playing.playback.playing).toBe(true);
    expect(playing.playback.lastTickAt).toBe(100);

    clock = 150;
    const paused = runtime.pause('user');

    expect(paused.playback.playing).toBe(false);
    expect(paused.playback.lastTickAt).toBeNull();
  });

  it('advances playback according to elapsed interval budget', () => {
    let clock = 0;
    const runtime = createTemporalLayerRuntime({
      now: () => clock,
      initialRange: { start: 0, end: 100 },
      initialCursor: 0,
    });

    runtime.configurePlayback({
      stepMs: 10,
      intervalMs: 20,
    });
    runtime.play();

    clock = 19;
    expect(runtime.tick().cursor).toBe(0);

    clock = 20;
    expect(runtime.tick().cursor).toBe(10);

    clock = 61;
    expect(runtime.tick().cursor).toBe(30);
  });

  it('accumulates sub-interval playback time across ticks', () => {
    let clock = 0;
    const runtime = createTemporalLayerRuntime({
      now: () => clock,
      initialRange: { start: 0, end: 100 },
    });

    runtime.configurePlayback({
      stepMs: 10,
      intervalMs: 30,
    });
    runtime.play();

    clock = 10;
    runtime.tick();
    clock = 20;
    runtime.tick();
    clock = 29;
    runtime.tick();

    expect(runtime.getSnapshot().cursor).toBe(0);
    expect(runtime.getSnapshot().playback.accumulatedMs).toBe(29);

    clock = 31;
    runtime.tick();

    expect(runtime.getSnapshot().cursor).toBe(10);
    expect(runtime.getSnapshot().playback.accumulatedMs).toBe(1);
  });

  it('pauses at a forward playback boundary when looping is disabled', () => {
    const runtime = createTemporalLayerRuntime({
      initialRange: { start: 0, end: 20 },
      initialCursor: 10,
    });

    runtime.configurePlayback({
      stepMs: 10,
      intervalMs: 16,
      loop: false,
    });
    runtime.play();

    runtime.step();
    expect(runtime.getSnapshot().cursor).toBe(20);

    runtime.step();

    expect(runtime.getSnapshot().cursor).toBe(20);
    expect(runtime.getSnapshot().playback.playing).toBe(false);
  });

  it('loops at the forward playback boundary when configured', () => {
    const runtime = createTemporalLayerRuntime({
      initialRange: { start: 0, end: 20 },
      initialCursor: 20,
    });

    runtime.configurePlayback({
      stepMs: 10,
      loop: true,
    });

    runtime.step();

    expect(runtime.getSnapshot().cursor).toBe(0);
  });

  it('supports reverse playback and reverse looping', () => {
    const runtime = createTemporalLayerRuntime({
      initialRange: { start: 0, end: 20 },
      initialCursor: 0,
    });

    runtime.configurePlayback({
      stepMs: 10,
      direction: -1,
      loop: true,
    });

    runtime.step();

    expect(runtime.getSnapshot().cursor).toBe(20);
  });

  it('caps manual step counts to a bounded amount', () => {
    const runtime = createTemporalLayerRuntime({
      initialRange: { start: 0, end: 100_000 },
      initialCursor: 0,
    });

    runtime.configurePlayback({ stepMs: 1, loop: false });
    const snapshot = runtime.step(50_000);

    expect(snapshot.cursor).toBe(10_000);
  });

  it('sorts listed layer plans deterministically by layer id', () => {
    const runtime = createTemporalLayerRuntime({
      initialRange: { start: 0, end: 10 },
    });

    runtime.registerLayer({ layerId: 'zeta', minimum: 0, maximum: 10 });
    runtime.registerLayer({ layerId: 'alpha', minimum: 0, maximum: 10 });
    runtime.registerLayer({ layerId: 'middle', minimum: 0, maximum: 10 });

    expect(runtime.listLayerPlans().map((plan) => plan.layerId)).toEqual([
      'alpha',
      'middle',
      'zeta',
    ]);
  });

  it('tracks registration and cursor events with monotonically increasing revisions', () => {
    let clock = 1000;
    const events: TemporalRuntimeEvent[] = [];
    const runtime = createTemporalLayerRuntime({ now: () => clock });

    runtime.subscribe((event) => events.push(event));
    runtime.registerLayer({
      layerId: 'history',
      minimum: 0,
      maximum: 100,
    });
    clock += 1;
    runtime.setCursor(50, 'test');

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'layer-registered',
      timestamp: 1000,
      revision: 1,
      layerId: 'history',
    });
    expect(events[1]).toMatchObject({
      type: 'cursor-changed',
      timestamp: 1001,
      revision: 2,
      cursor: 50,
      reason: 'test',
    });
  });

  it('isolates listener failures and reports them through the configured hook', () => {
    const onListenerError = vi.fn();
    const runtime = createTemporalLayerRuntime({ onListenerError });

    runtime.subscribe(() => {
      throw new Error('listener exploded');
    });

    expect(() => runtime.setCursor(10)).not.toThrow();
    expect(onListenerError).toHaveBeenCalledTimes(1);
    expect(onListenerError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('unsubscribes event listeners idempotently through the returned function', () => {
    const listener = vi.fn();
    const runtime = createTemporalLayerRuntime();
    const unsubscribe = runtime.subscribe(listener);

    expect(unsubscribe()).toBe(true);
    expect(unsubscribe()).toBe(false);

    runtime.setCursor(1);

    expect(listener).not.toHaveBeenCalled();
  });

  it('unregisters temporal layers and rejects subsequent plan access', () => {
    const runtime = createTemporalLayerRuntime();

    runtime.registerLayer({
      layerId: 'remove-me',
      minimum: 0,
      maximum: 100,
    });

    expect(runtime.unregisterLayer('remove-me')).toBe(true);
    expect(runtime.unregisterLayer('remove-me')).toBe(false);
    expect(runtime.hasLayer('remove-me')).toBe(false);
    expect(() => runtime.getLayerPlan('remove-me')).toThrow(/not registered/i);
  });

  it('preserves supportsTime=false in layer plans for capability-aware callers', () => {
    const runtime = createTemporalLayerRuntime();

    runtime.registerLayer({
      layerId: 'static',
      minimum: 0,
      maximum: 100,
      supportsTime: false,
    });

    expect(runtime.getLayerPlan('static').supportsTime).toBe(false);
  });

  it('normalizes playback interval and duration inputs to safe bounds', () => {
    const runtime = createTemporalLayerRuntime({
      minIntervalMs: 20,
      maxIntervalMs: 100,
      initialRange: { start: 0, end: 1000 },
    });

    const snapshot = runtime.configurePlayback({
      intervalMs: 1,
      stepMs: -1,
      windowMs: -10,
    });

    expect(snapshot.playback.intervalMs).toBe(20);
    expect(snapshot.playback.stepMs).toBe(60_000);
    expect(snapshot.playback.windowMs).toBe(0);
  });

  it('invalidates deterministic plan fingerprints when runtime state changes', () => {
    const runtime = createTemporalLayerRuntime({
      initialRange: { start: 0, end: 100 },
      initialCursor: 20,
    });

    runtime.registerLayer({
      layerId: 'fingerprint',
      minimum: 0,
      maximum: 100,
    });

    const before = runtime.getLayerPlan('fingerprint').fingerprint;
    runtime.setCursor(30);
    const after = runtime.getLayerPlan('fingerprint').fingerprint;

    expect(after).not.toBe(before);
  });

  it('destroys playback, registrations, and listeners as an atomic terminal state', () => {
    const listener = vi.fn();
    const runtime = createTemporalLayerRuntime();

    runtime.registerLayer({
      layerId: 'layer',
      minimum: 0,
      maximum: 100,
    });
    runtime.subscribe(listener);
    runtime.play();
    runtime.destroy();

    const snapshot = runtime.getSnapshot();

    expect(snapshot.destroyed).toBe(true);
    expect(snapshot.registeredLayerCount).toBe(0);
    expect(snapshot.playback.playing).toBe(false);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'destroyed' }));
    expect(() => runtime.registerLayer({
      layerId: 'late',
      minimum: 0,
      maximum: 1,
    })).toThrow(/destroyed/i);
  });
});
