import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { RiFocusLine, RiGoogleFill, RiInformationLine, RiRouteLine } from 'react-icons/ri';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { GoogleMapsBusiness } from '../../../Business/GoogleMapsBusiness';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import {
  ExperienceMenu,
  type ExperienceMenuDismissReason,
  type ExperienceMenuItem,
} from '../../Common/ExperienceMenu';
import type { MapWidgetManagerLike } from '../_shared/MapWidgetSurface';
import {
  clampContextMenuPosition,
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

export interface ContextMenuWidgetProps {
  readonly id: string;
  readonly windowManager: MapWidgetManagerLike;
}

const finiteCoordinate = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : 0
);

const isRestorableFocusTarget = (value: Element | null): value is HTMLElement => (
  value instanceof HTMLElement
  && value !== document.body
  && value.isConnected
  && !value.hasAttribute('disabled')
  && value.getAttribute('aria-hidden') !== 'true'
);

export const ContextMenuWidget = forwardRef<ManagedWindowHandle, ContextMenuWidgetProps>(
  ({ id, windowManager }, ref): ReactNode => {
    const focusOriginRef = useRef<HTMLElement | null>(null);
    const [requestedPosition, setRequestedPosition] = useState<ContextMenuPosition>({ x: 0, y: 0 });
    const [position, setPosition] = useState<ContextMenuPosition>({ x: 8, y: 8 });
    const [focusRequestKey, setFocusRequestKey] = useState(0);

    const restoreFocus = useCallback((): void => {
      const origin = focusOriginRef.current;
      focusOriginRef.current = null;
      if (!isRestorableFocusTarget(origin)) return;
      queueMicrotask(() => {
        if (isRestorableFocusTarget(origin)) origin.focus({ preventScroll: true });
      });
    }, []);

    const close = useCallback((restore = true): void => {
      windowManager.HideWindow(id);
      if (restore) restoreFocus();
      else focusOriginRef.current = null;
    }, [id, restoreFocus, windowManager]);

    const getClickedPoint = useCallback((): unknown | null => (
      (MapManager.GetMapClickEvent() as unknown as MapClickEventLike | null)?.mapPoint ?? null
    ), []);

    const showVicinityQuery = useCallback((): void => {
      const point = getClickedPoint();
      if (!point) return;
      windowManager.ShowWindow('vicinity-query-window');
      close();
      GisGraphicsHelper.ZoomToGeometry(MapManager.GetMapView(), point, 14);
    }, [close, getClickedPoint, windowManager]);

    const showIdentify = useCallback((): void => {
      const point = getClickedPoint();
      if (!point) return;
      windowManager.ShowWindow('global-identify-widget');
      close();
    }, [close, getClickedPoint, windowManager]);

    const showRoute = useCallback((): void => {
      const point = getClickedPoint();
      const normalized = normalizeMapPoint(point as never);
      if (!point || !normalized) return;
      close();
      const target = new URL('https://www.google.com.tr/maps');
      target.searchParams.set('saddr', 'My Location');
      target.searchParams.set('daddr', `${normalized.latitude},${normalized.longitude}`);
      openExternalUrl(target.toString());
    }, [close, getClickedPoint]);

    const showStreetView = useCallback((): void => {
      const point = getClickedPoint();
      if (!point) return;
      openExternalUrl(GoogleMapsBusiness.CreateStreetViewUrlFromPoint(point));
      close();
    }, [close, getClickedPoint]);

    const actions = useMemo<readonly ExperienceMenuItem[]>(() => [
      {
        id: 'identify',
        label: 'Bilgi Al',
        description: 'Seçilen noktadaki harita detaylarını açar.',
        icon: <RiInformationLine aria-hidden="true" />,
        onActivate: showIdentify,
      },
      {
        id: 'nearby',
        label: 'Yakınımda Ara',
        description: 'Seçilen noktanın çevresindeki hizmetleri arar.',
        icon: <RiFocusLine aria-hidden="true" />,
        onActivate: showVicinityQuery,
      },
      {
        id: 'route',
        label: 'Yol Tarifi Al',
        description: 'Seçilen noktayı harici yol tarifi hedefi olarak açar.',
        icon: <RiRouteLine aria-hidden="true" />,
        onActivate: showRoute,
      },
      {
        id: 'street-view',
        label: 'Sokak Görünümü',
        description: 'Seçilen noktayı desteklenen sokak görünümünde açar.',
        icon: <RiGoogleFill aria-hidden="true" />,
        onActivate: showStreetView,
      },
    ], [showIdentify, showRoute, showStreetView, showVicinityQuery]);

    const positionMenuAt = useCallback((requested: ContextMenuPosition): void => {
      const menu = document.getElementById(id);
      const next = clampContextMenuPosition(
        requested,
        {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        {
          width: menu?.offsetWidth ?? 248,
          height: menu?.offsetHeight ?? 252,
        },
        8,
      );
      setPosition(next);
    }, [id]);

    useImperativeHandle(ref, () => ({
      id,
      visible: false,
      minimized: false,
      OnShow: () => {
        const clickEvent = MapManager.GetMapClickEvent() as unknown as MapClickEventLike | null;
        if (!clickEvent) return;
        const activeElement = document.activeElement;
        focusOriginRef.current = isRestorableFocusTarget(activeElement) ? activeElement : null;
        const nextRequested = {
          x: finiteCoordinate(clickEvent.x),
          y: finiteCoordinate(clickEvent.y),
        };
        setRequestedPosition(nextRequested);
        positionMenuAt(nextRequested);
        setFocusRequestKey((current) => current + 1);
      },
      OnClose: () => restoreFocus(),
    }), [id, positionMenuAt, restoreFocus]);

    useEffect(() => {
      windowManager.RegisterWindow(ref as RefObject<ManagedWindowHandle | null>);
      return () => {
        focusOriginRef.current = null;
        windowManager.UnregisterWindow?.(id, ref as RefObject<ManagedWindowHandle | null>);
      };
    }, [id, ref, windowManager]);

    useEffect(() => {
      const handleResize = (): void => positionMenuAt(requestedPosition);
      window.addEventListener('resize', handleResize, { passive: true });
      window.visualViewport?.addEventListener('resize', handleResize, { passive: true });
      window.visualViewport?.addEventListener('scroll', handleResize, { passive: true });
      return () => {
        window.removeEventListener('resize', handleResize);
        window.visualViewport?.removeEventListener('resize', handleResize);
        window.visualViewport?.removeEventListener('scroll', handleResize);
      };
    }, [positionMenuAt, requestedPosition]);

    const visible = windowManager.IsVisible(id);

    const handleDismiss = useCallback((reason: ExperienceMenuDismissReason): void => {
      close(reason !== 'tab');
    }, [close]);

    return (
      <>
        <ExperienceMenu
          id={id}
          className="context-menu-container context-menu-container--modern"
          itemClassName="context-menu-item"
          label="Harita işlemleri"
          items={actions}
          visible={visible}
          autoFocusWhenVisible
          focusRequestKey={focusRequestKey}
          onDismiss={handleDismiss}
          style={{
            position: 'absolute',
            top: position.y,
            left: position.x,
            zIndex: 999,
            visibility: visible ? 'visible' : 'hidden',
          }}
        />
        <span className="context-menu-privacy-note experience-sr-only">
          Harita işlemleri seçilen koordinatı istemci günlüğüne kaydetmez.
        </span>
      </>
    );
  },
);

ContextMenuWidget.displayName = 'ContextMenuWidget';
