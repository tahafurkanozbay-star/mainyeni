import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWindowManager } from '../../Store/Managers/WindowManager';
import { installManagedWindowKeyboard } from './managedWindowKeyboard';
vi.mock('../../Business/LoggingBusiness', () => ({ LoggingBusiness: { CreateClientLog: vi.fn(async () => undefined) } }));
const cleanups: Array<() => void> = [];
let sequence = 0;
const setup = () => {
  const manager = createWindowManager(); const id = `keyboard-fixture-${++sequence}`;
  manager.RegisterPlaceholder(id); manager.ShowWindow(id);
  cleanups.push(installManagedWindowKeyboard(manager), () => { manager.UnregisterWindow(id); manager.Dispose(); });
  return { manager, id };
};
const escape = (target: EventTarget = window, init: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }));
afterEach(() => { cleanups.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });
describe('shared modeless window keyboard ownership', () => {
  it('closes the active modeless window through its real manager', () => { const { manager, id } = setup(); escape(); expect(manager.IsVisible(id)).toBe(false); });
  it('preserves windows behind a modal or command palette', () => {
    const { manager, id } = setup(); document.body.innerHTML = '<section role="dialog" aria-modal="true"></section>';
    escape(); expect(manager.IsVisible(id)).toBe(true);
  });
  it.each(['.esri-view-surface', '.esri-sketch'])('leaves %s Escape to the SDK', (selector) => {
    const { manager, id } = setup(); const target = document.createElement('div'); target.className = selector.slice(1); document.body.append(target);
    escape(target); expect(manager.IsVisible(id)).toBe(true);
  });
  it('leaves an expanded combobox Escape to its own popup', () => {
    const { manager, id } = setup(); document.body.innerHTML = '<input role="combobox" aria-expanded="true">';
    escape(document.querySelector('input')!); expect(manager.IsVisible(id)).toBe(true);
  });
  it('does not consume composition, repeated or modified Escape', () => {
    const { manager, id } = setup(); for (const option of [{ isComposing: true }, { repeat: true }, { ctrlKey: true }]) escape(window, option);
    expect(manager.IsVisible(id)).toBe(true);
  });
  it('restores focus from a closing tool to the map', async () => {
    const { manager, id } = setup(); document.body.innerHTML = '<div id="esri-map-container" tabindex="-1"></div><section class="common-query-window"><button>İşlem</button></section>';
    const target = document.querySelector('button')!; target.focus(); escape(target); await Promise.resolve();
    expect(manager.IsVisible(id)).toBe(false); expect(document.getElementById('esri-map-container')).toHaveFocus();
  });
  it('removes the listener when the owning app disconnects', () => {
    const { manager, id } = setup(); cleanups[0]?.(); escape(); expect(manager.IsVisible(id)).toBe(true);
  });
  it('restores map focus even when closing immediately removes the focused service window', async () => {
    const { manager } = setup();
    cleanups[0]?.();
    document.body.innerHTML = '<div id="esri-map-container" tabindex="-1"></div><section class="kr-fast-query"><button>Sonuç</button></section>';
    const target = document.querySelector('button')!;
    target.focus();
    cleanups.push(installManagedWindowKeyboard({ HideWindow: (id) => { document.querySelector('section')!.remove(); return manager.HideWindow(id); } }));
    escape(target); await Promise.resolve();
    expect(document.getElementById('esri-map-container')).toHaveFocus();
  });
  it('keeps focus deliberately restored by the closing window', async () => {
    const { manager } = setup();
    cleanups[0]?.();
    document.body.innerHTML = '<div id="esri-map-container" tabindex="-1"></div><button id="opener">Hizmetler</button><section class="kr-fast-query"><button>Sonuç</button></section>';
    const target = document.querySelector('section button') as HTMLButtonElement;
    target.focus();
    cleanups.push(installManagedWindowKeyboard({ HideWindow: (id) => { document.getElementById('opener')!.focus(); return manager.HideWindow(id); } }));
    escape(target); await Promise.resolve();
    expect(document.getElementById('opener')).toHaveFocus();
  });
});
