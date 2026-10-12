import {
  Component, Suspense, useEffect, useRef, useState, useSyncExternalStore,
  type ErrorInfo, type ReactNode,
} from 'react';
import type { ManagedWindowHandle, WindowManagerApi } from '../../Store/Managers/WindowManager';
import Store from '../../Store/Store';
import { DebugHelper } from '../../Toolbox/DebugHelper';
import type { ManagedComponent } from './managedWindowLoading';
import './LazyManagedWindow.css';

interface LazyManagedWindowProps {
  readonly id: string;
  readonly label?: string;
  readonly component: ManagedComponent;
  readonly createComponent?: () => ManagedComponent;
  readonly windowManager: WindowManagerApi;
  readonly componentProps?: Readonly<Record<string, unknown>>;
  readonly keepMounted?: boolean;
}
interface WindowBoundaryProps { readonly children: ReactNode; readonly fallback: ReactNode; }
class WindowBoundary extends Component<WindowBoundaryProps, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  override componentDidCatch(error: Error, _info: ErrorInfo): void { DebugHelper.Log(error); }
  override render(): ReactNode { return this.state.failed ? this.props.fallback : this.props.children; }
}
const WindowLoadingFallback = ({ label, onClose }: { readonly label: string; readonly onClose: () => void }): ReactNode => (
  <section className="kr-lazy-window" role="status" aria-live="polite" aria-busy="true">
    <span className="kr-lazy-window__spinner" aria-hidden="true" />
    <div><strong>{label}</strong><span>Araç hazırlanıyor…</span></div>
    <button className="kr-lazy-window__close" type="button" aria-label="Araç yüklemesini kapat" onClick={onClose}>×</button>
  </section>
);

export function LazyManagedWindow({
  id, label = 'Araç', component, createComponent, windowManager,
  componentProps = {}, keepMounted = false,
}: LazyManagedWindowProps): ReactNode {
  const componentRef = useRef<ManagedWindowHandle | null>(null);
  const openedRef = useRef(false);
  const [attempt, setAttempt] = useState(1);
  const [loadedComponent, setLoadedComponent] = useState(() => component);
  const visible = useSyncExternalStore(Store.subscribe, () => windowManager.IsVisible(id), () => false);
  if (visible) openedRef.current = true;
  useEffect(() => {
    windowManager.RegisterPlaceholder(id);
    return () => { windowManager.UnregisterWindow(id); };
  }, [id, windowManager]);
  if (!visible && !(keepMounted && openedRef.current)) return null;
  const LoadedComponent = loadedComponent;
  const onClose = (): void => { windowManager.HideWindow(id); };
  const retry = (): void => {
    if (!createComponent || attempt >= 3) return;
    setLoadedComponent(() => createComponent());
    setAttempt((value) => value + 1);
  };
  const fallback = visible ? (
    <section className="kr-lazy-window kr-lazy-window--error" role="alert" aria-label={`${label} açılamadı`}>
      <div>
        <strong>{label} açılamadı</strong>
        <span>{attempt < 3 ? 'Bağlantınızı kontrol edip yeniden deneyin.' : 'Deneme sınırına ulaşıldı. Sayfayı yenileyebilirsiniz.'}</span>
        {createComponent && attempt < 3 ? <button type="button" className="kr-lazy-window__retry" onClick={retry}>Yeniden dene</button> : null}
      </div>
      <button className="kr-lazy-window__close" type="button" aria-label="Araç hatasını kapat" onClick={onClose}>×</button>
    </section>
  ) : null;
  return (
    <WindowBoundary key={attempt} fallback={fallback}>
      <Suspense fallback={visible ? <WindowLoadingFallback label={label} onClose={onClose} /> : null}>
        <LoadedComponent id={id} ref={componentRef} windowManager={windowManager} {...componentProps} />
      </Suspense>
    </WindowBoundary>
  );
}
export default LazyManagedWindow;
