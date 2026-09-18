import type { Metric } from 'web-vitals';
import { defaultWebVitalsRuntime, type WebVitalsRuntime } from './observability/webVitalsRuntime';

export type WebVitalsCallback = (metric: Metric) => void;

const reportWebVitals = (
  onPerfEntry?: WebVitalsCallback,
  runtime: WebVitalsRuntime = defaultWebVitalsRuntime,
): void => {
  if (onPerfEntry !== undefined && typeof onPerfEntry !== 'function') return;
  void import('web-vitals').then(({ onCLS, onFCP, onINP, onLCP, onTTFB }) => {
    const handler = (metric: Metric): void => {
      runtime.record(metric);
      onPerfEntry?.(metric);
    };
    onCLS(handler);
    onFCP(handler);
    onINP(handler);
    onLCP(handler);
    onTTFB(handler);
  });
};

export default reportWebVitals;
