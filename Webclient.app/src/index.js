import React from 'react';
import ReactDOM from 'react-dom';
import 'react-app-polyfill/ie9';
import 'react-app-polyfill/stable';
import 'abortcontroller-polyfill/dist/polyfill-patch-fetch';
import App from './App';
import * as serviceWorker from './platform/pwa/serviceWorkerRegistration';

ReactDOM.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
  document.getElementById('root')
);

serviceWorker.registerServiceWorker();
