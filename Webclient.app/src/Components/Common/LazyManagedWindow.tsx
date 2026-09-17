import { Suspense, useEffect, useId, useMemo, useRef, type ElementType, type ReactNode } from 'react';
import './LazyManagedWindow.css';

export interface ManagedWindowHandle {
  readonly id?: string;
  visible?: boolean;
  minimized?: boolean;
  OnShow?: () => void;
  OnClose?: () => void;
}

export interface ManagedWindowManagerLike {
  RegisterPlaceholder?: (id: string) => void;
  UnregisterWindow?: (id: string, ref: { readonly current: ManagedWindowHandle | null }) => void;
  IsVisible?: (id: string) => boolean;
}

export interface LazyManagedWindowProps {
  readonly id: string;
  readonly label?: string;
  readonly component: ElementType;
  readonly windowManager?: ManagedWindowManagerLike | null;
  readonly componentProps?: Readonly<Record<string, unknown>>;
}

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
  const visible = windowManager?.IsVisible?.(id) ?? false;
  const stableProps = useMemo(() => ({ ...(componentProps ?? {}) }), [componentProps]);

  useEffect(() => {
    windowManager?.RegisterPlaceholder?.(id);
    return () => windowManager?.UnregisterWindow?.(id, componentRef);
  }, [id, windowManager]);

  if (!visible) return null;

  return (
    <Suspense fallback={<WindowLoadingFallback label={label} />}>
      <Component {...stableProps} id={id} ref={componentRef} windowManager={windowManager} />
    </Suspense>
  );
}

export default LazyManagedWindow;
