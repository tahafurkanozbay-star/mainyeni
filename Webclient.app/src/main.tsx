import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { AppErrorBoundary } from './platform/runtime/AppErrorBoundary';
import { performanceMonitor } from './platform/performance/performanceMonitor';
import {
  installBrowserRuntimeObservers,
  runtimeDiagnostics,
} from './platform/runtime/runtimeDiagnostics';

const rootElement = document.getElementById('root');
if (!(rootElement instanceof HTMLElement)) {
  throw new Error('Application root element #root was not found.');
}

performanceMonitor.start();
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

// React 19 no longer exposes the legacy ReactDOM.render completion callback.
// Two animation frames place this marker after React has had an opportunity to
// commit the initial tree and the browser has scheduled its first paint.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const firstRenderMs = performanceMonitor.markRenderComplete();
    runtimeDiagnostics.record('app.first-render.completed', { firstRenderMs });
  });
});
