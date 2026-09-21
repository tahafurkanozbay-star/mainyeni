import { describe, expect, test, vi } from 'vitest';
import {
  createMutationIdempotencyRegistry,
  MutationIdempotencyError,
  type MutationIdempotencyEvent,
} from './mutationIdempotency';

const createClock = (startAt = 1_000) => {
  let current = startAt;
  return {
    now: () => current,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
    rewind: (milliseconds: number) => {
      current -= milliseconds;
    },
    set: (value: number) => {
      current = value;
    },
  };
};

describe('MutationIdempotencyRegistry admission', () => {
  test('admits one mutation and returns an immutable lease surface', () => {
    const registry = createMutationIdempotencyRegistry();
    const lease = registry.begin({
      key: 'mutation-0001',
      owner: 'catalog',
      method: 'post',
    });

    expect(lease.owner).toBe('catalog');
    expect(lease.method).toBe('post');
    expect(lease.state).toBe('in-flight');
    expect(Object.isFrozen(lease)).toBe(true);
    expect(registry.snapshot()).toMatchObject({
      entries: 1,
      inFlight: 1,
      retained: 0,
      owners: 1,
      counters: {
        admitted: 1,
        rejected: 0,
      },
    });
  });

  test('normalizes method case without exposing key identity', () => {
    const registry = createMutationIdempotencyRegistry();
    const lease = registry.begin({
      key: 'mutation-0002',
      owner: 'owner',
      method: 'POST',
    });

    expect(lease.method).toBe('post');
    expect(JSON.stringify(lease.snapshot())).not.toContain('mutation-0002');
    expect(JSON.stringify(registry.snapshot())).not.toContain('mutation-0002');
  });

  test.each([
    '',
    'short',
    'contains space',
    'contains/slash',
    'contains?query',
    'ğ-invalid-ascii',
  ])('rejects invalid idempotency key %p', (key) => {
    const registry = createMutationIdempotencyRegistry();
    expect(() => registry.begin({
      key,
      owner: 'owner',
      method: 'post',
    })).toThrowError(MutationIdempotencyError);
  });

  test('rejects overlong idempotency keys', () => {
    const registry = createMutationIdempotencyRegistry({ maxKeyLength: 32 });
    expect(() => registry.begin({
      key: 'x'.repeat(33),
      owner: 'owner',
      method: 'post',
    })).toMatchObject;
    try {
      registry.begin({
        key: 'x'.repeat(33),
        owner: 'owner',
        method: 'post',
      });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' });
    }
  });

  test.each([
    '',
    '   ',
    'owner\nnewline',
    'owner\0null',
  ])('rejects invalid owner %p', (owner) => {
    const registry = createMutationIdempotencyRegistry();
    expect(() => registry.begin({
      key: 'mutation-owner-0001',
      owner,
      method: 'post',
    })).toThrowError(MutationIdempotencyError);
  });

  test('rejects overlong owner values', () => {
    const registry = createMutationIdempotencyRegistry({ maxOwnerLength: 16 });
    expect(() => registry.begin({
      key: 'mutation-owner-0002',
      owner: 'x'.repeat(17),
      method: 'post',
    })).toThrowError(MutationIdempotencyError);
  });

  test.each(['', 'post-1', 'post/patch', 'post patch'])(
    'rejects invalid method %p',
    (method) => {
      const registry = createMutationIdempotencyRegistry();
      expect(() => registry.begin({
        key: 'mutation-method-0001',
        owner: 'owner',
        method,
      })).toThrowError(MutationIdempotencyError);
    },
  );

  test('rejects non-string contract fields without coercion', () => {
    const registry = createMutationIdempotencyRegistry();
    expect(() => registry.begin({
      key: 123 as never,
      owner: 'owner',
      method: 'post',
    })).toThrowError(MutationIdempotencyError);
    expect(() => registry.begin({
      key: 'mutation-contract-0001',
      owner: 123 as never,
      method: 'post',
    })).toThrowError(MutationIdempotencyError);
    expect(() => registry.begin({
      key: 'mutation-contract-0002',
      owner: 'owner',
      method: 123 as never,
    })).toThrowError(MutationIdempotencyError);
  });

  test('rejects a request already aborted before admission', () => {
    const controller = new AbortController();
    controller.abort(new Error('caller-left'));
    const registry = createMutationIdempotencyRegistry();

    try {
      registry.begin({
        key: 'mutation-aborted-0001',
        owner: 'owner',
        method: 'post',
        signal: controller.signal,
      });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'MUTATION_ABORTED',
        name: 'MutationIdempotencyError',
      });
    }

    expect(registry.snapshot()).toMatchObject({
      entries: 0,
      counters: { admitted: 0, rejected: 1 },
    });
  });
});

