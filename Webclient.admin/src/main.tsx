import { createRoot } from "react-dom/client";
import "bootstrap/dist/css/bootstrap.min.css";
import "./index.css";
import App from "./App";
import reportWebVitals from "./reportWebVitals";
import { reportAdminError } from "./platform/diagnostics";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Admin root elementi bulunamadı.");
}

createRoot(container).render(<App />);

void reportWebVitals((metric) => {
  if (metric.rating === "poor") {
    reportAdminError("ui", "web-vital-poor", new Error(`${metric.name}: ${metric.value}`), {
      name: metric.name,
      value: metric.value,
      rating: metric.rating,
    });
  }
});
