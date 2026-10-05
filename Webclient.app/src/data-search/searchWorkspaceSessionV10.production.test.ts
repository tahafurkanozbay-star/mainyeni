import { describe, expect, it } from 'vitest';
import { createSearchWorkspaceSessionV10 } from './searchWorkspaceSessionV10';
import { createWorkspaceRuntimeV10 } from './searchWorkspaceV10.testFixtures';

describe('SearchWorkspaceSessionV10', () => {
  it('maps an immediate canonical v9 session result into one v10 page', async () => {
    const { experience, workspace } = createWorkspaceRuntimeV10();
    const session = createSearchWorkspaceSessionV10(workspace, experience, {
      experienceSession: { debounceMs: 0 },
    });
    const before = experience.snapshot().searches;
    const envelope = await session.searchNow('ankara', { query: 'park' });
    expect(envelope.page.handoff.results.length).toBeGreaterThan(0);
    expect(envelope.stale).toBe(false);
    expect(experience.snapshot().searches).toBe(before + 1);
    expect(workspace.snapshot().adoptedModels).toBe(1);
    expect(workspace.snapshot().searches).toBe(0);
    session.dispose();
  });

  it('reuses canonical debounce instead of creating a second timer authority', async () => {
    const { experience, workspace } = createWorkspaceRuntimeV10();
    const session = createSearchWorkspaceSessionV10(workspace, experience, {
      experienceSession: { debounceMs: 1 },
    });
    const envelope = await session.schedule('ankara', { query: 'hastane' });
    expect(envelope.page.handoff.resultCount).toBeGreaterThan(0);
    expect(session.state().status).toBe('success');
    expect(session.history()).toHaveLength(1);
    session.dispose();
  });

  it('propagates external abort through the canonical session', async () => {
    const { experience, workspace } = createWorkspaceRuntimeV10();
    const session = createSearchWorkspaceSessionV10(workspace, experience, {
      experienceSession: { debounceMs: 50 },
    });
    const controller = new AbortController();
    const pending = session.schedule('ankara', { query: 'park' }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(session.state().status).toBe('cancelled');
    session.dispose();
  });

  it('supports canonical load-more and maps the resulting v9 model once', async () => {
    const { experience, workspace } = createWorkspaceRuntimeV10();
    const session = createSearchWorkspaceSessionV10(workspace, experience, {
      experienceSession: { debounceMs: 0 },
    });
    const first = await session.searchNow('ankara', { query: '', limit: 2 });
    if (first.page.handoff.pagination.hasNext) {
      const next = await session.loadMore();
      expect(next.page.handoff.pagination.currentPage).toBeGreaterThan(first.page.handoff.pagination.currentPage);
    }
    session.dispose();
  });

  it('retains completed pages only when explicitly enabled and obeys the bound', async () => {
    const { experience, workspace } = createWorkspaceRuntimeV10();
    const session = createSearchWorkspaceSessionV10(workspace, experience, {
      experienceSession: { debounceMs: 0 },
      retainCompletedPages: true,
      maxCompletedPages: 2,
    });
    await session.searchNow('ankara', { query: 'park' });
    await session.searchNow('ankara', { query: 'hastane' });
    await session.searchNow('ankara', { query: 'kültür' });
    expect(session.pages()).toHaveLength(2);
    expect(session.snapshot().completedPages).toBe(3);
    expect(session.snapshot().retainedPages).toBe(2);
    session.dispose();
  });

  it('retains no page payloads by default', async () => {
    const { experience, workspace } = createWorkspaceRuntimeV10();
    const session = createSearchWorkspaceSessionV10(workspace, experience, {
      experienceSession: { debounceMs: 0 },
    });
    await session.searchNow('ankara', { query: 'park' });
    expect(session.pages()).toEqual([]);
    expect(session.snapshot().retainedPages).toBe(0);
    session.dispose();
  });

  it('dispose clears retained page models and blocks later execution', async () => {
    const { experience, workspace } = createWorkspaceRuntimeV10();
    const session = createSearchWorkspaceSessionV10(workspace, experience, {
      experienceSession: { debounceMs: 0 },
      retainCompletedPages: true,
    });
    await session.searchNow('ankara', { query: 'park' });
    expect(session.pages()).toHaveLength(1);
    session.dispose();
    expect(session.pages()).toEqual([]);
    await expect(session.searchNow('ankara', { query: 'park' })).rejects.toThrow('disposed');
  });
});