describe('MutationIdempotencyRegistry duplicate prevention', () => {
  test('rejects the same key while first mutation remains in flight', () => {
    const registry = createMutationIdempotencyRegistry();
    registry.begin({
      key: 'mutation-duplicate-0001',
      owner: 'catalog',
      method: 'post',
    });

    expect(() => registry.begin({
      key: 'mutation-duplicate-0001',
      owner: 'catalog',
      method: 'post',
    })).toThrowError(expect.objectContaining({
      code: 'IDEMPOTENCY_KEY_IN_FLIGHT',
    }));

    expect(registry.snapshot().counters).toMatchObject({
      admitted: 1,
      rejected: 1,
      inFlightConflicts: 1,
      retainedConflicts: 0,
    });
  });

  test('rejects the same key even if a different owner tries to reuse it', () => {
    const registry = createMutationIdempotencyRegistry();
    registry.begin({
      key: 'mutation-global-key-0001',
      owner: 'catalog',
      method: 'post',
    });

    expect(() => registry.begin({
      key: 'mutation-global-key-0001',
      owner: 'search',
      method: 'patch',
    })).toThrowError(expect.objectContaining({
      code: 'IDEMPOTENCY_KEY_IN_FLIGHT',
    }));
  });

  test('retains completed keys and rejects early replay', () => {
    const clock = createClock();
    const registry = createMutationIdempotencyRegistry({
      retentionMs: 5_000,
      clock: clock.now,
    });
    const lease = registry.begin({
      key: 'mutation-retained-0001',
      owner: 'catalog',
      method: 'post',
    });
    lease.markAttempt();
    lease.complete();

    clock.advance(4_999);
    expect(() => registry.begin({
      key: 'mutation-retained-0001',
      owner: 'catalog',
      method: 'post',
    })).toThrowError(expect.objectContaining({
      code: 'IDEMPOTENCY_KEY_REUSED',
    }));

    expect(registry.snapshot().counters).toMatchObject({
      retainedConflicts: 1,
    });
  });

  test('allows reuse only after retention expires and pruning occurs', () => {
    const clock = createClock();
    const registry = createMutationIdempotencyRegistry({
      retentionMs: 5_000,
      clock: clock.now,
    });
    registry.begin({
      key: 'mutation-expire-0001',
      owner: 'catalog',
      method: 'post',
    }).complete();

    clock.advance(5_000);
    const replacement = registry.begin({
      key: 'mutation-expire-0001',
      owner: 'catalog',
      method: 'post',
    });

    expect(replacement.state).toBe('in-flight');
    expect(registry.snapshot().counters).toMatchObject({
      admitted: 2,
      pruned: 1,
    });
  });

  test('does not auto-expire a long-running in-flight mutation', () => {
    const clock = createClock();
    const registry = createMutationIdempotencyRegistry({
      retentionMs: 1_000,
      staleInFlightAfterMs: 2_000,
      clock: clock.now,
    });
    registry.begin({
      key: 'mutation-long-running-0001',
      owner: 'catalog',
      method: 'post',
    });

    clock.advance(60_000);
    expect(registry.prune()).toBe(0);
    expect(() => registry.begin({
      key: 'mutation-long-running-0001',
      owner: 'catalog',
      method: 'post',
    })).toThrowError(expect.objectContaining({
      code: 'IDEMPOTENCY_KEY_IN_FLIGHT',
    }));

    expect(registry.snapshot()).toMatchObject({
      inFlight: 1,
      staleInFlight: 1,
      oldestInFlightAgeMs: 60_000,
    });
  });

  test.each(['failed', 'cancelled'] as const)(
    'retains %s keys to block ambiguous replay',
    (state) => {
      const registry = createMutationIdempotencyRegistry();
      const lease = registry.begin({
        key: 'mutation-terminal-replay-' + state,
        owner: 'catalog',
        method: 'post',
      });
      if (state === 'failed') lease.fail(new Error('server failed after send'));
      else lease.cancel(new Error('caller left after dispatch'));

      expect(() => registry.begin({
        key: 'mutation-terminal-replay-' + state,
        owner: 'catalog',
        method: 'post',
      })).toThrowError(expect.objectContaining({
        code: 'IDEMPOTENCY_KEY_REUSED',
      }));
    },
  );
});

