import Store from '../../Store/Store';
import type { WindowManagerApi } from '../../Store/Managers/WindowManager';

/** Escape belongs to an open modal or SDK interaction before a modeless tool. */
export const installManagedWindowKeyboard = (
  manager: Pick<WindowManagerApi, 'HideWindow'>,
  documentPort: Document = document,
  eventPort: Window = window,
): (() => void) => {
  const handle = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (documentPort.querySelector('[aria-modal="true"]')) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.esri-view-surface, .esri-sketch, [role="combobox"][aria-expanded="true"]')) return;
    const active = Store.getState().Common.WindowList.find((item) => item.visible && item.id !== 'sidebar');
    if (!active || !manager.HideWindow(active.id)) return;
    event.preventDefault();
    const focus = documentPort.activeElement;
    if (focus instanceof HTMLElement && focus.closest('.common-query-window, .kr-lazy-window')) {
      queueMicrotask(() => {
        const map = documentPort.getElementById('esri-map-container');
        if (!map || documentPort.querySelector('[aria-modal="true"]')) return;
        map.focus({ preventScroll: true });
      });
    }
  };
  eventPort.addEventListener('keydown', handle);
  return () => eventPort.removeEventListener('keydown', handle);
};
