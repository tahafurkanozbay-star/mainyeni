import { describe, expect, it } from 'vitest';
import { clearWorkspaceLiveTopic, consumeWorkspaceLiveMessage, createWorkspaceLiveRegionState, enqueueWorkspaceLiveMessage, pruneWorkspaceLiveRegion, replaceWorkspaceTopicAnnouncement, workspaceLiveRegionSnapshot, workspaceLiveRegionText } from './workspaceLiveRegionModel';

describe('workspaceLiveRegionModel', () => {
  it('starts empty and immutable', () => {
    const state = createWorkspaceLiveRegionState();
    expect(state.polite).toEqual([]);
    expect(state.assertive).toEqual([]);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.polite)).toBe(true);
  });

  it('normalizes and enqueues polite announcements', () => {
    const state = enqueueWorkspaceLiveMessage(createWorkspaceLiveRegionState(), { topic: 'map', text: '  Harita   hazır. ', now: 100 });
    expect(workspaceLiveRegionText(state, 'polite')).toBe('Harita hazır.');
    expect(state.polite[0]?.topic).toBe('map');
    expect(state.polite[0]?.priority).toBe('polite');
  });

  it('keeps assertive announcements separate', () => {
    const state = enqueueWorkspaceLiveMessage(createWorkspaceLiveRegionState(), { topic: 'connectivity', priority: 'assertive', text: 'Bağlantı kesildi.', now: 100 });
    expect(state.polite).toHaveLength(0);
    expect(state.assertive).toHaveLength(1);
    expect(workspaceLiveRegionSnapshot(state).hasUrgentMessage).toBe(true);
  });

  it('deduplicates repeated announcements inside the bounded window', () => {
    const first = enqueueWorkspaceLiveMessage(createWorkspaceLiveRegionState(), { topic: 'map', text: 'Harita hazır.', now: 100, dedupeMs: 1000 });
    const second = enqueueWorkspaceLiveMessage(first, { topic: 'map', text: 'Harita hazır.', now: 500, dedupeMs: 1000 });
    expect(second.polite).toHaveLength(1);
  });

  it('allows an announcement after its dedupe window', () => {
    const first = enqueueWorkspaceLiveMessage(createWorkspaceLiveRegionState(), { topic: 'map', text: 'Harita hazır.', now: 100, dedupeMs: 500 });
    const second = enqueueWorkspaceLiveMessage(first, { topic: 'map', text: 'Harita hazır.', now: 700, dedupeMs: 500 });
    expect(second.polite).toHaveLength(2);
  });

  it('bounds each queue to six messages', () => {
    let state = createWorkspaceLiveRegionState();
    for (let index = 0; index < 10; index += 1) state = enqueueWorkspaceLiveMessage(state, { topic: 'system', text: `Mesaj ${index}`, now: index * 100 });
    expect(state.polite).toHaveLength(6);
    expect(state.polite[0]?.text).toBe('Mesaj 4');
    expect(state.polite[5]?.text).toBe('Mesaj 9');
  });

  it('truncates pathological announcement text', () => {
    const state = enqueueWorkspaceLiveMessage(createWorkspaceLiveRegionState(), { topic: 'system', text: 'x'.repeat(500), now: 0 });
    expect(state.polite[0]?.text).toHaveLength(240);
  });

  it('ignores empty normalized text', () => {
    const initial = createWorkspaceLiveRegionState();
    expect(enqueueWorkspaceLiveMessage(initial, { topic: 'system', text: '   ', now: 0 })).toBe(initial);
  });

  it('prunes expired messages and fingerprints', () => {
    const state = enqueueWorkspaceLiveMessage(createWorkspaceLiveRegionState(), { topic: 'map', text: 'Yükleniyor', now: 0, ttlMs: 500, dedupeMs: 500 });
    const pruned = pruneWorkspaceLiveRegion(state, 501);
    expect(pruned.polite).toHaveLength(0);
    expect(Object.keys(pruned.recentFingerprints)).toHaveLength(0);
  });

  it('consumes messages in FIFO order', () => {
    let state = createWorkspaceLiveRegionState();
    state = enqueueWorkspaceLiveMessage(state, { topic: 'map', text: 'Bir', now: 0 });
    state = enqueueWorkspaceLiveMessage(state, { topic: 'map', text: 'İki', now: 1 });
    const consumed = consumeWorkspaceLiveMessage(state, 'polite');
    expect(consumed.message?.text).toBe('Bir');
    expect(consumed.state.polite[0]?.text).toBe('İki');
  });

  it('returns a stable no-op when consuming an empty queue', () => {
    const initial = createWorkspaceLiveRegionState();
    const consumed = consumeWorkspaceLiveMessage(initial, 'assertive');
    expect(consumed.message).toBeNull();
    expect(consumed.state).toBe(initial);
  });

  it('replaces prior topic announcements without touching other topics', () => {
    let state = createWorkspaceLiveRegionState();
    state = enqueueWorkspaceLiveMessage(state, { topic: 'map', text: 'Harita yükleniyor', now: 0 });
    state = enqueueWorkspaceLiveMessage(state, { topic: 'navigation', text: 'Araçlara geçildi', now: 1 });
    state = replaceWorkspaceTopicAnnouncement(state, { topic: 'map', text: 'Harita hazır', now: 2 });
    expect(state.polite.map((message) => message.text)).toEqual(['Araçlara geçildi', 'Harita hazır']);
  });

  it('clears a topic from both priority queues', () => {
    let state = createWorkspaceLiveRegionState();
    state = enqueueWorkspaceLiveMessage(state, { topic: 'connectivity', text: 'A', now: 0 });
    state = enqueueWorkspaceLiveMessage(state, { topic: 'connectivity', priority: 'assertive', text: 'B', now: 1 });
    const cleared = clearWorkspaceLiveTopic(state, 'connectivity');
    expect(cleared.polite).toHaveLength(0);
    expect(cleared.assertive).toHaveLength(0);
  });

  it('keeps unrelated topic messages while clearing', () => {
    let state = createWorkspaceLiveRegionState();
    state = enqueueWorkspaceLiveMessage(state, { topic: 'map', text: 'Map', now: 0 });
    state = enqueueWorkspaceLiveMessage(state, { topic: 'dialog', text: 'Dialog', now: 1 });
    expect(clearWorkspaceLiveTopic(state, 'map').polite.map((message) => message.topic)).toEqual(['dialog']);
  });

  it('reports bounded queue counts', () => {
    let state = createWorkspaceLiveRegionState();
    state = enqueueWorkspaceLiveMessage(state, { topic: 'map', text: 'Map', now: 0 });
    state = enqueueWorkspaceLiveMessage(state, { topic: 'system', priority: 'assertive', text: 'Error', now: 1 });
    expect(workspaceLiveRegionSnapshot(state)).toEqual({ politeCount: 1, assertiveCount: 1, hasUrgentMessage: true });
  });
});
