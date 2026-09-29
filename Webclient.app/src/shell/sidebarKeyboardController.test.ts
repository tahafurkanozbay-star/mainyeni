import { describe, expect, it } from 'vitest';
import { createSidebarKeyboardController } from './sidebarKeyboardController';
import { createSidebarNavigationModel } from './sidebarNavigationModel';
import type { ShellSidebarGroup, ShellSidebarItem } from './sidebarCatalogRuntime';

const GROUPS: readonly ShellSidebarGroup[] = Object.freeze([
  { id: 'ABB', label: 'ABB' },
  { id: 'EGO', label: 'EGO' },
  { id: 'ASKI', label: 'ASKİ' },
  { id: 'ISTIRAK', label: 'İştirak' },
]);
const ITEMS: readonly ShellSidebarItem[] = Object.freeze([
  { group: 'ABB', label: 'Parklar', windowId: 'park' },
  { group: 'ABB', label: 'Kütüphaneler', windowId: 'library' },
  { group: 'EGO', label: 'Otobüs', windowId: 'bus' },
  { group: 'EGO', label: 'Metro', windowId: 'metro' },
  { group: 'ASKI', label: 'Baraj', windowId: 'dam' },
  { group: 'ISTIRAK', label: 'Market', windowId: 'market' },
]);

const setup = (pageSize = 2) => {
  const model = createSidebarNavigationModel({ groups: GROUPS, items: ITEMS });
  const controller = createSidebarKeyboardController({
    model,
    groupIds: GROUPS.map((group) => group.id),
    pageSize,
  });
  return { model, controller };
};

