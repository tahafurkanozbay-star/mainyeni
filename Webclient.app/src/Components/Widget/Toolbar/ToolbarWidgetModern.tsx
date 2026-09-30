import {
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
} from 'react';
import MapManager from '../../../Store/Managers/MapManager';
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
}

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
      timeout: 10000,
      maximumAge: 60000,
    },
  );
});

export const ToolbarWidgetModern = ({ id, windowManager }: ToolbarWidgetModernProps) => {
  const initialExtentRef = useRef<ExtentLike | null>(null);
  const generatedId = useId();
  const modelRef = useRef<MapToolbarModel | null>(null);
  if (!modelRef.current) modelRef.current = new MapToolbarModel();
  const model = modelRef.current;
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const toolbarId = id ?? `map-toolbar-${generatedId.replace(/:/gu, '')}`;
  const helpId = `${toolbarId}-instructions`;

  useEffect(() => {
    const mapView = MapManager.GetMapView() as MapViewLike | null;
    if (!mapView) return undefined;

    const captureInitialExtent = (): void => {
      if (!initialExtentRef.current && mapView.extent) {
        initialExtentRef.current = mapView.extent.clone?.() ?? mapView.extent;
      }
    };

    captureInitialExtent();
    const readyHandle = mapView.watch?.('ready', (ready) => {
      if (ready) captureInitialExtent();
    });

    return () => readyHandle?.remove?.();
  }, []);

  useEffect(() => () => model.dispose(), [model]);

  const showWindow = (windowId: string): void => windowManager.ShowWindow(windowId);

  const createLocation = async (location: MapToolbarPoint): Promise<void> => {
    const point = await GisGraphicsHelper.CreatePoint(location);
    const mapView = MapManager.GetMapView();
    if (!mapView) throw new Error('Map view is unavailable.');

    const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(point, null);
    MapManager.AddGraphics(graphic, true);
    GisGraphicsHelper.ZoomToGeometry(mapView, point, 15);
  };

  const locateUser = (): void => {
    void model.locate({
      requestPosition: requestCurrentPosition,
      showLocation: createLocation,
      showSidebar: () => showWindow('sidebar'),
    });
  };

  const gotoInitialView = (): void => {
    const mapView = MapManager.GetMapView() as MapViewLike | null;
    const initialExtent = initialExtentRef.current;
    if (mapView && initialExtent) {
      void Promise.resolve(mapView.goTo?.(initialExtent)).catch(() => undefined);
    }
    showWindow('sidebar');
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
      busy: action.busy,
      disabled: action.disabled,
      tooltip: action.tooltip,
      group: action.group,
      ...(isGroupStart ? { groupLabel: MAP_TOOLBAR_GROUP_LABELS[action.group] } : {}),
      onActivate: () => activateToolbarAction(action.id),
    };
  });

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
        items={toolbarItems}
      />
      <span
        className="toolbarwidget-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {snapshot.announcement}
      </span>
    </>
  );
};
