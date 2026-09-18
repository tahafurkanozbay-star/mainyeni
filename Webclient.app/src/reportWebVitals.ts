import type { Metric } from 'web-vitals';

export type ReportWebVitalsHandler = (metric: Metric) => void;

const reportWebVitals = (onPerfEntry?: ReportWebVitalsHandler | null): void => {
  if (typeof onPerfEntry !== 'function') return;

  void import('web-vitals')
    .then(({ onCLS, onFCP, onINP, onLCP, onTTFB }) => {
      onCLS(onPerfEntry);
      onFCP(onPerfEntry);
      onINP(onPerfEntry);
      onLCP(onPerfEntry);
      onTTFB(onPerfEntry);
    })
    .catch(() => {
      // Metrics are optional diagnostics and must never block app startup.
    });
};

export default reportWebVitals;
