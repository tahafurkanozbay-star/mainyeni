import { Suspense, useEffect, useId, useMemo, useRef, type ElementType, type ReactNode } from 'react';
import type { ManagedWindowHandle, WindowManagerApi } from '../../Store/Managers/WindowManager';
import './LazyManagedWindow.css';

type LazyWindowManager = Pick<WindowManagerApi, 'RegisterPlaceholder' | 'UnregisterWindow' | 'IsVisible'>;

export interface LazyManagedWindowProps {
  readonly id: string;
  readonly label?: string;
  readonly component: ElementType;
  readonly windowManager?: LazyWindowManager | null;
  readonly componentProps?: Readonly<Record<string, unknown>>;
}

const EMPTY_COMPONENT_PROPS: Readonly<Record<string, unknown>> = Object.freeze({});
const FOCUS_TARGET_SELECTOR = [
  '[data-window-autofocus]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const scheduleFocus = (callback: () => void): (() => void) => {
  if (typeof requestAnimationFrame === 'function') {
    const frame = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(frame);
  }
  let active = true;
  queueMicrotask(() => { if (active) callback(); });
  return () => { active = false; };
};

const canRestoreFocus = (element: HTMLElement | null): element is HTMLElement =>
  Boolean(element?.isConnected && !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true');

export function WindowLoadingFallback({ label = 'Araç yükleniyor' }: { readonly label?: string }): ReactNode {
  const statusId = useId();
  return (
    <section className="kr-lazy-window" role="status" aria-live="polite" aria-busy="true" aria-labelledby={statusId}>
      <span className="kr-lazy-window__spinner" aria-hidden="true" />
      <div>
        <strong id={statusId}>{label}</strong>
        <span>Gerekli arayüz kodu hazırlanıyor…</span>
      </div>
    </section>
  );
}

export function LazyManagedWindow({ id, label, component: Component, windowManager, componentProps }: LazyManagedWindowProps): ReactNode {
  const componentRef = useRef<ManagedWindowHandle | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasVisibleRef = useRef(false);
  const visible = windowManager?.IsVisible(id) ?? false;
  const stableProps = useMemo(() => componentProps ?? EMPTY_COMPONENT_PROPS, [componentProps]);

  useEffect(() => {
    windowManager?.RegisterPlaceholder(id);
    return () => windowManager?.UnregisterWindow(id, componentRef);
  }, [id, windowManager]);

  useEffect(() => {
    let cancelScheduledFocus = (): void => undefined;
    const wasVisible = wasVisibleRef.current;

    if (visible && !wasVisible) {
      const activeElement = document.activeElement;
      restoreFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;
      cancelScheduledFocus = scheduleFocus(() => {
        const host = hostRef.current;
        if (!host || !windowManager?.IsVisible(id)) return;
        const preferred = host.querySelector<HTMLElement>(FOCUS_TARGET_SELECTOR);
        preferred?.focus({ preventScroll: true });
      });
    } else if (!visible && wasVisible) {
      const restoreTarget = restoreFocusRef.current;
      restoreFocusRef.current = null;
      cancelScheduledFocus = scheduleFocus(() => {
        if (!canRestoreFocus(restoreTarget)) return;
        const active = document.activeElement;
        if (active === document.body || active === document.documentElement || !active) restoreTarget.focus({ preventScroll: true });
      });
    }

    wasVisibleRef.current = visible;
    return cancelScheduledFocus;
  }, [id, visible, windowManager]);

  useEffect(() => () => {
    const restoreTarget = restoreFocusRef.current;
    if (wasVisibleRef.current && canRestoreFocus(restoreTarget)) restoreTarget.focus({ preventScroll: true });
  }, []);

  if (!visible) return null;

  return (
    <div ref={hostRef} className="kr-managed-window-host" data-managed-window-id={id}>
      <Suspense fallback={<WindowLoadingFallback label={label} />}>
        <Component {...stableProps} id={id} ref={componentRef} windowManager={windowManager} />
      </Suspense>
    </div>
  );
}

export default LazyManagedWindow;
