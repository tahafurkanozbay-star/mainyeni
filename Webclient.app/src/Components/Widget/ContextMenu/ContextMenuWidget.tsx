import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { RiFocusLine, RiGoogleFill, RiInformationLine, RiRouteLine } from 'react-icons/ri';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import { GoogleMapsBusiness } from '../../../Business/GoogleMapsBusiness';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import type { MapWidgetManagerLike } from '../_shared/MapWidgetSurface';
import {
  clampContextMenuPosition,
  nextRovingIndex,
  normalizeMapPoint,
  openExternalUrl,
  type ContextMenuPosition,
} from '../_shared/MapWidgetRuntime';
import './ContextMenuWidget.css';

interface MapClickEventLike {
  readonly x?: unknown;
  readonly y?: unknown;
  readonly mapPoint?: unknown;
}

interface ContextAction {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly run: () => void;
}

export interface ContextMenuWidgetProps {
  readonly id: string;
  readonly windowManager: MapWidgetManagerLike;
}

const finiteCoordinate = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : 0
);

export const ContextMenuWidget = forwardRef<ManagedWindowHandle, ContextMenuWidgetProps>(
  ({ id, windowManager }, ref): ReactNode => {
    const menuRef = useRef<HTMLDivElement | null>(null);
    const [requestedPosition, setRequestedPosition] = useState<ContextMenuPosition>({ x: 0, y: 0 });
    const [position, setPosition] = useState<ContextMenuPosition>({ x: 8, y: 8 });
    const [activeIndex, setActiveIndex] = useState(0);

    const close = useCallback((): void => {
      windowManager.HideWindow(id);
    }, [id, windowManager]);

    const getClickedPoint = useCallback((): unknown | null => (
      (MapManager.GetMapClickEvent() as unknown as MapClickEventLike | null)?.mapPoint ?? null
    ), []);

    const logPointAction = useCallback((label: string, point: unknown): void => {
      const normalized = normalizeMapPoint(point as never);
      if (!normalized) return;
      LoggingBusiness.CreateClientLog(
        label,
        `${normalized.latitude}/${normalized.longitude}`,
      );
    }, []);

    const showVicinityQuery = useCallback((): void => {
      const point = getClickedPoint();
      if (!point) return;
      windowManager.ShowWindow('vicinity-query-window');
      close();
      GisGraphicsHelper.ZoomToGeometry(MapManager.GetMapView(), point, 14);
      logPointAction('Sağ Tık/Yakınımda ara', point);
    }, [close, getClickedPoint, logPointAction, windowManager]);

    const showIdentify = useCallback((): void => {
      const point = getClickedPoint();
      if (!point) return;
      windowManager.ShowWindow('global-identify-widget');
      close();
      logPointAction('Sağ Tık/Bilgi al', point);
    }, [close, getClickedPoint, logPointAction, windowManager]);

    const showRoute = useCallback((): void => {
      const point = getClickedPoint();
      const normalized = normalizeMapPoint(point as never);
      if (!point || !normalized) return;
      close();
      logPointAction('Sağ Tık/Yol Tarifi', point);
      const target = new URL('https://www.google.com.tr/maps');
      target.searchParams.set('saddr', 'My Location');
      target.searchParams.set('daddr', `${normalized.latitude},${normalized.longitude}`);
      openExternalUrl(target.toString());
    }, [close, getClickedPoint, logPointAction]);

    const showStreetView = useCallback((): void => {
      const point = getClickedPoint();
      if (!point) return;
      if (openExternalUrl(GoogleMapsBusiness.CreateStreetViewUrlFromPoint(point))) {
        logPointAction('Sağ Tık/Sokak Görünümü', point);
      }
      close();
    }, [close, getClickedPoint, logPointAction]);

    const actions: readonly ContextAction[] = [
      {
        id: 'identify',
        label: 'Bilgi Al',
        icon: <RiInformationLine aria-hidden="true" />,
        run: showIdentify,
      },
      {
        id: 'nearby',
        label: 'Yakınımda Ara',
        icon: <RiFocusLine aria-hidden="true" />,
        run: showVicinityQuery,
      },
      {
        id: 'route',
        label: 'Yol Tarifi Al',
        icon: <RiRouteLine aria-hidden="true" />,
        run: showRoute,
      },
      {
        id: 'street-view',
        label: 'Sokak Görünümü',
        icon: <RiGoogleFill aria-hidden="true" />,
        run: showStreetView,
      },
    ];

    const positionMenu = useCallback((): void => {
      const menu = menuRef.current;
      const next = clampContextMenuPosition(
        requestedPosition,
        {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        {
          width: menu?.offsetWidth ?? 224,
          height: menu?.offsetHeight ?? 200,
        },
        8,
      );
      setPosition(next);
    }, [requestedPosition]);

    useImperativeHandle(ref, () => ({
      id,
      visible: false,
      minimized: false,
      OnShow: () => {
        const clickEvent = MapManager.GetMapClickEvent() as unknown as MapClickEventLike | null;
        if (!clickEvent) return;
        setRequestedPosition({
          x: finiteCoordinate(clickEvent.x),
          y: finiteCoordinate(clickEvent.y),
        });
        setActiveIndex(0);
        queueMicrotask(() => {
          positionMenu();
          menuRef.current
            ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
            ?.focus({ preventScroll: true });
        });
      },
      OnClose: () => setActiveIndex(0),
    }), [id, positionMenu]);

    useEffect(() => {
      windowManager.RegisterWindow(ref as RefObject<ManagedWindowHandle | null>);
      return () => windowManager.UnregisterWindow?.(id, ref as RefObject<ManagedWindowHandle | null>);
    }, [id, ref, windowManager]);

    useEffect(() => {
      positionMenu();
      const handleResize = (): void => positionMenu();
      window.addEventListener('resize', handleResize, { passive: true });
      return () => window.removeEventListener('resize', handleResize);
    }, [positionMenu]);

    const focusIndex = useCallback((index: number): void => {
      const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
      const target = buttons?.item(index);
      if (!target) return;
      setActiveIndex(index);
      target.focus({ preventScroll: true });
    }, []);

    const onMenuKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      const next = nextRovingIndex(
        { activeIndex, itemCount: actions.length },
        event.key,
      );
      if (next === activeIndex) return;
      event.preventDefault();
      focusIndex(next);
    }, [actions.length, activeIndex, close, focusIndex]);

    const visible = windowManager.IsVisible(id);

    return (
      <div
        ref={menuRef}
        className="context-menu-container context-menu-container--modern"
        role="menu"
        aria-label="Harita işlemleri"
        aria-hidden={!visible}
        onKeyDown={onMenuKeyDown}
        style={{
          position: 'absolute',
          top: position.y,
          left: position.x,
          zIndex: 999,
          visibility: visible ? 'visible' : 'hidden',
        }}
      >
        <div className="context-menu-heading" aria-hidden="true">
          Harita işlemleri
        </div>
        {actions.map((action, index) => (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            className="context-menu-item"
            tabIndex={index === activeIndex ? 0 : -1}
            onFocus={() => setActiveIndex(index)}
            onClick={action.run}
          >
            <span className="context-menu-item-icon" aria-hidden="true">{action.icon}</span>
            <span className="context-menu-item-text">{action.label}</span>
          </button>
        ))}
      </div>
    );
  },
);

ContextMenuWidget.displayName = 'ContextMenuWidget';
