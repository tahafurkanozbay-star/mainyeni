import { forwardRef, useEffect, useImperativeHandle, useState, type ReactNode, type RefObject } from 'react';
import { GoogleMapsBusiness } from '../../../Business/GoogleMapsBusiness';
import MapManager from '../../../Store/Managers/MapManager';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import { MapWidgetEmptyState, MapWidgetSurface, type MapWidgetManagerLike } from '../_shared/MapWidgetSurface';
import { normalizeMapPoint, type NormalizedMapPoint } from '../_shared/MapWidgetRuntime';
import { useMapWidgetFocus } from '../_shared/useMapWidgetFocus';
import './StreetViewWidget.css';

export interface StreetViewWidgetProps {
  readonly id: string;
  readonly windowManager: MapWidgetManagerLike;
}

export const StreetViewWidget = forwardRef<ManagedWindowHandle, StreetViewWidgetProps>(
  ({ id, windowManager }, ref): ReactNode => {
    useMapWidgetFocus(id, windowManager.IsVisible(id));
    const [point, setPoint] = useState<NormalizedMapPoint | null>(null);
    const url = point ? GoogleMapsBusiness.CreateStreetViewUrlFromPoint(point) : null;

    useImperativeHandle(ref, () => ({
      id, visible: false, minimized: false,
      OnShow: () => {
        const event = MapManager.GetMapClickEvent() as { readonly mapPoint?: unknown } | null;
        setPoint(normalizeMapPoint(event?.mapPoint));
      },
      OnClose: () => setPoint(null),
    }), [id]);

    useEffect(() => {
      windowManager.RegisterWindow(ref as RefObject<ManagedWindowHandle | null>);
      return () => windowManager.UnregisterWindow?.(id, ref as RefObject<ManagedWindowHandle | null>);
    }, [id, ref, windowManager]);

    return (
      <MapWidgetSurface id={id} title="Sokak Görüntüsü" iconSrc="images/icons/toolbar/sokakgoruntusu.png" windowManager={windowManager}>
        {point && url ? (
          <section className="streetview-location" aria-labelledby={`${id}-location-title`}>
            <svg className="streetview-location__icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" focusable="false">
              <path d="M6 36V16l12-4 12 4 12-4v20l-12 4-12-4-12 4Z M18 12v20 M30 16v20" />
              <circle cx="24" cy="14" r="7" fill="var(--exp-surface)" /><path d="m20 14 4 4 4-4" />
            </svg>
            <h3 id={`${id}-location-title`}>Seçilen konum</h3>
            <dl className="streetview-location__coordinates">
              <div><dt>Enlem</dt><dd>{point.latitude.toFixed(5)}</dd></div>
              <div><dt>Boylam</dt><dd>{point.longitude.toFixed(5)}</dd></div>
            </dl>
            <p>Sokak görüntüsünü Google Haritalar’da açın. Görüntü bulunabilirliği seçilen konuma bağlıdır.</p>
            <a className="map-widget-action map-widget-action--primary streetview-location__open" href={url} target="_blank" rel="noopener noreferrer">
              <span>Sokak görüntüsünü aç</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M14 3h7v7 M10 14 21 3 M10 3H3v18h18v-7" /></svg>
              <span className="experience-sr-only"> — yeni sekmede</span>
            </a>
            <small>Yeni sekmede açılır; çalışma alanınız burada kalır.</small>
          </section>
        ) : (
          <MapWidgetEmptyState title="Konum seçin" description="Haritada bir noktayı seçtikten sonra Sokak Görüntüsü aracını açın. Sağ tık menüsünden de sokak görünümüne ulaşabilirsiniz." />
        )}
      </MapWidgetSurface>
    );
  },
);
StreetViewWidget.displayName = 'StreetViewWidget';
