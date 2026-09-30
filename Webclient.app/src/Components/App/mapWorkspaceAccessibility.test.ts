import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAP_WORKSPACE_EVENT_LIMIT,
  MAP_WORKSPACE_MAX_ATTEMPTS,
  MAP_WORKSPACE_OBSERVER_LIMIT,
  MAP_WORKSPACE_SLOW_BOOT_MS,
  MAP_WORKSPACE_SLOW_UPDATE_MS,
  MapWorkspaceAccessibilityModel,
  sanitizeMapWorkspaceMessage,
} from './mapWorkspaceAccessibility';

const resource = (model: MapWorkspaceAccessibilityModel, key: 'map-view' | 'kent-rehberi-data') => (
  model.getSnapshot().resources.find((item) => item.key === key)
);

describe('MapWorkspaceAccessibilityModel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with deterministic bounded operational facts', () => {
    const model = new MapWorkspaceAccessibilityModel();
    expect(model.getSnapshot()).toMatchObject({
      revision: 0,
      phase: 'booting',
      health: 'starting',
      attempt: 0,
      maxAttempts: MAP_WORKSPACE_MAX_ATTEMPTS,
      canRetry: false,
      retryExhausted: false,
      isInteractive: false,
      isBusy: true,
      isDelayed: false,
      delayKind: null,
      issueCount: 0,
      announcement: 'Harita çalışma alanı hazırlanıyor.',
      errorMessage: null,
      recentEvents: [],
    });
    expect(model.getSnapshot().resources).toEqual([
      expect.objectContaining({ key: 'map-view', required: true, status: 'idle' }),
      expect.objectContaining({ key: 'kent-rehberi-data', required: false, status: 'idle' }),
    ]);
    expect(Object.isFrozen(model.getSnapshot())).toBe(true);
    expect(Object.isFrozen(model.getSnapshot().resources)).toBe(true);
    expect(Object.isFrozen(model.getSnapshot().recentEvents)).toBe(true);
  });

  it('begins a first map attempt and schedules delayed boot feedback', () => {
    const model = new MapWorkspaceAccessibilityModel();
    expect(model.beginAttempt()).toBe(true);
    expect(model.getSnapshot()).toMatchObject({
      attempt: 1,
      phase: 'booting',
      health: 'starting',
      isDelayed: false,
    });
    expect(resource(model, 'map-view')).toMatchObject({ status: 'loading' });
    expect(resource(model, 'kent-rehberi-data')).toMatchObject({ status: 'idle' });
    expect(model.getSnapshot().recentEvents.at(-1)).toMatchObject({ kind: 'attempt' });

    vi.advanceTimersByTime(MAP_WORKSPACE_SLOW_BOOT_MS - 1);
    expect(model.getSnapshot().isDelayed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(model.getSnapshot()).toMatchObject({
      phase: 'booting',
      health: 'busy',
      isDelayed: true,
      delayKind: 'boot',
      announcement: 'Harita çalışma alanı beklenenden uzun sürede hazırlanıyor.',
    });
    expect(model.getSnapshot().recentEvents.at(-1)).toMatchObject({ kind: 'delay', resource: 'map-view' });
  });

  it('clears delayed boot feedback when the view becomes ready', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    vi.advanceTimersByTime(MAP_WORKSPACE_SLOW_BOOT_MS);
    model.markReady();
    expect(model.getSnapshot()).toMatchObject({
      phase: 'ready',
      health: 'healthy',
      isInteractive: true,
      isBusy: false,
      isDelayed: false,
      delayKind: null,
      announcement: 'Harita çalışma alanı kullanıma hazır.',
    });
    expect(resource(model, 'map-view')).toMatchObject({ status: 'ready' });
  });

  it('does not emit a delayed boot transition after ready clears the timer', () => {
    const model = new MapWorkspaceAccessibilityModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.beginAttempt();
    model.markReady();
    const revision = model.getSnapshot().revision;
    vi.advanceTimersByTime(MAP_WORKSPACE_SLOW_BOOT_MS * 2);
    expect(model.getSnapshot().revision).toBe(revision);
    expect(model.getSnapshot().isDelayed).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('publishes bounded updating lifecycle and delayed update feedback', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markReady();
    model.markUpdating(true);
    expect(model.getSnapshot()).toMatchObject({
      phase: 'updating',
      health: 'busy',
      isInteractive: true,
      isBusy: true,
      isDelayed: false,
    });
    vi.advanceTimersByTime(MAP_WORKSPACE_SLOW_UPDATE_MS);
    expect(model.getSnapshot()).toMatchObject({
      phase: 'updating',
      isDelayed: true,
      delayKind: 'update',
      announcement: 'Harita görünümü güncelleniyor. İşlem beklenenden uzun sürüyor.',
    });
    model.markUpdating(false);
    expect(model.getSnapshot()).toMatchObject({
      phase: 'ready',
      health: 'healthy',
      isBusy: false,
      isDelayed: false,
      delayKind: null,
    });
  });

  it('ignores updating signals before the map becomes interactive', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    const revision = model.getSnapshot().revision;
    model.markUpdating(true);
    expect(model.getSnapshot().phase).toBe('booting');
    expect(model.getSnapshot().revision).toBe(revision);
  });

  it('deduplicates an already-active updating state', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markReady();
    model.markUpdating(true);
    const revision = model.getSnapshot().revision;
    model.markUpdating(true);
    expect(model.getSnapshot().revision).toBe(revision);
  });

  it('tracks the optional Kent Rehberi data resource without blocking initial interaction', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markReady();
    model.markResourceLoading('kent-rehberi-data');
    expect(model.getSnapshot()).toMatchObject({ phase: 'ready', isInteractive: true });
    expect(resource(model, 'kent-rehberi-data')).toMatchObject({ status: 'loading', required: false });
    model.markResourceReady('kent-rehberi-data');
    expect(resource(model, 'kent-rehberi-data')).toMatchObject({ status: 'ready', message: null });
    expect(model.getSnapshot()).toMatchObject({ phase: 'ready', health: 'healthy', issueCount: 0 });
  });

  it('converts optional data failure into a degraded but interactive workspace', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markReady();
    model.markResourceLoading('kent-rehberi-data');
    model.markResourceFailed('kent-rehberi-data', new Error('  Veri\u0000  katmanı   geçici olarak yok  '));
    expect(model.getSnapshot()).toMatchObject({
      phase: 'degraded',
      health: 'degraded',
      isInteractive: true,
      isBusy: false,
      issueCount: 1,
    });
    expect(resource(model, 'kent-rehberi-data')).toMatchObject({
      status: 'degraded',
      message: 'Veri katmanı geçici olarak yok',
    });
    expect(model.getSnapshot().announcement).toContain('Harita kullanılabilir');
    expect(model.getSnapshot().announcement).not.toContain('\u0000');
  });

  it('returns from degraded to ready when the optional data resource recovers', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markReady();
    model.markResourceFailed('kent-rehberi-data', 'Katman yok');
    expect(model.getSnapshot().phase).toBe('degraded');
    model.markResourceReady('kent-rehberi-data');
    expect(model.getSnapshot()).toMatchObject({ phase: 'ready', health: 'healthy', issueCount: 0 });
  });

  it('preserves degraded state after a view update finishes while optional data remains unavailable', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markReady();
    model.markResourceFailed('kent-rehberi-data', 'Katman geçici olarak yok');
    model.markUpdating(true);
    expect(model.getSnapshot().phase).toBe('updating');
    model.markUpdating(false);
    expect(model.getSnapshot()).toMatchObject({ phase: 'degraded', health: 'degraded', isInteractive: true });
  });

  it('treats required map-view resource failure as fatal', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markResourceFailed('map-view', new Error('view failed'));
    expect(model.getSnapshot()).toMatchObject({
      phase: 'error',
      health: 'failed',
      isInteractive: false,
      issueCount: 1,
      canRetry: true,
    });
    expect(resource(model, 'map-view')).toMatchObject({ status: 'failed', required: true });
  });

  it('sanitizes and bounds lifecycle errors before publishing them', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markError(new Error(`  ArcGIS\u0000  yüklenemedi   ${'x'.repeat(300)} `));
    const snapshot = model.getSnapshot();
    expect(snapshot.phase).toBe('error');
    expect(snapshot.health).toBe('failed');
    expect(snapshot.isInteractive).toBe(false);
    expect(snapshot.isBusy).toBe(false);
    expect(snapshot.errorMessage).not.toContain('\u0000');
    expect(snapshot.errorMessage!.length).toBeLessThanOrEqual(180);
    expect(snapshot.announcement).toContain('Harita çalışma alanı hazırlanamadı.');
  });

  it('uses a generic non-sensitive failure message for non-string errors', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markError({ secret: 'do-not-render' });
    expect(model.getSnapshot()).toMatchObject({
      phase: 'error',
      errorMessage: null,
      announcement: 'Harita çalışma alanı hazırlanamadı.',
    });
    expect(JSON.stringify(model.getSnapshot())).not.toContain('do-not-render');
  });

  it('enforces the configured retry budget', () => {
    const model = new MapWorkspaceAccessibilityModel({ maxAttempts: 2 });
    expect(model.beginAttempt()).toBe(true);
    model.markError(new Error('first'));
    expect(model.getSnapshot()).toMatchObject({ attempt: 1, canRetry: true, retryExhausted: false });
    expect(model.beginAttempt()).toBe(true);
    model.markError(new Error('second'));
    expect(model.getSnapshot()).toMatchObject({ attempt: 2, canRetry: false, retryExhausted: true });
    expect(model.beginAttempt()).toBe(false);
    expect(model.getSnapshot().attempt).toBe(2);
  });

  it('uses default three-attempt recovery budget', () => {
    const model = new MapWorkspaceAccessibilityModel();
    for (let attempt = 1; attempt <= MAP_WORKSPACE_MAX_ATTEMPTS; attempt += 1) {
      expect(model.beginAttempt()).toBe(true);
      model.markError(new Error(`failure-${attempt}`));
    }
    expect(model.getSnapshot()).toMatchObject({
      attempt: MAP_WORKSPACE_MAX_ATTEMPTS,
      canRetry: false,
      retryExhausted: true,
    });
    expect(model.beginAttempt()).toBe(false);
  });

  it('reset clears attempts, events and resources for a new independent lifecycle', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markReady();
    model.markResourceFailed('kent-rehberi-data', 'temporary');
    model.reset();
    expect(model.getSnapshot()).toMatchObject({
      attempt: 0,
      phase: 'booting',
      health: 'starting',
      isInteractive: false,
      issueCount: 0,
      recentEvents: [],
    });
    expect(resource(model, 'map-view')).toMatchObject({ status: 'idle' });
    expect(resource(model, 'kent-rehberi-data')).toMatchObject({ status: 'idle' });
  });

  it('bounds recent operational history and preserves increasing event ids', () => {
    const model = new MapWorkspaceAccessibilityModel({ maxEvents: 4 });
    model.beginAttempt();
    model.markReady();
    model.markResourceLoading('kent-rehberi-data');
    model.markResourceReady('kent-rehberi-data');
    model.markUpdating(true);
    model.markUpdating(false);
    const events = model.getSnapshot().recentEvents;
    expect(events).toHaveLength(4);
    expect(events.map((event) => event.id)).toEqual([...events.map((event) => event.id)].sort((a, b) => a - b));
    expect(events[0]!.id).toBeGreaterThan(1);
    expect(Object.isFrozen(events)).toBe(true);
    expect(events.every((event) => Object.isFrozen(event))).toBe(true);
  });

  it('uses the default operational event history budget', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markReady();
    for (let index = 0; index < MAP_WORKSPACE_EVENT_LIMIT + 8; index += 1) {
      model.markUpdating(true);
      model.markUpdating(false);
    }
    expect(model.getSnapshot().recentEvents).toHaveLength(MAP_WORKSPACE_EVENT_LIMIT);
  });

  it('clamps configuration values to safe bounds', () => {
    const model = new MapWorkspaceAccessibilityModel({
      maxAttempts: 999,
      maxEvents: 999,
      maxListeners: 999,
      slowBootAfterMs: 1,
      slowUpdateAfterMs: 999_999,
    });
    expect(model.getSnapshot().maxAttempts).toBe(8);
    model.beginAttempt();
    vi.advanceTimersByTime(249);
    expect(model.getSnapshot().isDelayed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(model.getSnapshot().isDelayed).toBe(true);
  });

  it('sanitizes standalone workspace messages deterministically', () => {
    expect(sanitizeMapWorkspaceMessage('  a\u0000 b\n c   ')).toBe('a b c');
    expect(sanitizeMapWorkspaceMessage({ secret: true })).toBe('');
    expect(sanitizeMapWorkspaceMessage('x'.repeat(220))).toHaveLength(180);
  });

  it('isolates observer failures and continues notifying healthy observers', () => {
    const reporter = vi.fn();
    const model = new MapWorkspaceAccessibilityModel({ onObserverError: reporter });
    const healthy = vi.fn();
    model.subscribe(() => { throw new TypeError('private observer detail'); });
    model.subscribe(healthy);
    expect(() => model.beginAttempt()).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(model.getObserverDiagnostics()).toMatchObject({
      failureCount: 1,
      activeObserverCount: 2,
      rejectedObserverCount: 0,
      lastFailureRevision: 1,
      lastFailureKind: 'TypeError',
      disposed: false,
    });
    expect(JSON.stringify(model.getObserverDiagnostics())).not.toContain('private observer detail');
  });

  it('contains reporter failures without interrupting state propagation', () => {
    const healthy = vi.fn();
    const model = new MapWorkspaceAccessibilityModel({
      onObserverError() { throw new RangeError('reporter detail'); },
    });
    model.subscribe(() => { throw new Error('observer detail'); });
    model.subscribe(healthy);
    expect(() => model.beginAttempt()).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getObserverDiagnostics()).toMatchObject({
      failureCount: 2,
      lastFailureKind: 'RangeError',
      lastFailureRevision: 1,
    });
    expect(JSON.stringify(model.getObserverDiagnostics())).not.toContain('reporter detail');
  });

  it('deduplicates subscriptions and supports deterministic unsubscribe', () => {
    const model = new MapWorkspaceAccessibilityModel();
    const listener = vi.fn();
    const first = model.subscribe(listener);
    const second = model.subscribe(listener);
    expect(model.getObserverDiagnostics().activeObserverCount).toBe(1);
    model.beginAttempt();
    expect(listener).toHaveBeenCalledTimes(1);
    second();
    expect(model.getObserverDiagnostics().activeObserverCount).toBe(0);
    first();
    model.markError('ignored by listener');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('bounds observer cardinality and records rejections', () => {
    const model = new MapWorkspaceAccessibilityModel();
    const listeners = Array.from({ length: MAP_WORKSPACE_OBSERVER_LIMIT + 6 }, () => vi.fn());
    listeners.forEach((listener) => model.subscribe(listener));
    model.beginAttempt();
    expect(listeners.filter((listener) => listener.mock.calls.length === 1)).toHaveLength(MAP_WORKSPACE_OBSERVER_LIMIT);
    expect(listeners.slice(MAP_WORKSPACE_OBSERVER_LIMIT).every((listener) => listener.mock.calls.length === 0)).toBe(true);
    expect(model.getObserverDiagnostics()).toMatchObject({
      activeObserverCount: MAP_WORKSPACE_OBSERVER_LIMIT,
      rejectedObserverCount: 6,
    });
  });

  it('supports a smaller configured listener budget', () => {
    const model = new MapWorkspaceAccessibilityModel({ maxListeners: 2 });
    const first = vi.fn();
    const second = vi.fn();
    const rejected = vi.fn();
    model.subscribe(first);
    model.subscribe(second);
    model.subscribe(rejected);
    model.beginAttempt();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(rejected).not.toHaveBeenCalled();
    expect(model.getObserverDiagnostics()).toMatchObject({ activeObserverCount: 2, rejectedObserverCount: 1 });
  });

  it('freezes observer diagnostics after state transitions', () => {
    const model = new MapWorkspaceAccessibilityModel();
    expect(Object.isFrozen(model.getObserverDiagnostics())).toBe(true);
    model.subscribe(() => { throw new Error('failure'); });
    model.beginAttempt();
    expect(Object.isFrozen(model.getObserverDiagnostics())).toBe(true);
  });

  it('dispose clears timers and observers and makes future transitions inert', () => {
    const model = new MapWorkspaceAccessibilityModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.beginAttempt();
    model.dispose();
    const snapshot = model.getSnapshot();
    vi.runAllTimers();
    model.markReady();
    model.markError(new Error('ignored'));
    model.markResourceFailed('kent-rehberi-data', 'ignored');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(model.getSnapshot()).toBe(snapshot);
    expect(model.getObserverDiagnostics()).toMatchObject({
      activeObserverCount: 0,
      disposed: true,
    });
  });

  it('rejects subscriptions after disposal without invoking them', () => {
    const model = new MapWorkspaceAccessibilityModel();
    const listener = vi.fn();
    model.dispose();
    const unsubscribe = model.subscribe(listener);
    expect(() => unsubscribe()).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    expect(model.getObserverDiagnostics().rejectedObserverCount).toBe(1);
  });

  it('rejects new attempts after disposal', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.dispose();
    expect(model.beginAttempt()).toBe(false);
    expect(model.getSnapshot().attempt).toBe(0);
  });
});
