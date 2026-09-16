import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { AppErrorBoundary } from './platform/runtime/AppErrorBoundary';
import { installBrowserRuntimeObservers, runtimeDiagnostics } from './platform/runtime/runtimeDiagnostics';
import { performanceMonitor } from './platform/performance/performanceMonitor';

const rootElement = document.getElementById('root');
if (!(rootElement instanceof HTMLElement)) {
  throw new Error('Application root element #root was not found.');
}

performanceMonitor.start();
const runtimeObserverHandle = installBrowserRuntimeObservers(runtimeDiagnostics);

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

if (typeof requestAnimationFrame === 'function') {
  requestAnimationFrame(() => performanceMonitor.markRenderComplete());
} else {
  queueMicrotask(() => performanceMonitor.markRenderComplete());
}

// Vite can replace the entry module while developing. Dispose global listeners,
// observers and performance instrumentation so repeated HMR cycles cannot create
// duplicate diagnostics or retain detached browser resources.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    runtimeObserverHandle.dispose();
    performanceMonitor.stop();
    root.unmount();
  });
}
