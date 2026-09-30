import { useSyncExternalStore, type ReactNode } from 'react';
import type {
  MapViewportContinuityFinding,
  MapViewportContinuityModel,
} from './mapViewportContinuityModel';
import './MapViewportContinuityDetails.css';

export interface MapViewportContinuityDetailsProps {
  readonly model: MapViewportContinuityModel;
}

const findingLabel = (finding: MapViewportContinuityFinding): string => {
  if (finding.code === 'mode-mismatch') return 'Görünüm modu';
  if (finding.code === 'center-lost') return 'Harita merkezi';
  if (finding.code === 'center-introduced') return 'Harita merkezi';
  if (finding.code === 'scale-lost') return 'Harita ölçeği';
  if (finding.code === 'scale-ratio-high') return 'Harita ölçeği';
  if (finding.code === 'basemap-changed') return 'Altlık harita';
  if (finding.code === 'selection-layer-changed') return 'Seçili katman';
  if (finding.code === 'selection-object-changed') return 'Seçili nesne';
  return 'Zaman bağlamı';
};

const findingIcon = (finding: MapViewportContinuityFinding): string => (
  finding.severity === 'warning' ? '!' : 'i'
);

export const MapViewportContinuityDetails = ({
  model,
}: MapViewportContinuityDetailsProps): ReactNode => {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const report = snapshot.latestReport;
  if (!report || snapshot.status !== 'degraded' || report.findings.length === 0) return null;

  const warningCount = report.findings.filter((finding) => finding.severity === 'warning').length;
  const infoCount = report.findings.length - warningCount;

  return (
    <details
      className="map-viewport-continuity-details"
      data-status={snapshot.status}
      data-warning-count={warningCount}
    >
      <summary className="map-viewport-continuity-details__summary">
        <span className="map-viewport-continuity-details__summary-icon" aria-hidden="true">!</span>
        <span className="map-viewport-continuity-details__summary-copy">
          <strong>Görünüm geçişini kontrol et</strong>
          <span>{warningCount} önemli fark algılandı</span>
        </span>
        <span className="map-viewport-continuity-details__score" aria-label={`Süreklilik puanı ${report.score} / 100`}>
          {report.score}/100
        </span>
      </summary>

      <div className="map-viewport-continuity-details__body">
        <p className="map-viewport-continuity-details__intro">
          Harita kullanılabilir durumda. Aşağıdaki çalışma bağlamı farklarını kontrol ederek gerekirse önceki görünümünüze dönebilirsiniz.
        </p>
        <ul className="map-viewport-continuity-details__findings" aria-label="Görünüm sürekliliği bulguları">
          {report.findings.map((finding, index) => (
            <li
              key={`${finding.code}-${index}`}
              className="map-viewport-continuity-details__finding"
              data-severity={finding.severity}
            >
              <span className="map-viewport-continuity-details__finding-icon" aria-hidden="true">
                {findingIcon(finding)}
              </span>
              <span className="map-viewport-continuity-details__finding-copy">
                <strong>{findingLabel(finding)}</strong>
                <span>{finding.message}</span>
              </span>
            </li>
          ))}
        </ul>
        <footer className="map-viewport-continuity-details__footer">
          <span>{warningCount} uyarı</span>
          {infoCount > 0 && <span>{infoCount} bilgi</span>}
          <span>İstek #{report.requestId}</span>
        </footer>
      </div>
    </details>
  );
};

export default MapViewportContinuityDetails;
