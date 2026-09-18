import { describe, expect, it, vi } from 'vitest';

import {
  createGisEditTransactionRuntime,
  type GisEditCommitContext,
  type GisEditRuntimeEvent,
} from './editTransactionRuntime';

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('createGisEditTransactionRuntime', () => {
  it('creates bounded open transactions with deterministic ids', () => {
    let clock = 100;
    const runtime = createGisEditTransactionRuntime({ now: () => clock });

    const first = runtime.beginTransaction();
    clock += 1;
    const second = runtime.beginTransaction();

    expect(first).toMatchObject({
      transactionId: 'tx-1',
      state: 'open',
      operationCount: 0,
      estimatedBytes: 0,
      createdAt: 100,
      updatedAt: 100,
    });
    expect(second.transactionId).toBe('tx-2');
    expect(second.createdAt).toBe(101);
    expect(runtime.getSnapshot().transactionCount).toBe(2);
  });

  it('accepts an explicit transaction id and immutable metadata', () => {
    const runtime = createGisEditTransactionRuntime();
    const metadata = { workflow: 'field-edit', source: 'map' };

    const snapshot = runtime.beginTransaction({
      transactionId: 'parcel-edit',
      metadata,
      baseRevision: 'r1',
    });

    expect(snapshot.transactionId).toBe('parcel-edit');
    expect(snapshot.baseRevision).toBe('r1');
    expect(snapshot.metadata).toEqual(metadata);
    expect(Object.isFrozen(snapshot.metadata)).toBe(true);
  });

  it('rejects duplicate transaction ids', () => {
    const runtime = createGisEditTransactionRuntime();
    runtime.beginTransaction({ transactionId: 'duplicate' });

    expect(() => runtime.beginTransaction({
      transactionId: 'duplicate',
    })).toThrow(/already exists/i);
  });

  it('enforces transaction capacity', () => {
    const runtime = createGisEditTransactionRuntime({ maxTransactions: 1 });
    runtime.beginTransaction();

    expect(() => runtime.beginTransaction()).toThrow(/capacity exceeded/i);
  });

  it('requires optimistic base revisions when configured', () => {
    const runtime = createGisEditTransactionRuntime({
      requireBaseRevision: true,
    });

    expect(() => runtime.beginTransaction()).toThrow(/base revision is required/i);

    expect(runtime.beginTransaction({
      baseRevision: 'etag-1',
    }).baseRevision).toBe('etag-1');
  });

  it('stages add operations with immutable normalized payloads', () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();

    const operation = runtime.stageAdd(tx.transactionId, {
      layerId: 'trees',
      clientId: 'local-1',
      attributes: {
        name: 'Çınar',
        active: true,
      },
      geometry: {
        type: 'point',
        x: 32.8,
        y: 39.9,
      },
    });

    expect(operation).toMatchObject({
      operationId: 'edit-1',
      sequence: 1,
      kind: 'add',
      layerId: 'trees',
      featureId: null,
      clientId: 'local-1',
    });
    expect(operation.attributes).toEqual({
      name: 'Çınar',
      active: true,
    });
    expect(operation.estimatedBytes).toBeGreaterThan(0);
    expect(operation.fingerprint).toBeTruthy();
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.isFrozen(operation.attributes)).toBe(true);
  });

  it('stages update operations with numeric feature ids and revisions', () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();

    const operation = runtime.stageUpdate(tx.transactionId, {
      layerId: 'roads',
      featureId: 42,
      attributes: { status: 'open' },
      baseRevision: 9,
    });

    expect(operation).toMatchObject({
      kind: 'update',
      layerId: 'roads',
      featureId: 42,
      baseRevision: 9,
    });
  });

  it('preserves numeric zero feature ids without lossy coercion', () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();

    const operation = runtime.stageUpdate(tx.transactionId, {
      layerId: 'roads',
      featureId: 0,
      attributes: { status: 'open' },
    });

    expect(operation.featureId).toBe(0);
  });

  it('stages delete operations without payload attributes or geometry', () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();

    const operation = runtime.stageDelete(tx.transactionId, {
      layerId: 'roads',
      featureId: 'A-17',
      baseRevision: 'rev-2',
    });

    expect(operation).toMatchObject({
      kind: 'delete',
      layerId: 'roads',
      featureId: 'A-17',
      attributes: null,
      geometry: null,
      baseRevision: 'rev-2',
    });
  });

  it('rejects invalid non-finite numeric feature ids', () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();

    expect(() => runtime.stageDelete(tx.transactionId, {
      layerId: 'roads',
      featureId: Number.NaN,
    })).toThrow(/feature id must be finite/i);
  });

  it('rejects blank string feature ids', () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();

    expect(() => runtime.stageDelete(tx.transactionId, {
      layerId: 'roads',
      featureId: '   ',
    })).toThrow(/feature id is required/i);
  });

  it('enforces the operation-count budget before mutating a transaction', () => {
    const runtime = createGisEditTransactionRuntime({
      maxOperationsPerTransaction: 1,
    });
    const tx = runtime.beginTransaction();

    runtime.stageAdd(tx.transactionId, {
      layerId: 'trees',
      attributes: { name: 'first' },
    });

    expect(() => runtime.stageAdd(tx.transactionId, {
      layerId: 'trees',
      attributes: { name: 'second' },
    })).toThrow(/operation budget exceeded/i);

    expect(runtime.getTransaction(tx.transactionId).operationCount).toBe(1);
  });

  it('enforces transaction byte budgets before mutating live staged state', () => {
    const runtime = createGisEditTransactionRuntime({
      maxTransactionBytes: 80,
    });
    const tx = runtime.beginTransaction();

    expect(() => runtime.stageAdd(tx.transactionId, {
      layerId: 'large',
      attributes: {
        text: 'x'.repeat(100),
      },
    })).toThrow(/byte budget/i);

    const snapshot = runtime.getTransaction(tx.transactionId);
    expect(snapshot.operationCount).toBe(0);
    expect(snapshot.estimatedBytes).toBe(0);
  });

  it('enforces attribute key budgets', () => {
    const runtime = createGisEditTransactionRuntime({
      maxAttributeKeys: 2,
    });
    const tx = runtime.beginTransaction();

    expect(() => runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
      attributes: {
        one: 1,
        two: 2,
        three: 3,
      },
    })).toThrow(/key budget/i);
  });

  it('rejects empty attribute names', () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();

    expect(() => runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
      attributes: {
        ' ': 1,
      },
    })).toThrow(/attribute names cannot be empty/i);
  });

  it('rejects non-serializable functions in staged attributes', () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();

    expect(() => runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
      attributes: {
        unsafe: () => 'nope',
      },
    })).toThrow(/non-serializable/i);
  });

  it('rejects non-finite numeric payload values', () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();

    expect(() => runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
      geometry: {
        x: Number.POSITIVE_INFINITY,
        y: 1,
      },
    })).toThrow(/numbers must be finite/i);
  });

  it('rejects cyclic staged payloads', () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();
    const geometry: Record<string, unknown> = {};
    geometry.self = geometry;

    expect(() => runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
      geometry,
    })).toThrow(/cannot contain cycles/i);
  });

  it('rejects payload nesting deeper than the configured budget', () => {
    const runtime = createGisEditTransactionRuntime({
      maxGeometryDepth: 2,
    });
    const tx = runtime.beginTransaction();

    expect(() => runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
      geometry: {
        a: {
          b: {
            c: 1,
          },
        },
      },
    })).toThrow(/nesting exceeds/i);
  });

  it('rejects strings longer than the configured budget', () => {
    const runtime = createGisEditTransactionRuntime({
      maxStringLength: 8,
    });
    const tx = runtime.beginTransaction();

    expect(() => runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
      attributes: {
        value: '123456789',
      },
    })).toThrow(/string exceeds/i);
  });

  it('removes staged operations and reclaims their byte budget', () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();

    const first = runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
      attributes: { value: 'first' },
    });
    runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
      attributes: { value: 'second' },
    });

    const before = runtime.getTransaction(tx.transactionId);
    expect(runtime.removeOperation(tx.transactionId, first.operationId)).toBe(true);
    expect(runtime.removeOperation(tx.transactionId, first.operationId)).toBe(false);

    const after = runtime.getTransaction(tx.transactionId);
    expect(after.operationCount).toBe(1);
    expect(after.estimatedBytes).toBeLessThan(before.estimatedBytes);
  });

  it('clears all staged operations without deleting the transaction', () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();

    runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
      attributes: { value: 1 },
    });

    const cleared = runtime.clearTransaction(tx.transactionId);

    expect(cleared.state).toBe('open');
    expect(cleared.operationCount).toBe(0);
    expect(cleared.estimatedBytes).toBe(0);
    expect(runtime.getSnapshot().transactionCount).toBe(1);
  });

  it('changes transaction fingerprints when staged operations change', () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();
    const before = tx.fingerprint;

    runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
      attributes: { value: 1 },
    });

    const after = runtime.getTransaction(tx.transactionId).fingerprint;
    expect(after).not.toBe(before);
  });

  it('commits immutable operations through the injected adapter', async () => {
    const runtime = createGisEditTransactionRuntime({
      retainCommitted: true,
    });
    const tx = runtime.beginTransaction({
      transactionId: 'commit-me',
      baseRevision: 'rev-1',
      metadata: { source: 'editor' },
    });
    const operation = runtime.stageUpdate(tx.transactionId, {
      layerId: 'parcels',
      featureId: 17,
      attributes: { owner: 'masked' },
      baseRevision: 'feature-4',
    });

    const adapter = vi.fn(async (context: Readonly<GisEditCommitContext>) => {
      expect(context.transactionId).toBe('commit-me');
      expect(context.baseRevision).toBe('rev-1');
      expect(context.metadata).toEqual({ source: 'editor' });
      expect(context.operations).toHaveLength(1);
      expect(Object.isFrozen(context.operations)).toBe(true);
      expect(context.signal.aborted).toBe(false);
      return {
        revision: 'rev-2',
        operationResults: [{
          operationId: operation.operationId,
          success: true,
          featureId: 17,
        }],
        metadata: {
          server: 'accepted',
        },
      };
    });

    const result = await runtime.commit(tx.transactionId, adapter);

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      transactionId: 'commit-me',
      state: 'committed',
      revision: 'rev-2',
      operationCount: 1,
    });
    expect(result.operationResults).toEqual([{
      operationId: operation.operationId,
      success: true,
      featureId: 17,
      errorCode: null,
      message: null,
    }]);
    expect(result.metadata).toEqual({ server: 'accepted' });
    expect(runtime.getTransaction(tx.transactionId).state).toBe('committed');
    expect(runtime.getSnapshot().totalCommits).toBe(1);
  });

  it('synthesizes successful operation results when an adapter omits them', async () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();
    const operation = runtime.stageDelete(tx.transactionId, {
      layerId: 'parcels',
      featureId: 9,
    });

    const result = await runtime.commit(tx.transactionId, async () => ({
      revision: 10,
    }));

    expect(result.operationResults).toEqual([{
      operationId: operation.operationId,
      success: true,
      featureId: 9,
      errorCode: null,
      message: null,
    }]);
  });

  it('removes committed transactions by default to bound retained memory', async () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();

    runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
      attributes: { value: 1 },
    });

    await runtime.commit(tx.transactionId, async () => ({}));

    expect(runtime.getSnapshot().transactionCount).toBe(0);
    expect(() => runtime.getTransaction(tx.transactionId)).toThrow(/not registered/i);
  });

  it('rejects empty transaction commits', async () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();

    await expect(runtime.commit(tx.transactionId, async () => ({})))
      .rejects.toThrow(/empty/i);
  });

  it('rejects commits without an adapter', async () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();
    runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
    });

    await expect(runtime.commit(
      tx.transactionId,
      null as unknown as (context: Readonly<GisEditCommitContext>) => Promise<{}>,
    )).rejects.toThrow(/adapter is required/i);
  });

  it('fails the whole commit when an adapter marks an operation unsuccessful', async () => {
    const runtime = createGisEditTransactionRuntime({
      retainFailed: true,
    });
    const tx = runtime.beginTransaction();
    const operation = runtime.stageUpdate(tx.transactionId, {
      layerId: 'roads',
      featureId: 5,
      attributes: { status: 'closed' },
    });

    await expect(runtime.commit(tx.transactionId, async () => ({
      operationResults: [{
        operationId: operation.operationId,
        success: false,
        errorCode: 'REVISION_CONFLICT',
        message: 'stale revision',
      }],
    }))).rejects.toThrow(/stale revision/i);

    const snapshot = runtime.getTransaction(tx.transactionId);
    expect(snapshot.state).toBe('failed');
    expect(snapshot.failureCode).toBe('REVISION_CONFLICT');
    expect(runtime.getSnapshot().totalFailures).toBe(1);
  });

  it('removes failed transactions by default', async () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();
    runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
    });

    await expect(runtime.commit(tx.transactionId, async () => {
      throw Object.assign(new Error('server rejected'), { code: 'SERVER_REJECTED' });
    })).rejects.toThrow(/server rejected/i);

    expect(runtime.getSnapshot().transactionCount).toBe(0);
  });

  it('rejects staging changes while a transaction is committing', async () => {
    const runtime = createGisEditTransactionRuntime({
      retainCommitted: true,
    });
    const tx = runtime.beginTransaction();
    runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
    });
    const gate = deferred<{}>();

    const commitPromise = runtime.commit(tx.transactionId, async () => gate.promise);

    expect(runtime.getTransaction(tx.transactionId).state).toBe('committing');
    expect(() => runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
    })).toThrow(/not mutable/i);

    gate.resolve({});
    await commitPromise;
  });

  it('propagates external abort signals to the adapter context', async () => {
    const runtime = createGisEditTransactionRuntime({
      retainFailed: true,
    });
    const tx = runtime.beginTransaction();
    runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
    });
    const external = new AbortController();
    const observed = deferred<void>();

    const promise = runtime.commit(tx.transactionId, async ({ signal }) => {
      signal.addEventListener('abort', () => observed.resolve(), { once: true });
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
        setTimeout(resolve, 1000);
      });
      return {};
    }, {
      signal: external.signal,
    });

    external.abort('navigation changed');
    await observed.promise;

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.getTransaction(tx.transactionId).failureCode).toBe('ABORTED');
  });

  it('aborts an active commit through abortCommit', async () => {
    const runtime = createGisEditTransactionRuntime({
      retainFailed: true,
    });
    const tx = runtime.beginTransaction();
    runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
    });
    const started = deferred<void>();

    const promise = runtime.commit(tx.transactionId, async ({ signal }) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
      return {};
    });

    await started.promise;

    expect(runtime.abortCommit(tx.transactionId, 'user cancelled')).toBe(true);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.getTransaction(tx.transactionId).failureCode).toBe('ABORTED');
  });

  it('returns false when abortCommit targets a non-committing transaction', () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();

    expect(runtime.abortCommit(tx.transactionId)).toBe(false);
  });

  it('rolls back open transactions and clears staged payloads', () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();

    runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
      attributes: { value: 1 },
    });

    const rolledBack = runtime.rollback(tx.transactionId, 'cancelled dialog');

    expect(rolledBack.state).toBe('rolled-back');
    expect(rolledBack.operationCount).toBe(0);
    expect(rolledBack.estimatedBytes).toBe(0);
    expect(runtime.getSnapshot().totalRollbacks).toBe(1);
  });

  it('rejects local rollback of committed retained transactions', async () => {
    const runtime = createGisEditTransactionRuntime({
      retainCommitted: true,
    });
    const tx = runtime.beginTransaction();
    runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
    });
    await runtime.commit(tx.transactionId, async () => ({}));

    expect(() => runtime.rollback(tx.transactionId)).toThrow(/cannot be rolled back/i);
  });

  it('removes non-committing transactions explicitly', () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();

    expect(runtime.removeTransaction(tx.transactionId)).toBe(true);
    expect(runtime.getSnapshot().transactionCount).toBe(0);
  });

  it('refuses transaction removal while commit is active', async () => {
    const runtime = createGisEditTransactionRuntime({
      retainCommitted: true,
    });
    const tx = runtime.beginTransaction();
    runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
    });
    const gate = deferred<{}>();
    const promise = runtime.commit(tx.transactionId, async () => gate.promise);

    expect(() => runtime.removeTransaction(tx.transactionId))
      .toThrow(/while it is committing/i);

    gate.resolve({});
    await promise;
  });

  it('lists transactions deterministically by creation time and id', () => {
    let clock = 100;
    const runtime = createGisEditTransactionRuntime({ now: () => clock });

    runtime.beginTransaction({ transactionId: 'zeta' });
    clock += 1;
    runtime.beginTransaction({ transactionId: 'alpha' });

    expect(runtime.listTransactions().map((entry) => entry.transactionId)).toEqual([
      'zeta',
      'alpha',
    ]);
  });

  it('returns immutable operation snapshots', () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();
    runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
      attributes: { value: 1 },
    });

    const operations = runtime.getOperations(tx.transactionId);

    expect(Object.isFrozen(operations)).toBe(true);
    expect(Object.isFrozen(operations[0])).toBe(true);
    expect(Object.isFrozen(operations[0]?.attributes)).toBe(true);
  });

  it('tracks staging and commit metrics separately from retained transaction count', async () => {
    const runtime = createGisEditTransactionRuntime();
    const tx = runtime.beginTransaction();

    runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
    });
    runtime.stageDelete(tx.transactionId, {
      layerId: 'layer',
      featureId: 1,
    });

    await runtime.commit(tx.transactionId, async () => ({}));

    expect(runtime.getSnapshot()).toMatchObject({
      transactionCount: 0,
      totalOperationsStaged: 2,
      totalCommits: 1,
      totalFailures: 0,
    });
  });

  it('emits lifecycle events with stable transaction and operation identities', async () => {
    const events: GisEditRuntimeEvent[] = [];
    const runtime = createGisEditTransactionRuntime({
      retainCommitted: true,
      now: () => 1234,
    });
    runtime.subscribe((event) => events.push(event));

    const tx = runtime.beginTransaction({ transactionId: 'event-tx' });
    const operation = runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
    });
    await runtime.commit(tx.transactionId, async () => ({}));

    expect(events.map((event) => event.type)).toEqual([
      'transaction-created',
      'operation-staged',
      'commit-started',
      'commit-succeeded',
    ]);
    expect(events[1]).toMatchObject({
      timestamp: 1234,
      transactionId: 'event-tx',
      operationId: operation.operationId,
    });
  });

  it('isolates event listener failures through onListenerError', () => {
    const onListenerError = vi.fn();
    const runtime = createGisEditTransactionRuntime({ onListenerError });

    runtime.subscribe(() => {
      throw new Error('listener failed');
    });

    expect(() => runtime.beginTransaction()).not.toThrow();
    expect(onListenerError).toHaveBeenCalledTimes(1);
  });

  it('supports idempotent listener unsubscription', () => {
    const listener = vi.fn();
    const runtime = createGisEditTransactionRuntime();
    const unsubscribe = runtime.subscribe(listener);

    expect(unsubscribe()).toBe(true);
    expect(unsubscribe()).toBe(false);

    runtime.beginTransaction();

    expect(listener).not.toHaveBeenCalled();
  });

  it('destroys active commits, staged payloads and listeners', async () => {
    const runtime = createGisEditTransactionRuntime({
      retainFailed: true,
    });
    const tx = runtime.beginTransaction();
    runtime.stageAdd(tx.transactionId, {
      layerId: 'layer',
    });
    const started = deferred<void>();

    const commitPromise = runtime.commit(tx.transactionId, async ({ signal }) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('runtime destroyed');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
      return {};
    });

    await started.promise;
    runtime.destroy();

    await expect(commitPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.getSnapshot()).toMatchObject({
      destroyed: true,
      transactionCount: 0,
    });
    expect(() => runtime.beginTransaction()).toThrow(/destroyed/i);
  });
});