describe('MutationIdempotencyRegistry capacity governance', () => {
  test('rejects global capacity before admitting hidden work', () => {
    const registry = createMutationIdempotencyRegistry({
      maxEntries: 2,
      maxEntriesPerOwner: 2,
    });
    registry.begin({ key: 'mutation-capacity-0001', owner: 'one', method: 'post' });
    registry.begin({ key: 'mutation-capacity-0002', owner: 'two', method: 'post' });

    expect(() => registry.begin({
      key: 'mutation-capacity-0003',
      owner: 'three',
      method: 'post',
    })).toThrowError(expect.objectContaining({
      code: 'REGISTRY_CAPACITY_EXCEEDED',
    }));
    expect(registry.snapshot().entries).toBe(2);
  });

  test('enforces per-owner capacity independently from global capacity', () => {
    const registry = createMutationIdempotencyRegistry({
      maxEntries: 4,
      maxEntriesPerOwner: 1,
    });
    registry.begin({
      key: 'mutation-owner-capacity-0001',
      owner: 'catalog',
      method: 'post',
    });

    expect(() => registry.begin({
      key: 'mutation-owner-capacity-0002',
      owner: 'catalog',
      method: 'post',
    })).toThrowError(expect.objectContaining({
      code: 'OWNER_CAPACITY_EXCEEDED',
    }));

    expect(() => registry.begin({
      key: 'mutation-owner-capacity-0003',
      owner: 'search',
      method: 'post',
    })).not.toThrow();
  });

  test('retained entries continue consuming bounded capacity until expiry', () => {
    const clock = createClock();
    const registry = createMutationIdempotencyRegistry({
      maxEntries: 1,
      maxEntriesPerOwner: 1,
      retentionMs: 2_000,
      clock: clock.now,
    });
    registry.begin({
      key: 'mutation-retained-capacity-0001',
      owner: 'catalog',
      method: 'post',
    }).complete();

    expect(() => registry.begin({
      key: 'mutation-retained-capacity-0002',
      owner: 'catalog',
      method: 'post',
    })).toThrowError(expect.objectContaining({
      code: 'REGISTRY_CAPACITY_EXCEEDED',
    }));

    clock.advance(2_000);
    expect(() => registry.begin({
      key: 'mutation-retained-capacity-0002',
      owner: 'catalog',
      method: 'post',
    })).not.toThrow();
  });

  test('explicit prune frees expired owner and global capacity', () => {
    const clock = createClock();
    const registry = createMutationIdempotencyRegistry({
      maxEntries: 2,
      maxEntriesPerOwner: 1,
      retentionMs: 1_000,
      clock: clock.now,
    });
    registry.begin({
      key: 'mutation-prune-0001',
      owner: 'catalog',
      method: 'post',
    }).complete();
    registry.begin({
      key: 'mutation-prune-0002',
      owner: 'search',
      method: 'post',
    }).complete();

    clock.advance(1_000);
    expect(registry.prune()).toBe(2);
    expect(registry.snapshot()).toMatchObject({
      entries: 0,
      owners: 0,
      counters: { pruned: 2 },
    });
  });
});

