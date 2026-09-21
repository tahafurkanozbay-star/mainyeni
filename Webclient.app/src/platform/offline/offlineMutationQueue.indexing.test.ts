import { describe, expect, it, vi } from 'vitest';
import { OfflineMutationQueue } from './offlineMutationQueue';

const mutation = (id: string, owner: string, overrides: Record<string, unknown> = {}) => ({
  id,
  owner,
  operation: 'save-feature',
  payload: { id },
  ...overrides,
});

describe('OfflineMutationQueue indexed admission and scheduling', () => {
  it('releases owner capacity after a queued mutation is cancelled', async () => {
    const queue = new OfflineMutationQueue({ maxEntries: 4, maxEntriesPerOwner: 1 });
    const first = queue.enqueue(mutation('first', 'editor'));
    expect(queue.cancel('first')).toBe(true);
    await expect(first).resolves.toMatchObject({ state: 'cancelled' });

    const replacement = queue.enqueue(mutation('replacement', 'editor'));
    expect(queue.pending().map(item => item.id)).toEqual(['replacement']);
    queue.setExecutor(async () => true);
    queue.setOnline(true);
    await expect(replacement).resolves.toMatchObject({ state: 'succeeded' });
  });

  it('releases a dedupe key after terminal completion', async () => {
    const queue = new OfflineMutationQueue();
    queue.setExecutor(async (_payload, context) => context.id);
    queue.setOnline(true);

    await expect(queue.enqueue(mutation('first', 'editor', { dedupeKey: 'feature:42' })))
      .resolves.toMatchObject({ id: 'first', state: 'succeeded' });
    await expect(queue.enqueue(mutation('second', 'editor', { dedupeKey: 'feature:42' })))
      .resolves.toMatchObject({ id: 'second', state: 'succeeded' });
  });

  it('deduplicates a running mutation through the index', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const executor = vi.fn(async () => { await blocked; return 'saved'; });
    const queue = new OfflineMutationQueue();
    queue.setExecutor(executor);
    queue.setOnline(true);

    const first = queue.enqueue(mutation('first', 'editor', { dedupeKey: 'feature:42' }));
    await Promise.resolve();
    const duplicate = queue.enqueue(mutation('duplicate', 'editor', { dedupeKey: 'feature:42' }));
    expect(duplicate).toBe(first);
    expect(executor).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('preserves deterministic priority and created-at ordering', async () => {
    const starts: string[] = [];
    const queue = new OfflineMutationQueue({ maxConcurrent: 1, clock: () => 100 });
    queue.setExecutor(async (_payload, context) => { starts.push(context.id); return true; });

    const laterInteractive = queue.enqueue(mutation('z-interactive', 'editor-a', { priority: 'interactive', createdAt: 30 }));
    const background = queue.enqueue(mutation('background', 'editor-b', { priority: 'background', createdAt: 1 }));
    const criticalB = queue.enqueue(mutation('b-critical', 'editor-c', { priority: 'critical', createdAt: 20 }));
    const criticalA = queue.enqueue(mutation('a-critical', 'editor-d', { priority: 'critical', createdAt: 20 }));
    const earlierInteractive = queue.enqueue(mutation('a-interactive', 'editor-e', { priority: 'interactive', createdAt: 10 }));

    queue.setOnline(true);
    await Promise.all([laterInteractive, background, criticalB, criticalA, earlierInteractive]);
    expect(starts).toEqual(['a-critical', 'b-critical', 'a-interactive', 'z-interactive', 'background']);
  });

  it('does not replay stale ready entries after cancellation', async () => {
    const starts: string[] = [];
    const queue = new OfflineMutationQueue({ maxConcurrent: 1 });
    const cancelled = queue.enqueue(mutation('cancelled', 'editor-a', { priority: 'critical' }));
    const live = queue.enqueue(mutation('live', 'editor-b', { priority: 'interactive' }));
    queue.cancel('cancelled');
    queue.setExecutor(async (_payload, context) => { starts.push(context.id); return true; });
    queue.setOnline(true);

    await expect(cancelled).resolves.toMatchObject({ state: 'cancelled' });
    await expect(live).resolves.toMatchObject({ state: 'succeeded' });
    expect(starts).toEqual(['live']);
  });

  it('requeues bounded retries without duplicating ready work', async () => {
    const starts: number[] = [];
    const queue = new OfflineMutationQueue({ maxAttempts: 3, maxConcurrent: 1 });
    queue.setExecutor(async (_payload, context) => {
      starts.push(context.attempt);
      if (context.attempt < 3) throw new Error('temporary');
      return 'saved';
    });
    queue.setOnline(true);

    await expect(queue.enqueue(mutation('retry', 'editor', { maxAttempts: 3 })))
      .resolves.toMatchObject({ state: 'succeeded', attempts: 3 });
    expect(starts).toEqual([1, 2, 3]);
    expect(queue.snapshot()).toMatchObject({ queued: 0, running: 0, totalSucceeded: 1 });
  });

  it('keeps owner accounting isolated across multiple owners', async () => {
    const queue = new OfflineMutationQueue({ maxEntries: 8, maxEntriesPerOwner: 2 });
    const a1 = queue.enqueue(mutation('a1', 'owner-a'));
    const a2 = queue.enqueue(mutation('a2', 'owner-a'));
    const b1 = queue.enqueue(mutation('b1', 'owner-b'));
    await expect(queue.enqueue(mutation('a3', 'owner-a'))).rejects.toMatchObject({ reason: 'owner-capacity' });
    expect(queue.pending().map(item => item.id).sort()).toEqual(['a1', 'a2', 'b1']);

    queue.cancel('a1');
    await a1;
    const a3 = queue.enqueue(mutation('a3', 'owner-a'));
    queue.setExecutor(async () => true);
    queue.setOnline(true);
    await Promise.all([a2, a3, b1]);
  });
});
