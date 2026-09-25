import { describe, expect, test, vi } from 'vitest';
import { createRuntimeRecoveryModel } from './runtimeRecoveryModel';

describe('runtimeRecoveryModel', () => {
  test('starts healthy with bounded recovery capacity', () => {
    const model = createRuntimeRecoveryModel();
    expect(model.snapshot()).toMatchObject({
      phase: 'healthy',
      recoveryAttempts: 0,
      maxRecoveryAttempts: 2,
      canRecover: false,
      canReload: false,
      failure: null,
    });
  });

  test('captures a render failure with a deterministic safe fingerprint', () => {
    const error = Object.assign(new Error('Cannot render map shell'), {
      code: 'ui_render_1',
    });
    const model = createRuntimeRecoveryModel();
    const snapshot = model.capture({
      error,
      source: 'app.shell.render',
      componentStack: '\n at ExperienceWorkspace (/tmp/path.tsx:2:3)\n at App',
    });

    expect(snapshot.phase).toBe('crashed');
    expect(snapshot.canRecover).toBe(true);
    expect(snapshot.failure).toMatchObject({
      name: 'Error',
      code: 'UI_RENDER_1',
      source: 'app.shell.render',
      message: 'Cannot render map shell',
      componentHint: 'at ExperienceWorkspace',
    });
    expect(snapshot.failure?.fingerprint).toMatch(/^UI-[a-f0-9]{8}$/);
  });

  test('creates the same fingerprint for the same safe failure inputs', () => {
    const one = createRuntimeRecoveryModel();
    const two = createRuntimeRecoveryModel();
    const error = new Error('same');

    const a = one.capture({ error, source: 'react.render' }).failure?.fingerprint;
    const b = two.capture({ error, source: 'react.render' }).failure?.fingerprint;
    expect(a).toBe(b);
  });

  test('changes fingerprint when the source changes', () => {
    const model = createRuntimeRecoveryModel();
    const first = model.capture({ error: new Error('same'), source: 'one' }).failure?.fingerprint;
    const second = model.capture({ error: new Error('same'), source: 'two' }).failure?.fingerprint;
    expect(first).not.toBe(second);
  });

  test('sanitizes unsafe source names and failure codes', () => {
    const error = Object.assign(new Error('failed'), { code: '<script>' });
    const model = createRuntimeRecoveryModel();
    model.capture({ error, source: '<img src=x onerror=1>' });

    expect(model.snapshot().failure).toMatchObject({
      code: null,
      source: 'react.render',
    });
  });

  test('bounds long error messages and collapses whitespace', () => {
    const model = createRuntimeRecoveryModel();
    model.capture({ error: new Error(` bad\n\tmessage ${'x'.repeat(500)}`) });
    const message = model.snapshot().failure?.message ?? '';

    expect(message.length).toBeLessThanOrEqual(240);
    expect(message).not.toContain('\n');
    expect(message).not.toContain('\t');
    expect(message).not.toContain('  ');
  });

  test('does not serialize arbitrary non-Error objects', () => {
    const model = createRuntimeRecoveryModel();
    model.capture({
      error: { token: 'secret', nested: { password: 'hidden' } },
      source: 'react.render',
    });

    const failure = model.snapshot().failure;
    expect(failure?.name).toBe('RuntimeError');
    expect(failure?.message).not.toContain('secret');
    expect(failure?.message).not.toContain('password');
  });

  test('begins and completes a recovery attempt', () => {
    let now = 100;
    const model = createRuntimeRecoveryModel({ now: () => now });
    model.capture({ error: new Error('failure') });

    expect(model.beginRecovery()).toBe(true);
    expect(model.snapshot()).toMatchObject({
      phase: 'recovering',
      recoveryAttempts: 1,
      canRecover: false,
    });

    now = 200;
    model.completeRecovery();
    expect(model.snapshot()).toMatchObject({
      phase: 'healthy',
      failure: null,
      recoveryAttempts: 1,
      lastRecoveredAt: 200,
    });
  });

  test('ignores completeRecovery outside recovering state', () => {
    const model = createRuntimeRecoveryModel();
    model.capture({ error: new Error('failure') });
    const revision = model.snapshot().revision;

    model.completeRecovery();
    expect(model.snapshot().revision).toBe(revision);
    expect(model.snapshot().phase).toBe('crashed');
  });

  test('locks recovery after the configured maximum attempts', () => {
    const model = createRuntimeRecoveryModel({ maxRecoveryAttempts: 2 });

    model.capture({ error: new Error('one') });
    expect(model.beginRecovery()).toBe(true);
    model.failRecovery({ error: new Error('two') });
    expect(model.snapshot()).toMatchObject({
      phase: 'crashed',
      recoveryAttempts: 1,
      canRecover: true,
    });

    expect(model.beginRecovery()).toBe(true);
    model.failRecovery({ error: new Error('three') });
    expect(model.snapshot()).toMatchObject({
      phase: 'locked',
      recoveryAttempts: 2,
      canRecover: false,
      canReload: true,
    });
    expect(model.beginRecovery()).toBe(false);
  });

  test('clamps recovery attempts to a narrow safe range', () => {
    expect(createRuntimeRecoveryModel({ maxRecoveryAttempts: 0 }).snapshot().maxRecoveryAttempts).toBe(1);
    expect(createRuntimeRecoveryModel({ maxRecoveryAttempts: 99 }).snapshot().maxRecoveryAttempts).toBe(4);
  });

  test('records capture and recovery timestamps using the injected clock', () => {
    let now = 1_000;
    const model = createRuntimeRecoveryModel({ now: () => now });
    model.capture({ error: new Error('failure') });
    expect(model.snapshot().capturedAt).toBe(1_000);

    now = 2_000;
    model.beginRecovery();
    model.completeRecovery();
    expect(model.snapshot().lastRecoveredAt).toBe(2_000);
  });

  test('reset clears the recovery budget and failure state', () => {
    const model = createRuntimeRecoveryModel({ maxRecoveryAttempts: 1 });
    model.capture({ error: new Error('failure') });
    model.beginRecovery();
    model.failRecovery({ error: new Error('again') });
    expect(model.snapshot().phase).toBe('locked');

    model.reset();
    expect(model.snapshot()).toMatchObject({
      phase: 'healthy',
      recoveryAttempts: 0,
      failure: null,
      capturedAt: null,
      lastRecoveredAt: null,
    });
  });

  test('notifies observers on meaningful transitions', () => {
    const model = createRuntimeRecoveryModel();
    const phases: string[] = [];
    model.subscribe(snapshot => phases.push(snapshot.phase));

    model.capture({ error: new Error('failed') });
    model.beginRecovery();
    model.completeRecovery();

    expect(phases).toEqual(['healthy', 'crashed', 'recovering', 'healthy']);
  });

  test('isolates observer failures from healthy observers', () => {
    const report = vi.fn();
    const model = createRuntimeRecoveryModel({ onObserverError: report });
    const healthy = vi.fn();

    model.subscribe(() => {
      throw new Error('observer failed');
    });
    model.subscribe(healthy);
    healthy.mockClear();

    expect(() => model.capture({ error: new Error('render failed') })).not.toThrow();
    expect(report).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  test('isolates failures thrown by the observer reporter', () => {
    const model = createRuntimeRecoveryModel({
      onObserverError: () => {
        throw new Error('reporter failed');
      },
    });
    model.subscribe(() => {
      throw new Error('observer failed');
    });

    expect(() => model.capture({ error: new Error('render failed') })).not.toThrow();
  });

  test('unsubscribe stops future notifications', () => {
    const model = createRuntimeRecoveryModel();
    const observer = vi.fn();
    const unsubscribe = model.subscribe(observer);
    observer.mockClear();

    unsubscribe();
    model.capture({ error: new Error('failure') });
    expect(observer).not.toHaveBeenCalled();
  });
});