describe('MutationIdempotencyLease lifecycle', () => {
  test('records logical attempts without exposing transport payloads', () => {
    const registry = createMutationIdempotencyRegistry();
    const lease = registry.begin({
      key: 'mutation-attempts-0001',
      owner: 'catalog',
      method: 'post',
    });

    expect(lease.markAttempt()).toBe(true);
    expect(lease.markAttempt()).toBe(true);
    expect(lease.markAttempt()).toBe(true);
    expect(lease.snapshot()).toMatchObject({
      state: 'in-flight',
      logicalAttempts: 3,
    });
  });

  test('complete is idempotent after first terminal transition', () => {
    const registry = createMutationIdempotencyRegistry();
    const lease = registry.begin({
      key: 'mutation-complete-0001',
      owner: 'catalog',
      method: 'post',
    });

    expect(lease.complete()).toBe(true);
    expect(lease.complete()).toBe(false);
    expect(lease.fail(new Error('late failure'))).toBe(false);
    expect(lease.cancel(new Error('late cancel'))).toBe(false);
    expect(lease.state).toBe('completed');
    expect(registry.snapshot().counters).toMatchObject({
      completed: 1,
      failed: 0,
      cancelled: 0,
    });
  });

  test('failure retains only bounded error class name', () => {
    const registry = createMutationIdempotencyRegistry();
    const lease = registry.begin({
      key: 'mutation-failure-0001',
      owner: 'catalog',
      method: 'post',
    });
    lease.markAttempt();
    lease.fail(new TypeError('private internal database detail'));

    const snapshot = registry.snapshot();
    expect(snapshot.history[0]).toMatchObject({
      state: 'failed',
      errorName: 'TypeError',
      logicalAttempts: 1,
    });
    expect(JSON.stringify(snapshot)).not.toContain('private internal database detail');
  });

  test('cancellation retains only bounded error class name', () => {
    const registry = createMutationIdempotencyRegistry();
    const lease = registry.begin({
      key: 'mutation-cancel-0001',
      owner: 'catalog',
      method: 'patch',
    });
    lease.cancel(Object.assign(new Error('route-left-private'), { name: 'AbortError' }));

    expect(registry.snapshot().history[0]).toMatchObject({
      state: 'cancelled',
      errorName: 'AbortError',
    });
    expect(JSON.stringify(registry.snapshot())).not.toContain('route-left-private');
  });

  test('lease age is derived from monotonic clock', () => {
    const clock = createClock(10_000);
    const registry = createMutationIdempotencyRegistry({ clock: clock.now });
    const lease = registry.begin({
      key: 'mutation-age-0001',
      owner: 'catalog',
      method: 'post',
    });
    clock.advance(325);

    expect(lease.snapshot()).toMatchObject({
      startedAt: 10_000,
      ageMs: 325,
    });
  });

  test('attempts cannot be recorded after settlement', () => {
    const registry = createMutationIdempotencyRegistry();
    const lease = registry.begin({
      key: 'mutation-attempt-terminal-0001',
      owner: 'catalog',
      method: 'post',
    });
    lease.complete();

    expect(lease.markAttempt()).toBe(false);
    expect(lease.snapshot().logicalAttempts).toBe(0);
  });
});

describe('MutationIdempotencyRegistry history and privacy', () => {
  test('retains bounded immutable settlement history', () => {
    const clock = createClock();
    const registry = createMutationIdempotencyRegistry({
      historyLimit: 2,
      clock: clock.now,
    });

    for (let index = 0; index < 3; index += 1) {
      const lease = registry.begin({
        key: 'mutation-history-000' + index,
        owner: 'catalog',
        method: 'post',
      });
      lease.markAttempt();
      clock.advance(10);
      lease.complete();
      clock.advance(1);
    }

    const snapshot = registry.snapshot();
    expect(snapshot.history).toHaveLength(2);
    expect(snapshot.history.map((item) => item.startedAt)).toEqual([1_011, 1_022]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.counters)).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
    expect(Object.isFrozen(snapshot.history[0])).toBe(true);
  });

  test('supports disabling history without disabling replay protection', () => {
    const registry = createMutationIdempotencyRegistry({ historyLimit: 0 });
    registry.begin({
      key: 'mutation-history-disabled-0001',
      owner: 'catalog',
      method: 'post',
    }).complete();

    expect(registry.snapshot().history).toEqual([]);
    expect(() => registry.begin({
      key: 'mutation-history-disabled-0001',
      owner: 'catalog',
      method: 'post',
    })).toThrowError(expect.objectContaining({
      code: 'IDEMPOTENCY_KEY_REUSED',
    }));
  });

  test('never exposes raw idempotency keys through snapshots or history', () => {
    const secretKey = 'mutation-secret-key-0001';
    const registry = createMutationIdempotencyRegistry();
    const lease = registry.begin({
      key: secretKey,
      owner: 'catalog',
      method: 'post',
    });
    lease.markAttempt();
    lease.complete();

    expect(JSON.stringify(registry.snapshot())).not.toContain(secretKey);
    expect(JSON.stringify(lease.snapshot())).not.toContain(secretKey);
  });

  test('observer events exclude raw key values and error messages', () => {
    const events: MutationIdempotencyEvent[] = [];
    const secretKey = 'mutation-event-secret-0001';
    const registry = createMutationIdempotencyRegistry({
      onEvent: (event) => events.push(event),
    });
    const lease = registry.begin({
      key: secretKey,
      owner: 'catalog',
      method: 'post',
    });
    lease.markAttempt();
    lease.fail(new Error('private mutation error body'));

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain('private mutation error body');
    expect(serialized).toContain('Error');
  });

  test('observer failure cannot break mutation admission or settlement', () => {
    const observer = vi.fn(() => {
      throw new Error('observer failure');
    });
    const registry = createMutationIdempotencyRegistry({ onEvent: observer });

    const lease = registry.begin({
      key: 'mutation-observer-0001',
      owner: 'catalog',
      method: 'post',
    });
    expect(() => lease.complete()).not.toThrow();
    expect(registry.snapshot().counters.observerFailures).toBeGreaterThanOrEqual(2);
  });
});

