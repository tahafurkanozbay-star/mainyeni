import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import MapManager from '../../../Store/Managers/MapManager';
import Store from '../../../Store/Store';
import { withTimeout } from '../../../platform/runtime/resilience';
import { isAbortLike } from '../../../platform/runtime/contracts';
import { runtimeDiagnostics } from '../../../platform/runtime/runtimeDiagnostics';
import { watchArcgisProperty, type ArcgisAccessorWatch } from '../../../gis-engine/arcgisReactiveRuntime';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import type { WindowManagerLike } from '../../../experience/contracts';
import {
  ExperienceToolbar,
  type ExperienceToolbarItem,
} from '../../Common/ExperienceToolbar';
import { openExternalUrl } from '../_shared/MapWidgetRuntime';
import {
  MAP_TOOLBAR_GROUP_LABELS,
  MapToolbarModel,
  findMapToolbarAction,
  type MapToolbarActionId,
  type MapToolbarPoint,
} from './mapToolbarModel';
import './ToolbarWidget.css';

interface ToolbarWidgetModernProps {
  readonly id?: string;
  readonly accessorWatch?: ArcgisAccessorWatch;
  readonly windowManager: Pick<WindowManagerLike, 'ShowWindow'>;
}

interface RemovableHandle {
  readonly remove?: () => void;
}

interface ExtentLike {
  readonly clone?: () => ExtentLike;
}

interface MapViewLike {
  readonly extent?: ExtentLike;
  readonly ready?: boolean;
  readonly watch?: (propertyName: string, callback: (value: boolean) => void) => RemovableHandle;
  readonly goTo?: (target: unknown) => Promise<unknown> | unknown;
  readonly destroyed?: boolean;
  readonly graphics?: { readonly add?: unknown; readonly remove?: unknown };
  readonly animation?: { readonly stop?: () => void } | null;
}

type HomePhase = 'idle' | 'restoring' | 'success' | 'error' | 'cancelled';
const TOOLBAR_OPERATION_POLICY = Object.freeze({ positionMs: 10_000, navigationMs: 15_000 });
const HOME_MESSAGES: Readonly<Record<HomePhase, string>> = Object.freeze({
  idle: '', restoring: 'Başlangıç görünümüne dönülüyor.',
  success: 'Başlangıç görünümü gösterildi.',
  error: 'Başlangıç görünümü gösterilemedi. Yeniden deneyebilirsiniz.',
  cancelled: 'Görünüm değiştirme durduruldu. Haritayı kullanmaya devam edebilirsiniz.',
});
const reportToolbarFailure = (error: unknown): void => {
  try {
    runtimeDiagnostics.record('map-toolbar.operation.failed', {
      failureKind: error instanceof Error ? error.name : typeof error,
    }, { severity: 'warn' });
  } catch { console.warn('Map toolbar diagnostic reporting failed.'); }
};

/** Stop only the exact animation created synchronously by this operation. */
const awaitOwnedNavigation = async (view: MapViewLike, signal: AbortSignal, start: () => unknown): Promise<void> => {
  signal.throwIfAborted();
  const previous = view.animation;
  const result = start();
  const animation = view.animation;
  const stop = (): void => {
    if (animation && animation !== previous && view.animation === animation && !view.destroyed) {
      try { animation.stop?.(); } catch (error) { reportToolbarFailure(error); }
    }
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) stop();
    signal.throwIfAborted();
    await result;
    signal.throwIfAborted();
  } finally { signal.removeEventListener('abort', stop); }
};

