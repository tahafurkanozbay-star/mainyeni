import React, { Suspense, useEffect, useRef, type ComponentType, type ReactNode, type Ref } from 'react';
import './LazyManagedWindow.css';

interface ManagedWindowApi {
  RegisterPlaceholder?: (id: string) => void;
  UnregisterWindow?: (id: string, ref: React.RefObject<unknown>) => void;
  IsVisible?: (id: string) => boolean;
}

interface ManagedWindowComponentProps {
  readonly id: string;
  readonly windowManager: ManagedWindowApi;
  readonly ref?: Ref<unknown>;
  readonly [key: string]: unknown;
}

export interface LazyManagedWindowProps {
  readonly id: string;
  readonly label?: string;
  readonly component: ComponentType<ManagedWindowComponentProps>;
  readonly windowManager: ManagedWindowApi;
  readonly componentProps?: Readonly<Record<string, unknown>>;
}

const FOCUSABLE_SELECTOR = [
  '[autofocus]',
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const focusSafely = (element: HTMLElement | null): void => {
  if (!element?.isConnected) return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
};

const WindowLoadingFallback = ({ label }: { readonly label?: string }): ReactNode => (
  <section className="kr-lazy-window" role="status" aria-live="polite" aria-busy="true">
    <span className="kr-lazy-window__spinner" aria-hidden="true" />
    <div>
      <strong>{label || 'Araç yükleniyor'}</strong>
      <span>Gerekli arayüz kodu hazırlanıyor…</span>
    </div>
  </section>
);

export function LazyManagedWindow({ id, label, component: Component, windowManager, componentProps }: LazyManagedWindowProps): ReactNode {
  const componentRef = useRef<unknown>(null);
  const boundaryRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const visible = Boolean(windowManager?.IsVisible?.(id));

  useEffect(() => {
    windowManager?.RegisterPlaceholder?.(id);
    return () => windowManager?.UnregisterWindow?.(id, componentRef);
  }, [id, windowManager]);

  useEffect(() => {
    if (!visible) return undefined;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const boundary = boundaryRef.current;
      const target = boundary?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? boundary;
      focusSafely(target ?? null);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      const opener = openerRef.current;
      openerRef.current = null;
      window.requestAnimationFrame(() => focusSafely(opener));
    };
  }, [visible]);

  if (!visible) return null;

  // Invariants are applied after caller props so a consumer cannot replace the
  // managed id/ref/window manager and silently escape lifecycle ownership.
  const safeProps: ManagedWindowComponentProps = {
    ...(componentProps ?? {}),
    id,
    ref: componentRef,
    windowManager,
  };

  return (
    <div ref={boundaryRef} className="kr-managed-window-boundary" tabIndex={-1} data-managed-window-id={id}>
      <Suspense fallback={<WindowLoadingFallback label={label} />}>
        <Component {...safeProps} />
      </Suspense>
    </div>
  );
}

export default LazyManagedWindow;
