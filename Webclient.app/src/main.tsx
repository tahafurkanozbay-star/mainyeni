import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { AppErrorBoundary } from './platform/runtime/AppErrorBoundary';
import {
  installBrowserRuntimeObservers,
  runtimeDiagnostics,
} from './platform/runtime/runtimeDiagnostics';

const rootElement = document.getElementById('root');
if (!(rootElement instanceof HTMLElement)) {
  throw new Error('Application root element #root was not found.');
}

installBrowserRuntimeObservers(runtimeDiagnostics);

const root = createRoot(rootElement, {
  onCaughtError(error, errorInfo) {
    runtimeDiagnostics.captureError(error, {
      source: 'react.root.caught',
      componentStack: errorInfo.componentStack || null,
    });
  },
  onUncaughtError(error, errorInfo) {
    runtimeDiagnostics.captureError(error, {
      source: 'react.root.uncaught',
      componentStack: errorInfo.componentStack || null,
    }, 'fatal');
  },
  onRecoverableError(error, errorInfo) {
    runtimeDiagnostics.captureError(error, {
      source: 'react.root.recoverable',
      componentStack: errorInfo.componentStack || null,
    }, 'warn');
  },
});

root.render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