const ToolbarGlyph = ({ name }: { readonly name: MapToolbarActionId }) => {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    focusable: false,
    'aria-hidden': true,
  };

  switch (name) {
    case 'feedback':
      return <svg {...common}><path d="M7 18.5 3.5 21l1-4A8.2 8.2 0 0 1 3 12c0-4.4 4-8 9-8s9 3.6 9 8-4 8-9 8a10.6 10.6 0 0 1-5-.5Z" /><path d="M8 12h.01M12 12h.01M16 12h.01" /></svg>;
    case 'basemap':
      return <svg {...common}><path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" /><path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5" /></svg>;
    case 'address':
      return <svg {...common}><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></svg>;
    case 'location':
      return <svg {...common}><circle cx="12" cy="12" r="5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /></svg>;
    case 'parcel':
      return <svg {...common}><path d="m4 6 5-3 6 3 5-3v15l-5 3-6-3-5 3V6Z" /><path d="M9 3v15M15 6v15" /></svg>;
    case 'measure':
      return <svg {...common}><path d="m5 19 14-14 2 2L7 21l-2-2Z" /><path d="m13 7 4 4M10 10l2 2M7 13l2 2" /></svg>;
    case 'streetview':
      return <svg {...common}><circle cx="12" cy="5" r="2.3" /><path d="M8 21v-5l-2-2 2-5h8l2 5-2 2v5M9 12h6M12 12v9" /></svg>;
    case 'home':
      return <svg {...common}><path d="m3 11 9-8 9 8" /><path d="M5.5 9.5V21h13V9.5M9 21v-7h6v7" /></svg>;
  }
};

const requestCurrentPosition = (): Promise<MapToolbarPoint> => new Promise((resolve, reject) => {
  if (!navigator.geolocation) {
    reject(new Error('Geolocation is unavailable.'));
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => resolve(Object.freeze({
      x: position.coords.longitude,
      y: position.coords.latitude,
    })),
    reject,
    {
      enableHighAccuracy: false,
      timeout: TOOLBAR_OPERATION_POLICY.positionMs,
      maximumAge: 60000,
    },
  );
});

