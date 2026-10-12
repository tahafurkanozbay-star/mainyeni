import { forwardRef, useEffect, useImperativeHandle, createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWindowManager, type ManagedWindowHandle, type WindowManagerApi } from '../../Store/Managers/WindowManager';
import Store from '../../Store/Store';
import { CommonReducer_ActionTypes } from '../../Store/Reducers/CommonReducer';
import { LazyManagedWindow } from './LazyManagedWindow';
import { createManagedWindowComponent } from './managedWindowLoading';

vi.mock('../../Business/LoggingBusiness', () => ({ LoggingBusiness: { CreateClientLog: vi.fn(async () => undefined) } }));
const show = vi.fn();
const dispose = vi.fn();
const Tool = forwardRef<ManagedWindowHandle, Record<string, unknown>>((props, ref) => {
  const id = String(props.id);
  const manager = props.windowManager as WindowManagerApi;
  const ownedRef = ref as ReturnType<typeof createRef<ManagedWindowHandle>>;
  useImperativeHandle(ref, () => ({ id, OnShow: show }));
  useEffect(() => {
    manager.RegisterWindow(ownedRef);
    return () => { dispose(); manager.UnregisterWindow(id, ownedRef); };
  }, [id, manager, ownedRef]);
  return <section aria-label="Test aracı" hidden={!manager.IsVisible(id)}>İşlev hazır</section>;
});
Tool.displayName = 'FixtureTool';
let sequence = 0;
const setup = (loader = vi.fn(async () => ({ Tool })), keepMounted = false) => {
  const id = `lazy-fixture-${++sequence}`;
  const manager = createWindowManager();
  const createComponent = () => createManagedWindowComponent(loader, 'Tool', 100);
  const result = render(<LazyManagedWindow id={id} label="Test aracı" component={createComponent()} createComponent={createComponent} windowManager={manager} keepMounted={keepMounted} />);
  return { ...result, id, manager, loader };
};
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); show.mockClear(); dispose.mockClear();
  for (const window of Store.getState().Common.WindowList) {
    if (window.id.startsWith('lazy-fixture-')) Store.dispatch({ type: CommonReducer_ActionTypes.RemoveWindow, payload: { windowid: window.id } });
  }
});

describe('managed lazy tool lifecycle', () => {
  it('does not load closed tools and activates after the real manager opens it', async () => {
    const { loader, manager, id } = setup();
    expect(loader).not.toHaveBeenCalled();
    act(() => { manager.ShowWindow(id); });
    expect(await screen.findByRole('region', { name: 'Test aracı' })).toBeVisible();
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(manager.IsVisible(id)).toBe(true);
  });
  it('can reopen after a query unregisters its owned ref on close', async () => {
    const { manager, id } = setup();
    act(() => { manager.ShowWindow(id); });
    await screen.findByRole('region', { name: 'Test aracı' });
    act(() => { manager.HideWindow(id); });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(Store.getState().Common.WindowList.find(item => item.id === id)).toMatchObject({ ref: null, lazy: true });
    act(() => { manager.ShowWindow(id); });
    expect(await screen.findByRole('region', { name: 'Test aracı' })).toBeVisible();
  });
  it('retains tool state only after first use and releases it with the host', async () => {
    const { manager, id, unmount } = setup(undefined, true);
    act(() => { manager.ShowWindow(id); });
    await screen.findByRole('region', { name: 'Test aracı' });
    act(() => { manager.HideWindow(id); });
    expect(dispose).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Test aracı' })).toBeNull();
    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(Store.getState().Common.WindowList.some(item => item.id === id)).toBe(false);
  });
  it('contains a failed chunk, retries with a fresh React lazy instance and keeps the page usable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const loader = vi.fn().mockRejectedValueOnce(new Error('chunk failed')).mockResolvedValue({ Tool });
    const { manager, id } = setup(loader);
    act(() => { manager.ShowWindow(id); });
    await screen.findByRole('alert', { name: 'Test aracı açılamadı' });
    fireEvent.click(screen.getByRole('button', { name: 'Yeniden dene' }));
    expect(await screen.findByRole('region', { name: 'Test aracı' })).toBeVisible();
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it('bounds repeated failures and keeps a close action available', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { manager, id, loader } = setup(vi.fn().mockRejectedValue(new Error('offline')));
    act(() => { manager.ShowWindow(id); });
    await screen.findByRole('alert');
    for (let i = 0; i < 2; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Yeniden dene' }));
      await screen.findByRole('alert');
    }
    expect(screen.queryByRole('button', { name: 'Yeniden dene' })).toBeNull();
    expect(loader).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: 'Araç hatasını kapat' }));
    expect(manager.IsVisible(id)).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('allows closing while a chunk is still loading and suppresses late activation', async () => {
    let finish: (value: { Tool: typeof Tool }) => void = () => undefined;
    const loader = vi.fn(() => new Promise<{ Tool: typeof Tool }>(resolve => { finish = resolve; }));
    const { manager, id } = setup(loader);
    act(() => { manager.ShowWindow(id); });
    fireEvent.click(screen.getByRole('button', { name: 'Araç yüklemesini kapat' }));
    await act(async () => { finish({ Tool }); });
    expect(show).not.toHaveBeenCalled();
    expect(manager.IsVisible(id)).toBe(false);
  });
});
