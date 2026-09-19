import {
  Suspense,
  useEffect,
  useRef,
  type ForwardRefExoticComponent,
  type ReactNode,
  type RefAttributes,
} from 'react';
import type {
  ManagedWindowHandle,
  WindowManagerApi,
} from '../../Store/Managers/WindowManager';
import './LazyManagedWindow.css';

interface WindowLoadingFallbackProps {
  readonly label: string | undefined;
}

type LazyManagedComponentProps = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly windowManager: WindowManagerApi;
};

type LazyManagedComponent = ForwardRefExoticComponent<
  LazyManagedComponentProps & RefAttributes<ManagedWindowHandle>
>;

interface LazyManagedWindowProps {
  readonly id: string;
  readonly label?: string;
  readonly component: LazyManagedComponent;
  readonly windowManager: WindowManagerApi;
  readonly componentProps?: Readonly<Record<string, unknown>>;
}

const WindowLoadingFallback = ({
  label,
}: WindowLoadingFallbackProps): ReactNode => (
  <section
    className="kr-lazy-window"
    role="status"
    aria-live="polite"
    aria-busy="true"
  >
    <span className="kr-lazy-window__spinner" aria-hidden="true" />
    <div>
      <strong>{label || 'Araç yükleniyor'}</strong>
      <span>Gerekli arayüz kodu hazırlanıyor…</span>
    </div>
  </section>
);

export function LazyManagedWindow({
  id,
  label,
  component: Component,
  windowManager,
  componentProps = {},
}: LazyManagedWindowProps): ReactNode {
  const componentRef = useRef<ManagedWindowHandle | null>(null);

  useEffect(() => {
    windowManager.RegisterPlaceholder(id);
    return () => {
      windowManager.UnregisterWindow(id, componentRef);
    };
  }, [id, windowManager]);

  if (!windowManager.IsVisible(id)) return null;

  return (
    <Suspense fallback={<WindowLoadingFallback label={label} />}>
      <Component
        id={id}
        ref={componentRef}
        windowManager={windowManager}
        {...componentProps}
      />
    </Suspense>
  );
}

export default LazyManagedWindow;
