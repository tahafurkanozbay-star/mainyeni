const reportWebVitals = onPerfEntry => {
  if (typeof onPerfEntry !== "function") return;

  if (typeof performance !== "undefined" && typeof performance.getEntriesByType === "function") {
    performance.getEntriesByType("navigation").forEach(onPerfEntry);
    performance.getEntriesByType("paint").forEach(onPerfEntry);
  }
};

export default reportWebVitals;
