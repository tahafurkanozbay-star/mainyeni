import { describe, expect, it, vi } from 'vitest';
import { BasemapExperienceModel } from './basemapExperienceModel';

describe('BasemapExperienceModel lifecycle', () => {
  it('starts idle with a bounded reload budget', () => {
    const model = new BasemapExperienceModel();
    expect(model.getSnapshot()).toMatchObject({
      phase: 'idle',
      attempt: 0,
      maxAttempts: 3,
      readyCount: 0,
      busy: false,
      canReload: false,
    });
  });

  it('starts a load attempt and announces its budget position', () => {
    const model = new BasemapExperienceModel();
    expect(model.beginLoad()).toBe(true);
    expect(model.getSnapshot()).toMatchObject({ phase: 'loading', attempt: 1, busy: true });
    expect(model.getSnapshot().announcement).toContain('Deneme 1/3');
  });

  it('rejects duplicate beginLoad while already loading', () => {
    const model = new BasemapExperienceModel();
    model.beginLoad();
    const revision = model.getSnapshot().revision;
    expect(model.beginLoad()).toBe(false);
    expect(model.getSnapshot().revision).toBe(revision);
  });

  it('publishes a ready count', () => {
    const model = new BasemapExperienceModel();
    model.beginLoad();
    model.succeed(17);
    expect(model.getSnapshot()).toMatchObject({
      phase: 'ready',
      attempt: 1,
      readyCount: 17,
      error: null,
      busy: false,
    });
    expect(model.getSnapshot().announcement).toBe('17 altlık harita kullanıma hazır.');
  });

  it('clamps invalid ready counts to zero', () => {
    const model = new BasemapExperienceModel();
    model.beginLoad();
    model.succeed(Number.NaN);
    expect(model.getSnapshot().readyCount).toBe(0);
  });

  it('normalizes error text and enables bounded reload', () => {
    const model = new BasemapExperienceModel();
    model.beginLoad();
    model.fail(new Error('  ArcGIS   gallery failed  '));
    expect(model.getSnapshot()).toMatchObject({
      phase: 'error',
      attempt: 1,
      error: 'ArcGIS gallery failed',
      canReload: true,
    });
  });

  it('uses a safe fallback for non-string errors', () => {
    const model = new BasemapExperienceModel();
    model.beginLoad();
    model.fail({ code: 'x' });
    expect(model.getSnapshot().error).toBe('Altlık haritalar yüklenemedi.');
  });

  it('stops offering reload after the max attempt budget is exhausted', () => {
    const model = new BasemapExperienceModel({ maxAttempts: 2 });
    expect(model.beginLoad()).toBe(true);
    model.fail('first');
    expect(model.getSnapshot().canReload).toBe(true);
    expect(model.beginLoad()).toBe(true);
    model.fail('second');
    expect(model.getSnapshot()).toMatchObject({ attempt: 2, canReload: false });
    expect(model.beginLoad()).toBe(false);
  });

  it('clamps maxAttempts to a safe upper bound', () => {
    const model = new BasemapExperienceModel({ maxAttempts: 999 });
    expect(model.getSnapshot().maxAttempts).toBe(5);
  });

  it('clamps maxAttempts to at least one', () => {
    const model = new BasemapExperienceModel({ maxAttempts: 0 });
    expect(model.getSnapshot().maxAttempts).toBe(1);
  });

  it('cancels back to idle without resetting attempt history', () => {
    const model = new BasemapExperienceModel();
    model.beginLoad();
    model.cancel();
    expect(model.getSnapshot()).toMatchObject({ phase: 'idle', attempt: 1, readyCount: 0, error: null });
  });

  it('resets attempt budget explicitly', () => {
    const model = new BasemapExperienceModel({ maxAttempts: 2 });
    model.beginLoad();
    model.fail('failed');
    model.resetAttempts();
    expect(model.getSnapshot()).toMatchObject({ phase: 'idle', attempt: 0, canReload: false });
    expect(model.beginLoad()).toBe(true);
  });

  it('allows a fresh load after a successful state', () => {
    const model = new BasemapExperienceModel();
    model.beginLoad();
    model.succeed(12);
    expect(model.beginLoad()).toBe(true);
    expect(model.getSnapshot()).toMatchObject({ phase: 'loading', attempt: 2, readyCount: 12 });
  });
});

describe('BasemapExperienceModel observer behavior', () => {
  it('notifies observers for lifecycle transitions', () => {
    const model = new BasemapExperienceModel();
    const observer = vi.fn();
    model.subscribe(observer);
    model.beginLoad();
    model.succeed(5);
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it('isolates throwing observers from healthy observers', () => {
    const model = new BasemapExperienceModel();
    const healthy = vi.fn();
    model.subscribe(() => { throw new TypeError('observer'); });
    model.subscribe(healthy);
    model.beginLoad();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getDiagnostics()).toMatchObject({
      observerFailureCount: 1,
      lastFailureKind: 'TypeError',
    });
  });

  it('tracks active observer count', () => {
    const model = new BasemapExperienceModel();
    const unsubscribe = model.subscribe(() => undefined);
    expect(model.getDiagnostics().activeObserverCount).toBe(1);
    unsubscribe();
    expect(model.getDiagnostics().activeObserverCount).toBe(0);
  });

  it('bounds observer count', () => {
    const model = new BasemapExperienceModel({ maxObservers: 2 });
    model.subscribe(() => undefined);
    model.subscribe(() => undefined);
    const rejected = vi.fn();
    model.subscribe(rejected);
    model.beginLoad();
    expect(rejected).not.toHaveBeenCalled();
    expect(model.getDiagnostics()).toMatchObject({
      activeObserverCount: 2,
      rejectedObserverCount: 1,
    });
  });

  it('does not duplicate the same observer', () => {
    const model = new BasemapExperienceModel({ maxObservers: 1 });
    const observer = vi.fn();
    model.subscribe(observer);
    model.subscribe(observer);
    expect(model.getDiagnostics()).toMatchObject({ activeObserverCount: 1, rejectedObserverCount: 0 });
  });

  it('disposes deterministically', () => {
    const model = new BasemapExperienceModel();
    const observer = vi.fn();
    model.subscribe(observer);
    model.dispose();
    expect(model.getDiagnostics()).toMatchObject({ activeObserverCount: 0, disposed: true });
    expect(model.beginLoad()).toBe(false);
    model.succeed(4);
    model.fail('x');
    expect(observer).not.toHaveBeenCalled();
  });

  it('rejects observers after disposal', () => {
    const model = new BasemapExperienceModel();
    model.dispose();
    model.subscribe(() => undefined);
    expect(model.getDiagnostics().rejectedObserverCount).toBe(1);
  });
});

describe('BasemapExperienceModel snapshot integrity', () => {
  it('freezes snapshots', () => {
    const model = new BasemapExperienceModel();
    expect(Object.isFrozen(model.getSnapshot())).toBe(true);
    model.beginLoad();
    expect(Object.isFrozen(model.getSnapshot())).toBe(true);
  });

  it('increments revision for every accepted transition', () => {
    const model = new BasemapExperienceModel();
    const initial = model.getSnapshot().revision;
    model.beginLoad();
    expect(model.getSnapshot().revision).toBe(initial + 1);
    model.fail('x');
    expect(model.getSnapshot().revision).toBe(initial + 2);
    model.resetAttempts();
    expect(model.getSnapshot().revision).toBe(initial + 3);
  });
});
