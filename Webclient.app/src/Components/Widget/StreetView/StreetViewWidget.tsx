import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { GoogleMapsBusiness } from '../../../Business/GoogleMapsBusiness';
import MapManager from '../../../Store/Managers/MapManager';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import {
  MapWidgetEmptyState,
  MapWidgetSurface,
  type MapWidgetManagerLike,
} from '../_shared/MapWidgetSurface';
import {
  normalizeMapPoint,
  sanitizeExternalUrl,
} from '../_shared/MapWidgetRuntime';
import './StreetViewWidget.css';

export interface StreetViewWidgetProps {
  readonly id: string;
  readonly windowManager: MapWidgetManagerLike;
}

export const StreetViewWidget = forwardRef<ManagedWindowHandle, StreetViewWidgetProps>(
  ({ id, windowManager }, ref): ReactNode => {
    const [url, setUrl] = useState<string | null>(null);
    const [status, setStatus] = useState('Haritada bir konum seçildiğinde sokak görünümü burada açılır.');

    useImperativeHandle(ref, () => ({
      id,
      visible: false,
      minimized: false,
      OnShow: () => {
        const mapPoint = MapManager.GetMapClickEvent()?.mapPoint;
        const normalized = normalizeMapPoint(mapPoint);
        if (!normalized || !mapPoint) {
          setUrl(null);
          setStatus('Sokak görünümü için önce haritada geçerli bir konum seçin.');
          windowManager.ShowWindow('sidebar');
          return;
        }

        const candidate = GoogleMapsBusiness.CreateStreetViewUrlFromPoint(mapPoint);
        const safeUrl = sanitizeExternalUrl(candidate);
        setUrl(safeUrl);
        setStatus(
          safeUrl
            ? `Sokak görünümü ${normalized.latitude.toFixed(5)}, ${normalized.longitude.toFixed(5)} konumu için hazır.`
            : 'Sokak görünümü bağlantısı güvenli biçimde oluşturulamadı.',
        );
        windowManager.ShowWindow('sidebar');
      },
      OnClose: () => {
        setUrl(null);
        setStatus('Haritada bir konum seçildiğinde sokak görünümü burada açılır.');
      },
    }), [id, windowManager]);

    useEffect(() => {
      windowManager.RegisterWindow(ref as RefObject<ManagedWindowHandle | null>);
      return () => windowManager.UnregisterWindow?.(id, ref as RefObject<ManagedWindowHandle | null>);
    }, [id, ref, windowManager]);

    const iframePolicy = useMemo(() => ({
      allow: 'fullscreen',
      referrerPolicy: 'strict-origin-when-cross-origin' as const,
      sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    }), []);

    return (
      <MapWidgetSurface
        id={id}
        title="Sokak Görüntüsü"
        iconSrc="images/icons/toolbar/sokakgoruntusu.png"
        windowManager={windowManager}
        status={status}
        statusTone={url ? 'success' : 'info'}
        bodyClassName="layer-list-window-body"
      >
        {url ? (
          <div className="streetview-frame-shell">
            <iframe
              src={url}
              width="100%"
              height="320"
              title="Seçilen konumun sokak görüntüsü"
              loading="lazy"
              allow={iframePolicy.allow}
              sandbox={iframePolicy.sandbox}
              referrerPolicy={iframePolicy.referrerPolicy}
            />
          </div>
        ) : (
          <MapWidgetEmptyState
            title="Konum bekleniyor"
            description="Haritada sağ tıklayıp Sokak Görünümü seçin veya ilgili araçtan bir nokta belirleyin."
          />
        )}
      </MapWidgetSurface>
    );
  },
);

StreetViewWidget.displayName = 'StreetViewWidget';
