import { describe, expect, it, vi } from 'vitest';
import {
  MAP_WORKSPACE_SHELL_REGIONS,
  MapWorkspaceShellModel,
  createMapWorkspaceShellModel,
  type MapWorkspaceShellRegionId,
} from './mapWorkspaceShellModel';

const ALL_REGION_IDS = MAP_WORKSPACE_SHELL_REGIONS.map((region) => region.id);

describe('MapWorkspaceShellModel', () => {
  it('starts in a bounded booting state', () => {
    const model = createMapWorkspaceShellModel();
    const snapshot = model.getSnapshot();

    expect(snapshot.revision).toBe(0);
    expect(snapshot.phase).toBe('booting');
    expect(snapshot.busy).toBe(true);
    expect(snapshot.canRetry).toBe(false);
    expect(snapshot.retryAttempt).toBe(0);
    expect(snapshot.maxRetries).toBe(3);
    expect(snapshot.modality).toBe('unknown');
    expect(snapshot.activeRegion).toBeNull();
    expect(snapshot.availableRegionIds).toEqual([]);
    expect(snapshot.regions).toHaveLength(MAP_WORKSPACE_SHELL_REGIONS.length);
    expect(snapshot.announcement).toContain('hazırlanıyor');
  });

  it('projects ready lifecycle presentation', () => {
    const model = createMapWorkspaceShellModel();
    model.setPhase('ready');

    expect(model.getSnapshot()).toMatchObject({
      phase: 'ready',
      busy: false,
      canRetry: false,
      tone: 'success',
      visualMessage: 'Harita hazır',
      retryAttempt: 0,
    });
  });

  it('projects updating lifecycle presentation', () => {
    const model = createMapWorkspaceShellModel();
    model.setPhase('ready');
    model.setPhase('updating');

    expect(model.getSnapshot()).toMatchObject({
      phase: 'updating',
      busy: true,
      tone: 'info',
      visualMessage: 'Harita güncelleniyor',
    });
  });

  it('projects error lifecycle presentation with retry', () => {
    const model = createMapWorkspaceShellModel();
    model.setPhase('error');

    expect(model.getSnapshot()).toMatchObject({
      phase: 'error',
      busy: false,
      canRetry: true,
      tone: 'danger',
      visualMessage: 'Harita yüklenemedi',
    });
  });

  it('accepts retry only while the map is in error state', () => {
    const model = createMapWorkspaceShellModel();

    expect(model.requestRetry()).toBe(false);
    model.setPhase('error');
    expect(model.requestRetry()).toBe(true);
    expect(model.getSnapshot()).toMatchObject({
      phase: 'booting',
      retryAttempt: 1,
      canRetry: false,
    });
    expect(model.requestRetry()).toBe(false);
  });

  it('keeps retry count when a retry fails', () => {
    const model = createMapWorkspaceShellModel();
    model.setPhase('error');
    model.requestRetry();
    model.markRetryFailed();

    expect(model.getSnapshot()).toMatchObject({
      phase: 'error',
      retryAttempt: 1,
      canRetry: true,
    });
  });

  it('enforces the configured retry budget', () => {
    const model = createMapWorkspaceShellModel({ maxRetries: 2 });

    model.setPhase('error');
    expect(model.requestRetry()).toBe(true);
    model.markRetryFailed();
    expect(model.requestRetry()).toBe(true);
    model.markRetryFailed();

    expect(model.getSnapshot()).toMatchObject({
      phase: 'error',
      retryAttempt: 2,
      maxRetries: 2,
      canRetry: false,
      visualMessage: 'Harita kullanılamıyor',
    });
    expect(model.requestRetry()).toBe(false);
  });

  it('clamps retry budgets to a safe range', () => {
    const low = createMapWorkspaceShellModel({ maxRetries: 0 });
    const high = createMapWorkspaceShellModel({ maxRetries: 99 });

    expect(low.getSnapshot().maxRetries).toBe(1);
    expect(high.getSnapshot().maxRetries).toBe(6);
  });

  it('resets retry count after a successful ready transition', () => {
    const model = createMapWorkspaceShellModel();
    model.setPhase('error');
    model.requestRetry();
    model.markRetryFailed();
    expect(model.getSnapshot().retryAttempt).toBe(1);

    model.setPhase('ready');
    expect(model.getSnapshot().retryAttempt).toBe(0);
  });

  it('orders available regions according to the shared region contract', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['toolbar', 'map', 'help', 'navigation']);

    expect(model.getSnapshot().availableRegionIds).toEqual([
      'navigation',
      'map',
      'toolbar',
      'help',
    ]);
  });

  it('deduplicates available region ids', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['map', 'map', 'toolbar', 'toolbar']);

    expect(model.getSnapshot().availableRegionIds).toEqual(['map', 'toolbar']);
  });

  it('marks matching region presentation as available', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['map', 'sidebar']);

    const byId = new Map(model.getSnapshot().regions.map((region) => [region.id, region]));
    expect(byId.get('map')?.available).toBe(true);
    expect(byId.get('sidebar')?.available).toBe(true);
    expect(byId.get('toolbar')?.available).toBe(false);
  });

  it('ignores activation of a region that is not currently available', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['map']);
    const revision = model.getSnapshot().revision;

    model.setActiveRegion('toolbar');
    expect(model.getSnapshot().activeRegion).toBeNull();
    expect(model.getSnapshot().revision).toBe(revision);
  });

  it('activates an available region and records focus revision', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['map', 'toolbar']);
    model.setActiveRegion('toolbar');

    const snapshot = model.getSnapshot();
    expect(snapshot.activeRegion).toBe('toolbar');
    expect(snapshot.regions.find((region) => region.id === 'toolbar')).toMatchObject({
      active: true,
      available: true,
      lastFocusedRevision: snapshot.revision,
    });
  });

  it('clears active region if availability removes it', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['map', 'toolbar']);
    model.setActiveRegion('toolbar');

    model.setAvailableRegions(['map']);
    expect(model.getSnapshot().activeRegion).toBeNull();
  });

  it('supports clearing the active region explicitly', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['map']);
    model.setActiveRegion('map');
    model.setActiveRegion(null);

    expect(model.getSnapshot().activeRegion).toBeNull();
  });

  it.each([
    ['keyboard'],
    ['pointer'],
    ['touch'],
    ['unknown'],
  ] as const)('tracks %s modality', (modality) => {
    const model = createMapWorkspaceShellModel();
    model.setModality(modality);
    expect(model.getSnapshot().modality).toBe(modality);
  });

  it('does not publish duplicate modality values', () => {
    const model = createMapWorkspaceShellModel();
    model.setModality('keyboard');
    const revision = model.getSnapshot().revision;
    model.setModality('keyboard');
    expect(model.getSnapshot().revision).toBe(revision);
  });

  it('records region cycles as keyboard interactions', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['navigation', 'map']);
    model.recordRegionCycle('map');

    expect(model.getSnapshot()).toMatchObject({
      activeRegion: 'map',
      modality: 'keyboard',
      cycleCount: 1,
    });
  });

  it('ignores cycles toward unavailable regions', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['map']);
    const revision = model.getSnapshot().revision;
    model.recordRegionCycle('toolbar');

    expect(model.getSnapshot().revision).toBe(revision);
    expect(model.getSnapshot().cycleCount).toBe(0);
  });

  it('returns the first region when cycling without a current region', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['map', 'toolbar', 'navigation']);

    expect(model.nextRegion(null)).toBe('navigation');
  });

  it('returns the last region when reverse cycling without a current region', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['map', 'toolbar', 'navigation']);

    expect(model.nextRegion(null, true)).toBe('toolbar');
  });

  it('cycles forward in canonical order', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['navigation', 'map', 'sidebar', 'toolbar']);

    expect(model.nextRegion('navigation')).toBe('map');
    expect(model.nextRegion('map')).toBe('sidebar');
    expect(model.nextRegion('sidebar')).toBe('toolbar');
  });

  it('wraps forward region cycling', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['navigation', 'map', 'toolbar']);

    expect(model.nextRegion('toolbar')).toBe('navigation');
  });

  it('cycles backward in canonical order', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['navigation', 'map', 'sidebar', 'toolbar']);

    expect(model.nextRegion('toolbar', true)).toBe('sidebar');
    expect(model.nextRegion('sidebar', true)).toBe('map');
    expect(model.nextRegion('map', true)).toBe('navigation');
  });

  it('wraps backward region cycling', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['navigation', 'map', 'toolbar']);

    expect(model.nextRegion('navigation', true)).toBe('toolbar');
  });

  it('returns null when no region is available', () => {
    const model = createMapWorkspaceShellModel();
    expect(model.nextRegion(null)).toBeNull();
  });

  it('treats an unavailable current region like no current region', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['navigation', 'map']);
    expect(model.nextRegion('toolbar')).toBe('navigation');
  });

  it('publishes lifecycle changes to observers', () => {
    const model = createMapWorkspaceShellModel();
    const observer = vi.fn();
    model.subscribe(observer);

    model.setPhase('ready');
    model.setPhase('updating');

    expect(observer).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes observers deterministically', () => {
    const model = createMapWorkspaceShellModel();
    const observer = vi.fn();
    const unsubscribe = model.subscribe(observer);
    expect(model.getObserverDiagnostics().activeObserverCount).toBe(1);

    unsubscribe();
    model.setPhase('ready');

    expect(observer).not.toHaveBeenCalled();
    expect(model.getObserverDiagnostics().activeObserverCount).toBe(0);
  });

  it('does not count duplicate observer registrations twice', () => {
    const model = createMapWorkspaceShellModel();
    const observer = vi.fn();
    const releaseA = model.subscribe(observer);
    const releaseB = model.subscribe(observer);

    expect(model.getObserverDiagnostics().activeObserverCount).toBe(1);
    releaseB();
    expect(model.getObserverDiagnostics().activeObserverCount).toBe(0);
    releaseA();
  });

  it('enforces observer cardinality limits', () => {
    const model = createMapWorkspaceShellModel({ maxObservers: 2 });
    model.subscribe(() => undefined);
    model.subscribe(() => undefined);

    expect(() => model.subscribe(() => undefined)).toThrow(/observer limit exceeded/i);
    expect(model.getObserverDiagnostics().rejectedObserverCount).toBe(1);
  });

  it('clamps observer cardinality limits', () => {
    const model = createMapWorkspaceShellModel({ maxObservers: 0 });
    model.subscribe(() => undefined);
    expect(() => model.subscribe(() => undefined)).toThrow(/observer limit exceeded/i);
  });

  it('isolates a failing observer from healthy observers', () => {
    const onObserverError = vi.fn();
    const model = createMapWorkspaceShellModel({ onObserverError });
    const healthy = vi.fn();
    model.subscribe(() => { throw new TypeError('observer failed'); });
    model.subscribe(healthy);

    model.setPhase('ready');

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(onObserverError).toHaveBeenCalledTimes(1);
    expect(model.getObserverDiagnostics()).toMatchObject({
      failureCount: 1,
      reporterFailureCount: 0,
      lastFailureKind: 'TypeError',
      lastFailureRevision: model.getSnapshot().revision,
    });
  });

  it('contains observer error reporter failures', () => {
    const model = createMapWorkspaceShellModel({
      onObserverError() {
        throw new RangeError('reporter failed');
      },
    });
    const healthy = vi.fn();
    model.subscribe(() => { throw new Error('observer failed'); });
    model.subscribe(healthy);

    expect(() => model.setPhase('ready')).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getObserverDiagnostics()).toMatchObject({
      failureCount: 2,
      reporterFailureCount: 1,
      lastFailureKind: 'RangeError',
    });
  });

  it('classifies non-Error observer failures without retaining payloads', () => {
    const model = createMapWorkspaceShellModel();
    model.subscribe(() => { throw 'failure'; });
    model.setPhase('ready');

    expect(model.getObserverDiagnostics().lastFailureKind).toBe('string');
    expect(JSON.stringify(model.getObserverDiagnostics())).not.toContain('failure');
  });

  it('keeps snapshot objects immutable', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(ALL_REGION_IDS);
    const snapshot = model.getSnapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.availableRegionIds)).toBe(true);
    expect(Object.isFrozen(snapshot.regions)).toBe(true);
    expect(snapshot.regions.every(Object.isFrozen)).toBe(true);
  });

  it('does not publish unchanged phase values', () => {
    const model = createMapWorkspaceShellModel();
    const revision = model.getSnapshot().revision;
    model.setPhase('booting');
    expect(model.getSnapshot().revision).toBe(revision);
  });

  it('does not publish equivalent available region sets', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['toolbar', 'map']);
    const revision = model.getSnapshot().revision;
    model.setAvailableRegions(['map', 'toolbar']);
    expect(model.getSnapshot().revision).toBe(revision);
  });

  it('resets interaction facts without changing lifecycle phase', () => {
    const model = createMapWorkspaceShellModel();
    model.setAvailableRegions(['navigation', 'map']);
    model.setPhase('ready');
    model.recordRegionCycle('map');

    model.resetInteraction();

    expect(model.getSnapshot()).toMatchObject({
      phase: 'ready',
      activeRegion: null,
      modality: 'unknown',
      cycleCount: 0,
    });
  });

  it('marks diagnostics disposed and removes observers on dispose', () => {
    const model = createMapWorkspaceShellModel();
    model.subscribe(() => undefined);
    model.setAvailableRegions(['map']);

    model.dispose();

    expect(model.disposed()).toBe(true);
    expect(model.getObserverDiagnostics()).toMatchObject({
      activeObserverCount: 0,
      disposed: true,
    });
  });

  it('rejects subscriptions after disposal without throwing', () => {
    const model = createMapWorkspaceShellModel();
    model.dispose();

    const release = model.subscribe(() => undefined);
    expect(release()).toBeUndefined();
    expect(model.getObserverDiagnostics().rejectedObserverCount).toBe(1);
  });

  it('ignores lifecycle mutations after disposal', () => {
    const model = createMapWorkspaceShellModel();
    model.dispose();
    const snapshot = model.getSnapshot();

    model.setPhase('ready');
    model.setAvailableRegions(['map']);
    model.setActiveRegion('map');
    model.setModality('keyboard');
    model.recordRegionCycle('map');
    model.markRetryFailed();
    model.resetInteraction();

    expect(model.getSnapshot()).toBe(snapshot);
  });

  it('uses all region definitions exactly once', () => {
    const ids = MAP_WORKSPACE_SHELL_REGIONS.map((region) => region.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps region ordering strictly increasing', () => {
    const orders = MAP_WORKSPACE_SHELL_REGIONS.map((region) => region.order);
    expect(orders.every((order, index) => index === 0 || order > orders[index - 1]!)).toBe(true);
  });

  it('keeps region selectors explicit and non-empty', () => {
    for (const region of MAP_WORKSPACE_SHELL_REGIONS) {
      expect(region.selector.trim().length).toBeGreaterThan(0);
      expect(region.label.trim().length).toBeGreaterThan(0);
      expect(region.shortLabel.trim().length).toBeGreaterThan(0);
    }
  });

  it('can expose the complete canonical region sequence', () => {
    const model = new MapWorkspaceShellModel();
    model.setAvailableRegions(ALL_REGION_IDS as MapWorkspaceShellRegionId[]);
    expect(model.getSnapshot().availableRegionIds).toEqual(ALL_REGION_IDS);
  });
});
