import {
  forwardRef,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react';
import {
  CommonQueryWindowTools,
  type QueryWindowManagerLike,
} from '../../Query/_Common/CommonQueryWindowTools';
import type { ManagedWindowHandle } from '../../../experience/contracts';\nimport './MapWidgetSurface.css';

export interface MapWidgetManagerLike extends QueryWindowManagerLike {
  readonly IsVisible: (id: string) => boolean;
  readonly ShowWindow: (id: string, query?: unknown) => void;
  readonly RegisterWindow: (ref: RefObject<ManagedWindowHandle | null>) => void;\n  readonly UnregisterWindow?: (id: string, ref: RefObject<ManagedWindowHandle | null>) => void;
  readonly HideWindow: (id: string) => void;
}

export type MapWidgetTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface MapWidgetSurfaceProps {
  readonly id: string;
  readonly title: string;
  readonly iconSrc?: string;
  readonly iconAlt?: string;
  readonly windowManager: MapWidgetManagerLike;
  readonly children: ReactNode;
  readonly bodyClassName?: string;
  readonly className?: string;
  readonly labelledBy?: string;
  readonly describedBy?: string;
  readonly busy?: boolean;
  readonly status?: string | null;
  readonly statusTone?: MapWidgetTone;
  readonly error?: string | null;
  readonly footer?: ReactNode;
  readonly showWindowTools?: boolean;
  readonly panelStyle?: CSSProperties;
  readonly role?: 'region' | 'dialog';
}

const joinClassNames = (...parts: Array<string | false | null | undefined>): string => (
  parts.filter(Boolean).join(' ')
);

export const MapWidgetStatus = ({
  children,
  tone = 'neutral',
  live = 'polite',
}: {
  readonly children: ReactNode;
  readonly tone?: MapWidgetTone;
  readonly live?: 'off' | 'polite' | 'assertive';
}): ReactNode => (
  <div
    className={joinClassNames('map-widget-status', `map-widget-status--${tone}`)}
    role={tone === 'danger' ? 'alert' : 'status'}
    aria-live={tone === 'danger' ? 'assertive' : live}
  >
    {children}
  </div>
);

export const MapWidgetEmptyState = ({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}): ReactNode => (
  <div className="map-widget-empty" role="status">
    <div className="map-widget-empty__glyph" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M4 5.5h16v13H4z" />
        <path d="M8 9h8M8 13h5" />
      </svg>
    </div>
    <div className="map-widget-empty__copy">
      <strong>{title}</strong>
      {description ? <p>{description}</p> : null}
      {action ? <div className="map-widget-empty__action">{action}</div> : null}
    </div>
  </div>
);

export const MapWidgetSkeleton = ({
  rows = 4,
  label = 'İçerik hazırlanıyor',
}: {
  readonly rows?: number;
  readonly label?: string;
}): ReactNode => (
  <div className="map-widget-skeleton" role="status" aria-label={label} aria-busy="true">
    {Array.from({ length: Math.max(1, Math.min(rows, 12)) }, (_, index) => (
      <span
        className="map-widget-skeleton__row"
        key={index}
        style={{ '--widget-skeleton-width': `${88 - ((index * 13) % 31)}%` } as CSSProperties}
        aria-hidden="true"
      />
    ))}
  </div>
);

export const MapWidgetSection = ({
  title,
  description,
  children,
  actions,
  className,
}: {
  readonly title?: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}): ReactNode => (
  <section className={joinClassNames('map-widget-section', className)}>
    {title || actions ? (
      <header className="map-widget-section__header">
        <div className="map-widget-section__heading">
          {title ? <h3>{title}</h3> : null}
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div className="map-widget-section__actions">{actions}</div> : null}
      </header>
    ) : description ? <p className="map-widget-section__description">{description}</p> : null}
    <div className="map-widget-section__body">{children}</div>
  </section>
);

export const MapWidgetSurface = forwardRef(function MapWidgetSurface(
  {
    id,
    title,
    iconSrc,
    iconAlt = '',
    windowManager,
    children,
    bodyClassName,
    className,
    labelledBy,
    describedBy,
    busy = false,
    status = null,
    statusTone = 'neutral',
    error = null,
    footer,
    showWindowTools = true,
    panelStyle,
    role = 'region',
  }: MapWidgetSurfaceProps,
  _ref: Ref<HTMLDivElement>,
): ReactNode {
  const visible = windowManager.IsVisible(id);
  const titleId = labelledBy ?? `${id}-title`;
  const descriptionId = describedBy ?? (status ? `${id}-status` : undefined);

  return (
    <section
      id={`${id}-surface`}
      className={joinClassNames(
        'common-query-window',
        'common-query-window-right',
        'map-widget-surface',
        visible && 'is-visible',
        busy && 'is-busy',
        className,
      )}
      style={{ ...panelStyle, visibility: visible ? 'visible' : 'hidden' }}
      aria-hidden={!visible}
      aria-busy={busy || undefined}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      role={role}
      data-widget-id={id}
      data-widget-visible={visible ? 'true' : 'false'}
    >
      <header className="common-query-window-header map-widget-surface__header">
        <div className="map-widget-surface__identity">
          {iconSrc ? (
            <img
              className="common-query-window-header-icon map-widget-surface__icon"
              src={iconSrc}
              alt={iconAlt}
              aria-hidden={iconAlt ? undefined : true}
              decoding="async"
            />
          ) : (
            <span className="map-widget-surface__icon-fallback" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="m4 7 5-3 6 3 5-3v13l-5 3-6-3-5 3V7Z" />
                <path d="M9 4v13M15 7v13" />
              </svg>
            </span>
          )}
          <div className="map-widget-surface__title-wrap">
            <h2 id={titleId} className="map-widget-surface__title">{title}</h2>
            {busy ? <span className="map-widget-surface__busy-label">İşleniyor</span> : null}
          </div>
        </div>
        {showWindowTools ? (
          <div className="map-widget-surface__window-tools">
            <CommonQueryWindowTools
              windowManager={windowManager}
              windowId={id}
              showNearbySearch={false}
              showMapSelect={false}
              setQueryField={() => undefined}
              query={null}
            />
          </div>
        ) : null}
      </header>

      {status ? (
        <div id={descriptionId} className="map-widget-surface__status-row">
          <MapWidgetStatus tone={statusTone}>{status}</MapWidgetStatus>
        </div>
      ) : null}

      {error ? (
        <div className="map-widget-surface__status-row">
          <MapWidgetStatus tone="danger">{error}</MapWidgetStatus>
        </div>
      ) : null}

      <div className={joinClassNames(
        'common-query-window-body',
        'map-widget-surface__body',
        bodyClassName,
      )}>
        {children}
      </div>

      {footer ? (
        <footer className="map-widget-surface__footer">
          {footer}
        </footer>
      ) : null}
    </section>
  );
});

MapWidgetSurface.displayName = 'MapWidgetSurface';