export const ToolbarWidgetModern = ({ id, windowManager, accessorWatch }: ToolbarWidgetModernProps) => {
  const initialExtentRef = useRef<{ view: MapViewLike; extent: ExtentLike } | null>(null);
  const locationOwnerRef = useRef<AbortController | null>(null);
  const homeOwnerRef = useRef<AbortController | null>(null);
  const locationGraphicRef = useRef<{ view: MapViewLike; graphic: unknown } | null>(null);
  const mountedRef = useRef(false);
  const pendingFocusRef = useRef<'location' | 'home' | 'cancel' | null>(null);
  const [homePhase, setHomePhase] = useState<HomePhase>('idle');
  const generatedId = useId();
  const modelRef = useRef<MapToolbarModel | null>(null);
  if (!modelRef.current) modelRef.current = new MapToolbarModel({ onListenerError: reportToolbarFailure });
  const model = modelRef.current;
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const toolbarId = id ?? `map-toolbar-${generatedId.replace(/:/gu, '')}`;
  const helpId = `${toolbarId}-instructions`;
  const mapView = useSyncExternalStore(Store.subscribe, MapManager.GetMapView, () => null) as MapViewLike | null;

  const removeLocationGraphic = (): void => {
    const owned = locationGraphicRef.current;
    locationGraphicRef.current = null;
    if (!owned || owned.view.destroyed) return;
    try { GisGraphicsHelper.RemoveGraphics(owned.view, [owned.graphic]); }
    catch (error) { reportToolbarFailure(error); }
  };
  const cancelLocation = (): void => {
    locationOwnerRef.current?.abort(); locationOwnerRef.current = null;
    model.resetLocation();
  };
  const cancelHome = (): void => {
    homeOwnerRef.current?.abort(); homeOwnerRef.current = null;
    setHomePhase('idle');
  };
  const assertCurrentView = (view: MapViewLike, signal: AbortSignal): void => {
    signal.throwIfAborted();
    if (!mountedRef.current || view.destroyed || MapManager.GetMapView() !== view) {
      throw new DOMException('Map owner changed.', 'AbortError');
    }
  };

  useEffect(() => {
    initialExtentRef.current = null;
    cancelLocation(); cancelHome(); removeLocationGraphic();
    if (!mapView) return undefined;

    const captureInitialExtent = (): void => {
      if (!initialExtentRef.current && mapView.extent) {
        initialExtentRef.current = { view: mapView, extent: mapView.extent.clone?.() ?? mapView.extent };
      }
    };

    captureInitialExtent();
    const readyHandle = watchArcgisProperty(mapView, 'ready', (ready) => {
      if (ready) captureInitialExtent();
    }, accessorWatch);

    return () => {
      readyHandle?.remove?.();
      cancelLocation(); homeOwnerRef.current?.abort(); homeOwnerRef.current = null;
      removeLocationGraphic();
    };
  }, [accessorWatch, mapView, model]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => { if (!mountedRef.current) model.dispose(); });
    };
  }, [model]);

  const showWindow = (windowId: string): void => windowManager.ShowWindow(windowId);

  const createLocation = async (view: MapViewLike, location: MapToolbarPoint, signal: AbortSignal): Promise<void> => {
    assertCurrentView(view, signal);
    const point = await GisGraphicsHelper.CreatePoint({ ...location, spatialReference: { wkid: 4326 } });
    assertCurrentView(view, signal);
    const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(point, null);
    assertCurrentView(view, signal);
    if (!graphic || typeof view.graphics?.add !== 'function' || typeof view.goTo !== 'function') throw new Error('Map location cannot be displayed.');
    removeLocationGraphic();
    const owned = { view, graphic };
    const retire = (): void => { if (locationGraphicRef.current === owned) removeLocationGraphic(); };
    locationGraphicRef.current = owned;
    signal.addEventListener('abort', retire, { once: true });
    try {
      GisGraphicsHelper.AddGraphics(view, graphic);
      await awaitOwnedNavigation(view, signal, () => GisGraphicsHelper.ZoomToGeometry(view, point, 15));
      assertCurrentView(view, signal);
    } catch (error) {
      retire(); throw error;
    } finally { signal.removeEventListener('abort', retire); }
  };

  const locateUser = (): void => {
    if (model.getSnapshot().locationPhase === 'locating') return;
    pendingFocusRef.current = 'cancel';
    cancelHome();
    const owner = new AbortController(); locationOwnerRef.current = owner;
    const view = MapManager.GetMapView() as MapViewLike | null;
    void model.locate({
      requestPosition: () => withTimeout(signal => {
        signal.throwIfAborted();
        return requestCurrentPosition();
      }, TOOLBAR_OPERATION_POLICY.positionMs, owner.signal),
      showLocation: (point) => withTimeout(signal => {
        if (!view) throw new Error('Map view is unavailable.');
        return createLocation(view, point, signal);
      }, TOOLBAR_OPERATION_POLICY.navigationMs, owner.signal),
      showSidebar: () => showWindow('sidebar'),
      onError: reportToolbarFailure,
    }).finally(() => { if (locationOwnerRef.current === owner) locationOwnerRef.current = null; });
  };

  const gotoInitialView = (): void => {
    if (homeOwnerRef.current) return;
    pendingFocusRef.current = 'cancel';
    cancelLocation(); removeLocationGraphic();
    const owner = new AbortController(); homeOwnerRef.current = owner;
    setHomePhase('restoring');
    const view = MapManager.GetMapView() as MapViewLike | null;
    const initialExtent = initialExtentRef.current;
    try { showWindow('sidebar'); } catch (error) { reportToolbarFailure(error); }
    void withTimeout(async signal => {
      if (!view || initialExtent?.view !== view || typeof view.goTo !== 'function') throw new Error('Initial map view is unavailable.');
      assertCurrentView(view, signal);
      await awaitOwnedNavigation(view, signal, () => view.goTo?.(initialExtent.extent));
      assertCurrentView(view, signal);
    }, TOOLBAR_OPERATION_POLICY.navigationMs, owner.signal).then(() => {
      if (mountedRef.current && homeOwnerRef.current === owner) setHomePhase('success');
    }).catch((error: unknown) => {
      if (owner.signal.aborted || !mountedRef.current || homeOwnerRef.current !== owner) return;
      if (isAbortLike(error)) { setHomePhase('cancelled'); return; }
      reportToolbarFailure(error); setHomePhase('error');
    }).finally(() => { if (homeOwnerRef.current === owner) homeOwnerRef.current = null; });
  };

  const activateToolbarAction = (actionId: MapToolbarActionId): void => {
    const action = findMapToolbarAction(actionId);
    if (!action) return;

    switch (action.kind) {
      case 'external':
        if (action.target) openExternalUrl(action.target);
        return;
      case 'window':
        if (action.target) showWindow(action.target);
        return;
      case 'location':
        locateUser();
        return;
      case 'home':
        gotoInitialView();
        return;
    }
  };

  const toolbarItems: readonly ExperienceToolbarItem[] = snapshot.actions.map((action, index) => {
    const isGroupStart = index === 0 || snapshot.actions[index - 1]?.group !== action.group;
    return {
      id: action.id,
      label: action.label,
      icon: <ToolbarGlyph name={action.id} />,
      busy: action.busy || (action.id === 'home' && homePhase === 'restoring'),
      disabled: action.disabled || (action.id === 'home' && homePhase === 'restoring'),
      tooltip: action.tooltip,
      group: action.group,
      ...(isGroupStart ? { groupLabel: MAP_TOOLBAR_GROUP_LABELS[action.group] } : {}),
      onActivate: () => activateToolbarAction(action.id),
    };
  });
  const announcement = homePhase === 'idle' ? snapshot.announcement : HOME_MESSAGES[homePhase];
  const busy = snapshot.locationPhase === 'locating' || homePhase === 'restoring';
  const failure = snapshot.locationPhase === 'error' || homePhase === 'error';
  const fallback = homePhase === 'idle' && snapshot.locationPhase === 'fallback';
  const dismissNotice = (): void => {
    pendingFocusRef.current = homePhase === 'idle' ? 'location' : 'home';
    cancelLocation(); cancelHome();
  };
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    const root = document.getElementById(toolbarId);
    const target = pending === 'cancel'
      ? document.getElementById(`${toolbarId}-notice`)?.querySelector<HTMLButtonElement>('[data-notice-action="cancel"]')
      : root?.querySelector<HTMLButtonElement>(`[data-roving-focus-id="${pending}"]`);
    target?.focus();
  }, [announcement, busy, toolbarId]);

  return (
    <>
      <p id={helpId} className="toolbarwidget-instructions">
        Harita araçları arasında yukarı ve aşağı ok tuşlarıyla ilerleyin. İlk veya son araca gitmek için Home ve End tuşlarını kullanın.
      </p>
      <ExperienceToolbar
        id={toolbarId}
        className="toolbarwidget toolbarwidget--modern"
        label="Harita araçları"
        describedBy={helpId}
        orientation="vertical"
        tooltipPlacement="left"
        items={toolbarItems}
      />
      <div id={`${toolbarId}-notice`} className="toolbarwidget-notice" data-visible={Boolean(announcement)} data-tone={failure ? 'danger' : fallback ? 'warning' : 'info'}>
        <p className={announcement ? 'toolbarwidget-notice__message' : 'toolbarwidget-status'} role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
        {announcement ? <>
          {busy ? <p className="toolbarwidget-notice__detail">{homePhase === 'restoring' ? 'Harita hazırlanıyor. İşlemi iptal edebilirsiniz.' : 'Tarayıcınız sorarsa konum iznini seçin. Bu işlem biraz zaman alabilir.'}</p> : null}
          {fallback ? <p className="toolbarwidget-notice__detail">Bu nokta cihazınızın konumu değildir. Konum izninizi kontrol edip yeniden deneyebilirsiniz.</p> : null}
          <div className="toolbarwidget-notice__actions">
            {busy ? <button type="button" data-notice-action="cancel" onClick={() => { dismissNotice(); removeLocationGraphic(); }}>İptal et</button> : <>
              {failure || fallback ? <button type="button" onClick={homePhase === 'error' ? gotoInitialView : locateUser}>Yeniden dene</button> : null}
              <button type="button" onClick={dismissNotice}>Mesajı kapat</button>
            </>}
          </div>
        </> : null}
      </div>
    </>
  );
};
