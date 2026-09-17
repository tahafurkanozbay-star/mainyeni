import { describe, expect, test } from 'vitest';
import {
  COMMON_ACTION_TYPES,
  CONTEXT_MENU_ACTION_TYPES,
  DYNAMIC_LAYER_ACTION_TYPES,
  MAP_ACTION_TYPES,
  initialCommonState,
  initialContextMenuState,
  initialDynamicLayersState,
  initialMapState,
  normalizeWindowRegistration,
  upsertWindowRegistration,
} from './contracts';
import { CommonReducer } from './Reducers/CommonReducer';
import { ContextMenuReducer } from './Reducers/ContextMenuReducer';
import { DynamicLayersReducer } from './Reducers/DynamicLayersReducer';
import { MapReducer } from './Reducers/MapReducer';
import { rootReducer } from './Store';

describe('typed store migration contracts', () => {
  test('freezes baseline collections', () => {
    expect(Object.isFrozen(initialCommonState)).toBe(true);
    expect(Object.isFrozen(initialCommonState.WindowList)).toBe(true);
    expect(Object.isFrozen(initialMapState.Graphics)).toBe(true);
    expect(Object.isFrozen(initialDynamicLayersState.List)).toBe(true);
  });

  test('normalizes a new window with legacy defaults', () => {
    const value = normalizeWindowRegistration({ id: 'search', title: 'Search' });
    expect(value).toMatchObject({
      id: 'search',
      title: 'Search',
      ref: null,
      visible: false,
      minimized: false,
      query: null,
    });
    expect(Object.isFrozen(value)).toBe(true);
  });

  test('preserves omitted state while updating an existing window', () => {
    const ref = { current: 'legacy-ref' };
    const current = [{
      id: 'search',
      title: 'Old',
      ref,
      visible: true,
      minimized: true,
      query: { name: 'Ankara' },
    }] as const;
    const next = upsertWindowRegistration(current, { id: 'search', title: 'New' });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: 'search',
      title: 'New',
      ref,
      visible: true,
      minimized: true,
      query: { name: 'Ankara' },
    });
  });

  test('allows explicit false/null updates', () => {
    const current = [{
      id: 'search',
      visible: true,
      minimized: true,
      query: { name: 'Ankara' },
    }] as const;
    const next = upsertWindowRegistration(current, {
      id: 'search',
      visible: false,
      minimized: false,
      query: null,
    });
    expect(next[0]).toMatchObject({ visible: false, minimized: false, query: null });
  });
});

