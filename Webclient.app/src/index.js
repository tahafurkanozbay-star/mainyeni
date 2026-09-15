import 'react-app-polyfill/ie9';
import 'react-app-polyfill/ie11';
import 'react-app-polyfill/stable';
import 'core-js/features/string/repeat';
import 'abortcontroller-polyfill';

import React from "react";
import ReactDOM from "react-dom";

import App from "./App";
import "./styles.css";
import reportWebVitals, { logWebVital } from './reportWebVitals';
import { logger } from './platform/observability/logger';
import * as serviceWorker from './platform/pwa/serviceWorkerRegistration';

const rootElement = document.getElementById("root");
ReactDOM.render(<App />, rootElement);

reportWebVitals(logWebVital);
serviceWorker.registerServiceWorker().catch((error) => {
  logger.warn('service_worker_registration_failed', { message: error?.message });
});
