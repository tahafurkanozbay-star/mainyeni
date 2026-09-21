import { describe, expect, it, vi } from 'vitest';
import type { RootState } from '../contracts';
import { createSelectorSubscriptionHub } from './stateSubscriptions';

const state = (graphicsCount: number, updating = false): RootState => ({
  Common: {
    BigPopupLinkRef: null,
    WindowList: [],
    ModuleSelectBarVisible: false,
    MapConfiguration: null,
    ConfigurationServices: [],
    Message: null,
  },
  Map: {
    MapView: null,
    IsUpdating: updating,
    Graphics: Array.from({ length: graphicsCount }, (_, index) => index),
    MapClick: () => undefined,
    MobileRightClickEnabled: false,
  },
  ContextMenu: { ActiveOnLeftClick: false },
  DynamicLayers: { List: [] },
});

describe('stateSubscriptions', () => {
  it('notifies only when selected values change', () => {
    const hub = createSelectorSubscriptionHub();
    const listener = vi.fn();
    hub.initialize(state(1));
    hub.subscribe((root) => root.Map.Graphics.length, listener);
    hub.notify(state(1, true), 'map/updating', ['Map']);
    expect(listener).not.toHaveBeenCalled();
    hub.notify(state(2, true), 'map/graphics', ['Map']);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      current: 2,
      previous: 1,
      actionType: 'map/graphics',
    });
  });

  it('can fire an immediate initialized notification', () => {
    const hub = createSelectorSubscriptionHub();
    const listener = vi.fn();
    hub.initialize(state(3));
    hub.subscribe((root) => root.Map.Graphics.length, listener, {
      fireImmediately: true,
    });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      current: 3,
      previous: 3,
      actionType: '@@store-runtime/initialize',
    }));
  });

  it('supports custom equality and unsubscribe', () => {
    const hub = createSelectorSubscriptionHub();
    const listener = vi.fn();
    hub.initialize(state(1));
    const unsubscribe = hub.subscribe(
      (root) => ({ updating: root.Map.IsUpdating }),
      listener,
      { equality: (left, right) => left.updating === right.updating },
    );
    hub.notify(state(2), 'graphics', ['Map']);
    expect(listener).not.toHaveBeenCalled();
    hub.notify(state(2, true), 'updating', ['Map']);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    hub.notify(state(2, false), 'updating', ['Map']);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates selector and listener errors', () => {
    const hub = createSelectorSubscriptionHub();
    hub.initialize(state(1));
    hub.subscribe(() => { throw new Error('selector'); }, vi.fn());
    hub.subscribe((root) => root.Map.IsUpdating, () => { throw new Error('listener'); });
    hub.notify(state(2, true), 'update', ['Map']);
    expect(hub.errorCount).toBeGreaterThanOrEqual(2);
  });

  it('enforces bounded subscriber capacity', () => {
    const hub = createSelectorSubscriptionHub({ maxSubscribers: 1 });
    hub.subscribe((root) => root.Map.IsUpdating, vi.fn());
    expect(() => hub.subscribe((root) => root.Map.IsUpdating, vi.fn()))
      .toThrow(/capacity/);
  });

  it('clears subscribers deterministically', () => {
    const hub = createSelectorSubscriptionHub();
    hub.subscribe((root) => root.Map.IsUpdating, vi.fn());
    hub.subscribe((root) => root.Map.Graphics.length, vi.fn());
    expect(hub.clear()).toBe(2);
    expect(hub.size).toBe(0);
  });
});
