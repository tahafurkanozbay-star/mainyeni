import { useEffect } from 'react';
import { createManagedWindowFocusLifecycle } from '../../Query/_Common/ManagedWindowFocus';

/** Map tools stay modeless and share the managed window's opener/return policy. */
export const useMapWidgetFocus = (id: string, visible: boolean): void => {
  useEffect(() => {
    if (!visible) return;
    const lifecycle = createManagedWindowFocusLifecycle();
    lifecycle.open({
      root: document.getElementById(`${id}-surface`),
      initialFocusSelector: '.map-widget-surface__body input:not([disabled]), .map-widget-surface__body button:not([disabled]), .common-query-window-tool-button',
      restorePolicy: 'if-focus-within',
    });
    return () => { lifecycle.close(); lifecycle.dispose(); };
  }, [id, visible]);
};