describe('createSidebarKeyboardController', () => {
  it('moves the active service with ArrowDown', () => {
    const { model, controller } = setup();
    const result = controller.handleServiceKey({ key: 'ArrowDown' });
    expect(result).toEqual({ handled: true, focus: { kind: 'active-item', windowId: 'library' }, activateWindowId: null });
    expect(model.getSnapshot().activeItemId).toBe('library');
  });

  it('moves the active service with ArrowUp and wraps', () => {
    const { model, controller } = setup();
    const result = controller.handleServiceKey({ key: 'ArrowUp' });
    expect(result.focus).toEqual({ kind: 'active-item', windowId: 'market' });
    expect(model.getSnapshot().activeItemId).toBe('market');
  });

  it('moves to the first service with Home', () => {
    const { model, controller } = setup();
    model.focusLast();
    const result = controller.handleServiceKey({ key: 'Home' });
    expect(result.focus).toEqual({ kind: 'active-item', windowId: 'park' });
  });

  it('moves to the last service with End', () => {
    const { model, controller } = setup();
    const result = controller.handleServiceKey({ key: 'End' });
    expect(result.focus).toEqual({ kind: 'active-item', windowId: 'market' });
  });

  it('moves by a configured page size', () => {
    const { model, controller } = setup(3);
    const result = controller.handleServiceKey({ key: 'PageDown' });
    expect(result.focus).toEqual({ kind: 'active-item', windowId: 'metro' });
    expect(model.getSnapshot().activeIndex).toBe(3);
  });

  it('moves backward by a configured page size', () => {
    const { model, controller } = setup(2);
    model.setActiveItem('dam');
    const result = controller.handleServiceKey({ key: 'PageUp' });
    expect(result.focus).toEqual({ kind: 'active-item', windowId: 'bus' });
  });

  it.each(['Enter', ' ', 'Spacebar'])('activates the roving item with %s', (key) => {
    const { model, controller } = setup();
    model.setActiveItem('metro');
    expect(controller.handleServiceKey({ key })).toEqual({
      handled: true,
      focus: null,
      activateWindowId: 'metro',
    });
  });

  it('does not invent activation when a filter has no results', () => {
    const { model, controller } = setup();
    model.setQuery('missing');
    expect(controller.handleServiceKey({ key: 'Enter' })).toEqual({ handled: true, focus: null, activateWindowId: null });
  });

  it('clears search first on Escape from a service', () => {
    const { model, controller } = setup();
    model.setQuery('park');
    const result = controller.handleServiceKey({ key: 'Escape' });
    expect(model.getSnapshot().query).toBe('');
    expect(model.getSnapshot().collapsed).toBe(false);
    expect(result.focus).toEqual({ kind: 'search' });
  });

  it('collapses the sidebar on Escape when no query is active', () => {
    const { model, controller } = setup();
    const result = controller.handleServiceKey({ key: 'Escape' });
    expect(model.getSnapshot().collapsed).toBe(true);
    expect(result.focus).toEqual({ kind: 'search' });
  });

  it('does not steal modified service-list keys', () => {
    const { model, controller } = setup();
    const revision = model.getSnapshot().revision;
    expect(controller.handleServiceKey({ key: 'ArrowDown', ctrlKey: true }).handled).toBe(false);
    expect(controller.handleServiceKey({ key: 'ArrowDown', metaKey: true }).handled).toBe(false);
    expect(controller.handleServiceKey({ key: 'ArrowDown', altKey: true }).handled).toBe(false);
    expect(model.getSnapshot().revision).toBe(revision);
  });

  it('does not handle service keys during IME composition', () => {
    const { model, controller } = setup();
    const revision = model.getSnapshot().revision;
    expect(controller.handleServiceKey({ key: 'ArrowDown', isComposing: true }).handled).toBe(false);
    expect(model.getSnapshot().revision).toBe(revision);
  });

  it('ignores unrelated service-list keys', () => {
    const { model, controller } = setup();
    const revision = model.getSnapshot().revision;
    expect(controller.handleServiceKey({ key: 'Tab' })).toEqual({ handled: false, focus: null, activateWindowId: null });
    expect(controller.handleServiceKey({ key: 'a' })).toEqual({ handled: false, focus: null, activateWindowId: null });
    expect(model.getSnapshot().revision).toBe(revision);
  });

  it('moves from search to first service with ArrowDown', () => {
    const { model, controller } = setup();
    model.setActiveItem('metro');
    const result = controller.handleSearchKey({ key: 'ArrowDown' });
    expect(result.focus).toEqual({ kind: 'active-item', windowId: 'park' });
  });

  it('moves from search to last service with ArrowUp', () => {
    const { controller } = setup();
    const result = controller.handleSearchKey({ key: 'ArrowUp' });
    expect(result.focus).toEqual({ kind: 'active-item', windowId: 'market' });
  });

  it('clears search on Escape while keeping focus in search', () => {
    const { model, controller } = setup();
    model.setQuery('park');
    const result = controller.handleSearchKey({ key: 'Escape' });
    expect(model.getSnapshot().query).toBe('');
    expect(result.focus).toEqual({ kind: 'search' });
  });

  it('handles Escape in empty search without collapsing the panel', () => {
    const { model, controller } = setup();
    const result = controller.handleSearchKey({ key: 'Escape' });
    expect(result.handled).toBe(true);
    expect(model.getSnapshot().collapsed).toBe(false);
  });

  it('supports Ctrl+Home from search', () => {
    const { model, controller } = setup();
    model.focusLast();
    const result = controller.handleSearchKey({ key: 'Home', ctrlKey: true });
    expect(result.focus).toEqual({ kind: 'active-item', windowId: 'park' });
  });

  it('supports Meta+End from search', () => {
    const { controller } = setup();
    const result = controller.handleSearchKey({ key: 'End', metaKey: true });
    expect(result.focus).toEqual({ kind: 'active-item', windowId: 'market' });
  });

  it('does not treat plain Home/End in the input as list-navigation commands', () => {
    const { controller } = setup();
    expect(controller.handleSearchKey({ key: 'Home' }).handled).toBe(false);
    expect(controller.handleSearchKey({ key: 'End' }).handled).toBe(false);
  });

  it('does not steal Alt-modified search commands', () => {
    const { controller } = setup();
    expect(controller.handleSearchKey({ key: 'ArrowDown', altKey: true }).handled).toBe(false);
    expect(controller.handleSearchKey({ key: 'Home', ctrlKey: true, altKey: true }).handled).toBe(false);
  });

  it('does not handle search keys during composition', () => {
    const { controller } = setup();
    expect(controller.handleSearchKey({ key: 'ArrowDown', isComposing: true }).handled).toBe(false);
  });

  it('moves group focus right with wrap-around', () => {
    const { controller } = setup();
    expect(controller.handleGroupKey({ key: 'ArrowRight' }, 'ABB').focus).toEqual({ kind: 'group', groupId: 'EGO' });
    expect(controller.handleGroupKey({ key: 'ArrowRight' }, 'ISTIRAK').focus).toEqual({ kind: 'group', groupId: 'ABB' });
  });

  it('moves group focus left with wrap-around', () => {
    const { controller } = setup();
    expect(controller.handleGroupKey({ key: 'ArrowLeft' }, 'ABB').focus).toEqual({ kind: 'group', groupId: 'ISTIRAK' });
    expect(controller.handleGroupKey({ key: 'ArrowLeft' }, 'EGO').focus).toEqual({ kind: 'group', groupId: 'ABB' });
  });

  it('maps vertical group arrows to the same roving sequence', () => {
    const { controller } = setup();
    expect(controller.handleGroupKey({ key: 'ArrowDown' }, 'EGO').focus).toEqual({ kind: 'group', groupId: 'ASKI' });
    expect(controller.handleGroupKey({ key: 'ArrowUp' }, 'EGO').focus).toEqual({ kind: 'group', groupId: 'ABB' });
  });

  it('moves group focus to first/last with Home/End', () => {
    const { controller } = setup();
    expect(controller.handleGroupKey({ key: 'Home' }, 'ASKI').focus).toEqual({ kind: 'group', groupId: 'ABB' });
    expect(controller.handleGroupKey({ key: 'End' }, 'ABB').focus).toEqual({ kind: 'group', groupId: 'ISTIRAK' });
  });

  it('does not mutate selection while merely roving group focus', () => {
    const { model, controller } = setup();
    controller.handleGroupKey({ key: 'ArrowRight' }, 'ABB');
    expect(model.getSnapshot().activeGroupId).toBeNull();
  });

  it('ignores group navigation for unknown current group ids', () => {
    const { controller } = setup();
    expect(controller.handleGroupKey({ key: 'ArrowRight' }, 'UNKNOWN')).toEqual({ handled: false, focus: null, activateWindowId: null });
  });

  it('ignores modified group-navigation keys', () => {
    const { controller } = setup();
    expect(controller.handleGroupKey({ key: 'ArrowRight', ctrlKey: true }, 'ABB').handled).toBe(false);
    expect(controller.handleGroupKey({ key: 'ArrowRight', altKey: true }, 'ABB').handled).toBe(false);
  });

  it('rejects duplicate group ids at construction', () => {
    const model = createSidebarNavigationModel({ groups: GROUPS, items: ITEMS });
    expect(() => createSidebarKeyboardController({ model, groupIds: ['ABB', 'ABB'] })).toThrow(/unique/u);
  });

  it('rejects empty group ids at construction', () => {
    const model = createSidebarNavigationModel({ groups: GROUPS, items: ITEMS });
    expect(() => createSidebarKeyboardController({ model, groupIds: ['ABB', ' '] })).toThrow(/non-empty/u);
  });

  it('clamps oversized page sizes', () => {
    const model = createSidebarNavigationModel({ groups: GROUPS, items: ITEMS });
    const controller = createSidebarKeyboardController({ model, groupIds: GROUPS.map((group) => group.id), pageSize: 1000 });
    const result = controller.handleServiceKey({ key: 'PageDown' });
    expect(result.handled).toBe(true);
    expect(model.getSnapshot().activeItemId).not.toBeNull();
  });
});