describe('MutationIdempotencyRegistry time safety', () => {
  test('rejects non-finite clock values', () => {
    const registry = createMutationIdempotencyRegistry({
      clock: () => Number.NaN,
    });
    expect(() => registry.begin({
      key: 'mutation-clock-0001',
      owner: 'catalog',
      method: 'post',
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_CLOCK',
    }));
  });

  test('rejects negative clock values', () => {
    const registry = createMutationIdempotencyRegistry({
      clock: () => -1,
    });
    expect(() => registry.snapshot()).toThrowError(expect.objectContaining({
      code: 'INVALID_CLOCK',
    }));
  });

  test('rejects backward moving time', () => {
    const clock = createClock();
    const registry = createMutationIdempotencyRegistry({ clock: clock.now });
    registry.snapshot();
    clock.rewind(1);

    expect(() => registry.snapshot()).toThrowError(expect.objectContaining({
      code: 'INVALID_CLOCK',
    }));
  });

  test('reports stale in-flight pressure without mutating entry state', () => {
    const clock = createClock();
    const registry = createMutationIdempotencyRegistry({
      staleInFlightAfterMs: 5_000,
      clock: clock.now,
    });
    const lease = registry.begin({
      key: 'mutation-stale-0001',
      owner: 'catalog',
      method: 'post',
    });
    clock.advance(5_000);

    expect(registry.snapshot()).toMatchObject({
      staleInFlight: 1,
      oldestInFlightAgeMs: 5_000,
    });
    expect(lease.state).toBe('in-flight');
  });
});

describe('MutationIdempotencyRegistry disposal', () => {
  test('cancels all in-flight leases and clears active capacity', () => {
    const registry = createMutationIdempotencyRegistry();
    const first = registry.begin({
      key: 'mutation-dispose-0001',
      owner: 'catalog',
      method: 'post',
    });
    const second = registry.begin({
      key: 'mutation-dispose-0002',
      owner: 'search',
      method: 'patch',
    });

    registry.dispose(new Error('application shutdown'));

    expect(first.state).toBe('cancelled');
    expect(second.state).toBe('cancelled');
    expect(registry.snapshot()).toMatchObject({
      disposed: true,
      entries: 0,
      inFlight: 0,
      retained: 0,
      owners: 0,
      counters: {
        admitted: 2,
        cancelled: 2,
      },
    });
  });

  test('dispose is idempotent', () => {
    const registry = createMutationIdempotencyRegistry();
    registry.dispose('first');
    expect(() => registry.dispose('second')).not.toThrow();
    expect(registry.snapshot().disposed).toBe(true);
  });

  test('rejects future admission after disposal', () => {
    const registry = createMutationIdempotencyRegistry();
    registry.dispose();

    expect(() => registry.begin({
      key: 'mutation-after-dispose-0001',
      owner: 'catalog',
      method: 'post',
    })).toThrowError(expect.objectContaining({
      code: 'REGISTRY_DISPOSED',
    }));
  });

  test('does not leak disposal reason text', () => {
    const registry = createMutationIdempotencyRegistry();
    registry.begin({
      key: 'mutation-dispose-private-0001',
      owner: 'catalog',
      method: 'post',
    });
    registry.dispose(new Error('private shutdown detail'));

    expect(JSON.stringify(registry.snapshot())).not.toContain('private shutdown detail');
  });
});

describe('MutationIdempotencyRegistry option validation', () => {
  test.each([
    ['maxEntries', 0],
    ['maxEntries', 10_001],
    ['retentionMs', 999],
    ['staleInFlightAfterMs', 999],
    ['maxKeyLength', 15],
    ['maxOwnerLength', 15],
    ['historyLimit', -1],
  ] as const)('rejects invalid option %s=%s', (key, value) => {
    expect(() => createMutationIdempotencyRegistry({
      [key]: value,
    })).toThrowError(MutationIdempotencyError);
  });

  test('rejects owner capacity above global capacity', () => {
    expect(() => createMutationIdempotencyRegistry({
      maxEntries: 2,
      maxEntriesPerOwner: 3,
    })).toThrowError(MutationIdempotencyError);
  });

  test('accepts boundary values for compact deployments', () => {
    expect(() => createMutationIdempotencyRegistry({
      maxEntries: 1,
      maxEntriesPerOwner: 1,
      retentionMs: 1_000,
      staleInFlightAfterMs: 1_000,
      maxKeyLength: 16,
      maxOwnerLength: 16,
      historyLimit: 0,
    })).not.toThrow();
  });
});
