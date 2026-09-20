import type { Metric } from "web-vitals";

export type WebVitalsReporter = (metric: Metric) => void;

const reportWebVitals = async (onPerfEntry?: WebVitalsReporter): Promise<void> => {
  if (!onPerfEntry) return;
  const {
    onCLS,
    onFCP,
    onINP,
    onLCP,
    onTTFB,
  } = await import("web-vitals");

  onCLS(onPerfEntry);
  onFCP(onPerfEntry);
  onINP(onPerfEntry);
  onLCP(onPerfEntry);
  onTTFB(onPerfEntry);
};

export default reportWebVitals;
