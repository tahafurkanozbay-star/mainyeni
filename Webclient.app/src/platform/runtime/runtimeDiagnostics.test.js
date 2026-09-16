import {
  RuntimeDiagnostics,
  installBrowserRuntimeObservers,
} from './runtimeDiagnostics';

describe('RuntimeDiagnostics', () => {
  test('keeps a bounded event history and records dropped entries', () => {
    let now = 100;
    const diagnostics = new RuntimeDiagnostics({
      capacity: 10,
      now: () => now++,
    });

    for (let index = 0; index < 14; index += 1) {
      diagnostics.record('sample', { index });
    }

    const snapshot = diagnostics.snapshot();
    expect(snapshot.capacity).toBe(10);
    expect(snapshot.size).toBe(10);
    expect(snapshot.dropped).toBe(4);
    expect(snapshot.events[0].details.index).toBe(4);
    expect(snapshot.events[9].details.index).toBe(13);
    expect(snapshot.events[0].timestamp).toBe(104);
  });

  test('redacts sensitive keys recursively without mutating input', () => {
    const source = {
      authorization: 'Bearer super-secret',
      profile: {
        name: 'Ada',
        token: 'abc123',
      },
      nested: [{ apiKey: 'private-key', value: 42 }],
    };
    const diagnostics = new RuntimeDiagnostics();

    diagnostics.record('security.sample', source);
    const event = diagnostics.snapshot().events[0];

    expect(event.details.authorization).toBe('[redacted]');
    expect(event.details.profile).toEqual({
      name: 'Ada',
      token: '[redacted]',
    });
    expect(event.details.nested).toEqual([
      { apiKey: '[redacted]', value: 42 },
    ]);
    expect(source.authorization).toBe('Bearer super-secret');
    expect(source.profile.token).toBe('abc123');
  });

  test('normalizes Error objects and captures bounded diagnostic context', () => {
    const diagnostics = new RuntimeDiagnostics();
    const error = new TypeError('boom');

    const event = diagnostics.captureError(error, {
      source: 'unit-test',
      password: 'never-log-me',
    }, 'fatal');

    expect(event.type).toBe('runtime.error');
    expect(event.severity).toBe('fatal');
    expect(event.message).toBe('boom');
    expect(event.details.source).toBe('unit-test');
    expect(event.details.password).toBe('[redacted]');
    expect(event.details.error).toEqual(expect.objectContaining({
      name: 'TypeError',
      message: 'boom',
    }));
  });

  test('converts non-Error failures into safe error records', () => {
    const diagnostics = new RuntimeDiagnostics();

    const event = diagnostics.captureError({ reason: 'network down' }, {
      source: 'promise',
    });

    expect(event.type).toBe('runtime.error');
    expect(event.message).toBe('[object Object]');
    expect(event.details.error).toEqual(expect.objectContaining({
      name: 'Error',
      message: '[object Object]',
    }));
  });

  test('truncates oversized strings and object collections', () => {
    const diagnostics = new RuntimeDiagnostics();
    const huge = 'x'.repeat(5000);
    const many = {};
    for (let index = 0; index < 100; index += 1) {
      many[`k${index}`] = index;
    }

    diagnostics.record('large', { huge, many });
    const event = diagnostics.snapshot().events[0];

    expect(event.details.huge.length).toBeLessThan(1300);
    expect(Object.keys(event.details.many)).toHaveLength(80);
  });

  test('limits recursive depth to prevent pathological diagnostics payloads', () => {
    const diagnostics = new RuntimeDiagnostics();
    const payload = {
      first: {
        second: {
          third: {
            fourth: {
              fifth: {
                sixth: 'hidden',
              },
            },
          },
        },
      },
    };

    diagnostics.record('deep', payload);
    const event = diagnostics.snapshot().events[0];

    expect(event.details.first.second.third.fourth.fifth).toBe('[max-depth]');
  });

  test('clear removes events and resets dropped count while preserving monotonic ids', () => {
    const diagnostics = new RuntimeDiagnostics({ capacity: 10 });
    for (let index = 0; index < 12; index += 1) {
      diagnostics.record('before-clear', { index });
    }
    const before = diagnostics.snapshot();
    expect(before.dropped).toBe(2);

    diagnostics.clear();
    const empty = diagnostics.snapshot();
    expect(empty.size).toBe(0);
    expect(empty.dropped).toBe(0);

    const after = diagnostics.record('after-clear');
    expect(after.id).toBeGreaterThan(before.events[before.events.length - 1].id);
  });

  test('snapshots are detached from later buffer mutations', () => {
    const diagnostics = new RuntimeDiagnostics();
    diagnostics.record('first');
    const firstSnapshot = diagnostics.snapshot();

    diagnostics.record('second');
    const secondSnapshot = diagnostics.snapshot();

    expect(firstSnapshot.events).toHaveLength(1);
    expect(secondSnapshot.events).toHaveLength(2);
  });
});

describe('installBrowserRuntimeObservers', () => {
  test('captures window errors and removes listeners on dispose', () => {
    const diagnostics = new RuntimeDiagnostics();
    const handle = installBrowserRuntimeObservers(diagnostics);

    window.dispatchEvent(new ErrorEvent('error', {
      message: 'runtime failure',
      error: new Error('runtime failure'),
      filename: 'app.js',
      lineno: 12,
      colno: 4,
    }));

    expect(diagnostics.snapshot().events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'runtime.error',
        severity: 'fatal',
        message: 'runtime failure',
      }),
    ]));

    const countBeforeDispose = diagnostics.snapshot().size;
    handle.dispose();
    window.dispatchEvent(new ErrorEvent('error', {
      message: 'after dispose',
      error: new Error('after dispose'),
    }));
    expect(diagnostics.snapshot().size).toBe(countBeforeDispose);
  });

  test('captures unhandled promise rejection reasons when supported by the test DOM', () => {
    const diagnostics = new RuntimeDiagnostics();
    const handle = installBrowserRuntimeObservers(diagnostics);

    const event = typeof PromiseRejectionEvent === 'function'
      ? new PromiseRejectionEvent('unhandledrejection', {
        promise: Promise.resolve(),
        reason: new Error('rejected'),
      })
      : Object.assign(new Event('unhandledrejection'), {
        reason: new Error('rejected'),
        promise: Promise.resolve(),
      });

    window.dispatchEvent(event);

    expect(diagnostics.snapshot().events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'runtime.error',
        message: 'rejected',
      }),
    ]));
    handle.dispose();
  });
});