describe('typed reducers preserve public action contracts', () => {
  test('common reducer registers, activates, hides and removes windows', () => {
    let state = CommonReducer(initialCommonState, {
      type: COMMON_ACTION_TYPES.RegisterWindow,
      payload: { id: 'a', visible: true, query: { page: 1 } },
    });
    state = CommonReducer(state, {
      type: COMMON_ACTION_TYPES.RegisterWindow,
      payload: { id: 'b' },
    });
    state = CommonReducer(state, {
      type: COMMON_ACTION_TYPES.ActivateWindow,
      payload: { windowid: 'b', query: { page: 2 } },
    });
    expect(state.WindowList.find((item) => item.id === 'a')?.visible).toBe(false);
    expect(state.WindowList.find((item) => item.id === 'b')).toMatchObject({ visible: true, query: { page: 2 } });

    state = CommonReducer(state, {
      type: COMMON_ACTION_TYPES.SetWindowMinimized,
      payload: { windowid: 'b', minimized: true },
    });
    expect(state.WindowList.find((item) => item.id === 'b')?.minimized).toBe(true);

    state = CommonReducer(state, {
      type: COMMON_ACTION_TYPES.RemoveWindow,
      payload: { windowid: 'a' },
    });
    expect(state.WindowList.map((item) => item.id)).toEqual(['b']);
  });

  test('common reducer validates configuration payloads', () => {
    const services = CommonReducer(initialCommonState, {
      type: COMMON_ACTION_TYPES.SetConfigurationServices,
      payload: [{ title: 'Parks', eg: '/parks' }, null, 'invalid'],
    });
    expect(services.ConfigurationServices).toEqual([{ title: 'Parks', eg: '/parks' }]);
    expect(Object.isFrozen(services.ConfigurationServices)).toBe(true);

    const invalidConfig = CommonReducer(initialCommonState, {
      type: COMMON_ACTION_TYPES.SetMapConfiguration,
      payload: ['invalid'],
    });
    expect(invalidConfig.MapConfiguration).toBeNull();
  });

  test('common reducer accepts a real link element only', () => {
    const link = document.createElement('link');
    const valid = CommonReducer(initialCommonState, {
      type: COMMON_ACTION_TYPES.SetBigPopupLinkRef,
      payload: link,
    });
    expect(valid.BigPopupLinkRef).toBe(link);
    const invalid = CommonReducer(valid, {
      type: COMMON_ACTION_TYPES.SetBigPopupLinkRef,
      payload: { tagName: 'DIV' },
    });
    expect(invalid.BigPopupLinkRef).toBeNull();
  });

  test('map reducer validates array/function/boolean payloads', () => {
    const graphic = { id: 1 };
    const graphics = MapReducer(initialMapState, {
      type: MAP_ACTION_TYPES.SetGraphics,
      payload: [graphic],
    });
    expect(graphics.Graphics).toEqual([graphic]);
    expect(Object.isFrozen(graphics.Graphics)).toBe(true);
    expect(MapReducer(graphics, { type: MAP_ACTION_TYPES.SetGraphics, payload: 'bad' }).Graphics).toEqual([]);

    const handler = () => undefined;
    const click = MapReducer(initialMapState, {
      type: MAP_ACTION_TYPES.SetMapClickEvent,
      payload: handler,
    });
    expect(click.MapClick).toBe(handler);
    expect(MapReducer(click, { type: MAP_ACTION_TYPES.SetMapClickEvent, payload: 'bad' }).MapClick).toBe(handler);

    expect(MapReducer(initialMapState, {
      type: MAP_ACTION_TYPES.SetMobileRightClick,
      payload: true,
    }).MobileRightClickEnabled).toBe(true);
  });

  test('dynamic layers supports Set/Replace and bounded remove', () => {
    const set = DynamicLayersReducer(initialDynamicLayersState, {
      type: DYNAMIC_LAYER_ACTION_TYPES.Set,
      payload: [{ id: 'a' }, { id: 'b' }],
    });
    expect(set.List).toEqual([{ id: 'a' }, { id: 'b' }]);
    const removed = DynamicLayersReducer(set, {
      type: DYNAMIC_LAYER_ACTION_TYPES.Remove,
      payload: 0,
    });
    expect(removed.List).toEqual([{ id: 'b' }]);
    expect(DynamicLayersReducer(set, {
      type: DYNAMIC_LAYER_ACTION_TYPES.Remove,
      payload: 99,
    })).toBe(set);
    expect(DynamicLayersReducer(set, {
      type: DYNAMIC_LAYER_ACTION_TYPES.Replace,
      payload: [{ id: 'c' }],
    }).List).toEqual([{ id: 'c' }]);
  });

  test('context menu contract remains compatible', () => {
    const enabled = ContextMenuReducer(initialContextMenuState, {
      type: CONTEXT_MENU_ACTION_TYPES.EnableOnLeftClick,
    });
    expect(enabled.ActiveOnLeftClick).toBe(true);
    expect(ContextMenuReducer(enabled, {
      type: CONTEXT_MENU_ACTION_TYPES.DisableOnLeftClick,
    }).ActiveOnLeftClick).toBe(false);
  });

  test('root reducer keeps stable domain names', () => {
    const state = rootReducer(undefined, { type: '@@typed-migration-test' });
    expect(Object.keys(state).sort()).toEqual(['Common', 'ContextMenu', 'DynamicLayers', 'Map'].sort());
  });
});
