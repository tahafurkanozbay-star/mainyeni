import React, { useId, useMemo, useSyncExternalStore } from 'react';
import type { MapWorkspaceAccessibilityModel } from './mapWorkspaceAccessibility';
import {
  createMapWorkspaceHealthPresentation,
  type MapWorkspaceHealthActionId,
} from './mapWorkspaceHealthPresentation';
import './MapWorkspaceHealthSurface.css';

export interface MapWorkspaceHealthSurfaceProps {
  readonly model: MapWorkspaceAccessibilityModel;
  readonly onRetry: () => void;
  readonly onOpenHelp?: () => void;
  readonly onReloadPage?: () => void;
}

const actionIcon = (actionId: MapWorkspaceHealthActionId): string => {
  switch (actionId) {
    case 'retry-workspace': return '↻';
    case 'open-help': return '?';
    case 'reload-page': return '⟳';
  }
};

const eventKindLabel = (kind: string): string => {
  switch (kind) {
    case 'attempt': return 'Başlatma';
    case 'phase': return 'Durum';
    case 'resource': return 'Kaynak';
    case 'delay': return 'Gecikme';
    case 'recovery': return 'Kurtarma';
    default: return 'Olay';
  }
};

export const MapWorkspaceHealthSurface = ({
  model,
  onRetry,
  onOpenHelp,
  onReloadPage,
}: MapWorkspaceHealthSurfaceProps) => {
  const titleId = useId();
  const descriptionId = useId();
  const detailsId = useId();
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const presentation = useMemo(() => createMapWorkspaceHealthPresentation(snapshot), [snapshot]);

  const invokeAction = (actionId: MapWorkspaceHealthActionId): void => {
    switch (actionId) {
      case 'retry-workspace':
        if (snapshot.canRetry) onRetry();
        return;
      case 'open-help':
        onOpenHelp?.();
        return;
      case 'reload-page':
        if (snapshot.retryExhausted) onReloadPage?.();
        return;
    }
  };

  return (
    <>
      <span
        className="map-workspace-health__live"
        role={presentation.role}
        aria-live={presentation.live}
        aria-atomic="true"
      >
        {snapshot.announcement}
      </span>

      {presentation.visible && (
        <section
          className="map-workspace-health"
          data-tone={presentation.tone}
          data-phase={snapshot.phase}
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          aria-busy={snapshot.isBusy}
        >
          <div className="map-workspace-health__accent" aria-hidden="true" />
          <div className="map-workspace-health__main">
            <header className="map-workspace-health__header">
              <div className="map-workspace-health__heading-copy">
                <div className="map-workspace-health__meta">
                  <span className="map-workspace-health__badge">{presentation.badge}</span>
                  {presentation.attemptLabel && (
                    <span className="map-workspace-health__attempt">{presentation.attemptLabel}</span>
                  )}
                </div>
                <h2 id={titleId}>{presentation.title}</h2>
                <p id={descriptionId}>{presentation.description}</p>
              </div>
              <span className="map-workspace-health__state-glyph" aria-hidden="true">
                {presentation.tone === 'danger' ? '!' : presentation.tone === 'warning' ? '△' : '•'}
              </span>
            </header>

            {presentation.progressLabel && (
              <div className="map-workspace-health__progress" aria-label={presentation.progressLabel}>
                <span className="map-workspace-health__progress-track" aria-hidden="true">
                  <span className="map-workspace-health__progress-value" />
                </span>
                <span>{presentation.progressLabel}</span>
              </div>
            )}

            {presentation.actions.length > 0 && (
              <div className="map-workspace-health__actions" aria-label="Harita kurtarma işlemleri">
                {presentation.actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className="map-workspace-health__action"
                    data-emphasis={action.emphasis}
                    onClick={() => invokeAction(action.id)}
                  >
                    <span aria-hidden="true" className="map-workspace-health__action-icon">{actionIcon(action.id)}</span>
                    <span>{action.label}</span>
                  </button>
                ))}
              </div>
            )}

            {presentation.showDiagnostics && (
              <details className="map-workspace-health__details" id={detailsId}>
                <summary>
                  <span>Çalışma alanı durumu</span>
                  <span className="map-workspace-health__issue-count">
                    {snapshot.issueCount > 0 ? `${snapshot.issueCount} sınırlama` : 'Ayrıntılar'}
                  </span>
                </summary>

                <div className="map-workspace-health__details-body">
                  <section className="map-workspace-health__resources" aria-labelledby={`${detailsId}-resources`}>
                    <h3 id={`${detailsId}-resources`}>Kaynaklar</h3>
                    <ul>
                      {presentation.resources.map((resource) => (
                        <li key={resource.key} data-tone={resource.tone}>
                          <span className="map-workspace-health__resource-dot" aria-hidden="true" />
                          <span className="map-workspace-health__resource-copy">
                            <strong>{resource.label}</strong>
                            {resource.message && <span>{resource.message}</span>}
                          </span>
                          <span className="map-workspace-health__resource-status">{resource.statusLabel}</span>
                        </li>
                      ))}
                    </ul>
                  </section>

                  {snapshot.recentEvents.length > 0 && (
                    <section className="map-workspace-health__events" aria-labelledby={`${detailsId}-events`}>
                      <h3 id={`${detailsId}-events`}>Son durum değişiklikleri</h3>
                      <ol>
                        {snapshot.recentEvents.slice(-6).map((event) => (
                          <li key={event.id}>
                            <span className="map-workspace-health__event-kind">{eventKindLabel(event.kind)}</span>
                            <span>{event.label}</span>
                          </li>
                        ))}
                      </ol>
                    </section>
                  )}
                </div>
              </details>
            )}
          </div>
        </section>
      )}
    </>
  );
};

export default MapWorkspaceHealthSurface;
