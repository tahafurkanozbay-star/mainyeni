import { CommonReducer, CommonReducer_ActionTypes, initialCommonState } from './CommonReducer';

const register = (state, payload) => CommonReducer(state, {
  type: CommonReducer_ActionTypes.RegisterWindow,
  payload
});

describe('CommonReducer window state', () => {
  test('upserts duplicate window registrations instead of creating conflicting ids', () => {
    const firstRef = { current: { id: 'layers' } };
    const secondRef = { current: { id: 'layers' } };
    const registered = register(initialCommonState, {
      id: 'layers', ref: firstRef, visible: false, minimized: false, query: {}
    });
    const updated = register(registered, {
      id: 'layers', ref: secondRef, visible: false, minimized: false, query: {}
    });

    expect(updated.WindowList).toHaveLength(1);
    expect(updated.WindowList[0].ref).toBe(secondRef);
  });

  test('activating a window is atomic and hides previously visible windows', () => {
    const seeded = {
      ...initialCommonState,
      WindowList: [
        { id: 'sidebar', visible: true, minimized: false, query: {} },
        { id: 'search', visible: false, minimized: false, query: {} }
      ]
    };

    const next = CommonReducer(seeded, {
      type: CommonReducer_ActionTypes.ActivateWindow,
      payload: { windowid: 'search', query: { name: 'park' } }
    });

    expect(next.WindowList.find(item => item.id === 'sidebar')?.visible).toBe(false);
    expect(next.WindowList.find(item => item.id === 'search')).toMatchObject({
      visible: true,
      query: { name: 'park' }
    });
    expect(seeded.WindowList[0]?.visible).toBe(true);
  });

  test('hiding an unknown window is a safe no-op for existing entries', () => {
    const seeded = {
      ...initialCommonState,
      WindowList: [{ id: 'sidebar', visible: true, minimized: false, query: {} }]
    };

    const next = CommonReducer(seeded, {
      type: CommonReducer_ActionTypes.SetWindowVisibility,
      payload: { windowid: 'missing', visible: false }
    });

    expect(next.WindowList).toEqual(seeded.WindowList);
  });

  test('placeholder state survives registration with a real component ref', () => {
    const placeholder = register(initialCommonState, {
      id: 'search', ref: null, visible: true, minimized: false, query: { name: 'ankara' }, lazy: true
    });
    const ref = { current: { id: 'search' } };
    const mounted = register(placeholder, {
      id: 'search', ref, visible: true, minimized: false, query: { name: 'ankara' }, lazy: false
    });

    expect(mounted.WindowList[0]).toMatchObject({
      id: 'search', visible: true, query: { name: 'ankara' }, lazy: false
    });
    expect(mounted.WindowList[0].ref).toBe(ref);
  });
});
