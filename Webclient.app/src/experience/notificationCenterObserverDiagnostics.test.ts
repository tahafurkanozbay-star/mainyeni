import { describe, expect, it, vi } from 'vitest';
import { NotificationCenterModel } from './notificationCenterModel';

describe('NotificationCenterModel observer diagnostics', () => {
  it('starts with an immutable zeroed diagnostic snapshot', () => {
    const model = new NotificationCenterModel();
    expect(model.observerDiagnostics()).toEqual({
      activeObserverCount: 0,
      rejectedObserverCount: 0,
      observerFailureCount: 0,
      reporterFailureCount: 0,
      lastFailureRevision: null,
      lastFailureKind: null,
    });
    expect(Object.isFrozen(model.observerDiagnostics())).toBe(true);
  });

  it('tracks active observers across subscribe and unsubscribe', () => {
    const model = new NotificationCenterModel();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = model.subscribe(first);
    const unsubscribeSecond = model.subscribe(second);
    expect(model.observerDiagnostics().activeObserverCount).toBe(2);
    unsubscribeFirst();
    expect(model.observerDiagnostics().activeObserverCount).toBe(1);
    unsubscribeSecond();
    expect(model.observerDiagnostics().activeObserverCount).toBe(0);
  });

  it('does not double-register the same observer', () => {
    const model = new NotificationCenterModel();
    const observer = vi.fn();
    const first = model.subscribe(observer);
    const second = model.subscribe(observer);
    expect(model.observerDiagnostics().activeObserverCount).toBe(1);
    model.push({ id: 'a', title: 'A' });
    expect(observer).toHaveBeenCalledTimes(2);
    first();
    second();
    expect(model.observerDiagnostics().activeObserverCount).toBe(0);
  });

  it('enforces a bounded observer capacity without throwing into application state', () => {
    const model = new NotificationCenterModel({ maxObservers: 2 });
    const one = vi.fn();
    const two = vi.fn();
    const rejected = vi.fn();
    model.subscribe(one);
    model.subscribe(two);
    const rejectedUnsubscribe = model.subscribe(rejected);
    expect(model.observerDiagnostics()).toMatchObject({
      activeObserverCount: 2,
      rejectedObserverCount: 1,
    });
    expect(rejected).not.toHaveBeenCalled();
    expect(() => rejectedUnsubscribe()).not.toThrow();
    model.push({ id: 'a', title: 'A' });
    expect(one).toHaveBeenCalledTimes(2);
    expect(two).toHaveBeenCalledTimes(2);
    expect(rejected).not.toHaveBeenCalled();
  });

  it('clamps invalid observer capacities to a usable minimum', () => {
    const model = new NotificationCenterModel({ maxObservers: 0 });
    const first = vi.fn();
    const second = vi.fn();
    model.subscribe(first);
    model.subscribe(second);
    expect(model.observerDiagnostics()).toMatchObject({
      activeObserverCount: 1,
      rejectedObserverCount: 1,
    });
  });

  it('records observer failures while allowing healthy observers to receive the same revision', () => {
    const reporter = vi.fn();
    const model = new NotificationCenterModel({ onObserverError: reporter });
    const healthy = vi.fn();
    model.subscribe(() => { throw new TypeError('observer exploded'); });
    model.subscribe(healthy);
    model.push({ id: 'a', title: 'A' });
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(healthy.mock.calls.at(-1)?.[0]).toMatchObject({ revision: 1, unreadCount: 1 });
    expect(reporter).toHaveBeenCalled();
    expect(model.observerDiagnostics()).toMatchObject({
      observerFailureCount: 2,
      reporterFailureCount: 0,
      lastFailureRevision: 1,
      lastFailureKind: 'TypeError',
    });
  });

  it('records diagnostic reporter failures instead of silently swallowing them', () => {
    const model = new NotificationCenterModel({
      onObserverError() {
        throw new RangeError('reporter failed');
      },
    });
    model.subscribe(() => { throw new Error('observer failed'); });
    expect(() => model.push({ id: 'a', title: 'A' })).not.toThrow();
    expect(model.observerDiagnostics()).toMatchObject({
      observerFailureCount: 2,
      reporterFailureCount: 2,
      lastFailureRevision: 1,
      lastFailureKind: 'RangeError',
    });
    expect(model.snapshot().items[0]?.id).toBe('a');
  });

  it('classifies primitive observer failures without persisting raw payloads', () => {
    const model = new NotificationCenterModel();
    model.subscribe(() => { throw 'sensitive raw text'; });
    model.push({ id: 'a', title: 'A' });
    expect(model.observerDiagnostics().lastFailureKind).toBe('string');
    expect(JSON.stringify(model.observerDiagnostics())).not.toContain('sensitive raw text');
  });

  it('clearObservers releases every listener while preserving diagnostic history', () => {
    const model = new NotificationCenterModel();
    const one = vi.fn();
    const two = vi.fn();
    model.subscribe(one);
    model.subscribe(two);
    model.clearObservers();
    expect(model.observerDiagnostics()).toMatchObject({
      activeObserverCount: 0,
      rejectedObserverCount: 0,
    });
    model.push({ id: 'a', title: 'A' });
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
  });

  it('clearObservers is idempotent', () => {
    const model = new NotificationCenterModel();
    model.clearObservers();
    const before = model.observerDiagnostics();
    model.clearObservers();
    expect(model.observerDiagnostics()).toBe(before);
  });

  it('keeps diagnostic objects frozen after every update', () => {
    const model = new NotificationCenterModel({ maxObservers: 1 });
    const unsubscribe = model.subscribe(vi.fn());
    expect(Object.isFrozen(model.observerDiagnostics())).toBe(true);
    model.subscribe(vi.fn());
    expect(Object.isFrozen(model.observerDiagnostics())).toBe(true);
    unsubscribe();
    expect(Object.isFrozen(model.observerDiagnostics())).toBe(true);
  });

  it('continues accepting new observers after a slot is released', () => {
    const model = new NotificationCenterModel({ maxObservers: 1 });
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = model.subscribe(first);
    unsubscribe();
    model.subscribe(second);
    expect(model.observerDiagnostics().activeObserverCount).toBe(1);
    model.push({ id: 'a', title: 'A' });
    expect(second).toHaveBeenCalledTimes(2);
  });
});
