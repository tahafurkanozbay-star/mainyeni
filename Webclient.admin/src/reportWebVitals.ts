import type { Metric } from 'web-vitals';

export type WebVitalsCallback = (metric: Metric) => void;

const reportWebVitals = (onPerfEntry?: WebVitalsCallback): void => {
  if (!onPerfEntry) return;

  void import('web-vitals').then(({ onCLS, onFCP, onINP, onLCP, onTTFB }) => {
    onCLS(onPerfEntry);
    onFCP(onPerfEntry);
    onINP(onPerfEntry);
    onLCP(onPerfEntry);
    onTTFB(onPerfEntry);
  });
};

export default reportWebVitals;
