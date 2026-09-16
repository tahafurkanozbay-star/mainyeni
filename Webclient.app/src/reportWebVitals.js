import { performanceMonitor } from "./platform/performance/performanceMonitor";

const toMetric = (name, value) => value === null || value === undefined
  ? null
  : Object.freeze({ id: `kent-rehberi-${name.toLowerCase()}`, name, value, delta: value });

const reportWebVitals = onPerfEntry => {
  if (typeof onPerfEntry !== "function") return;
  performanceMonitor.start();

  const emit = () => {
    const snapshot = performanceMonitor.snapshot();
    [
      toMetric("FCP", snapshot.startup.firstContentfulPaintMs),
      toMetric("TTFB", snapshot.startup.ttfbMs),
      toMetric("LCP", snapshot.coreWebVitals.lcp.value),
      toMetric("CLS", snapshot.coreWebVitals.cls.value),
      toMetric("INP", snapshot.coreWebVitals.inp.value),
    ].filter(Boolean).forEach(onPerfEntry);
  };

  if (typeof document === "undefined" || document.readyState === "complete") {
    queueMicrotask(emit);
    return;
  }
  window.addEventListener("load", emit, { once: true });
};

export default reportWebVitals;
