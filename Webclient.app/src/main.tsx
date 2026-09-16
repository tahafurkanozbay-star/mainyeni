import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { AppErrorBoundary } from './platform/runtime/AppErrorBoundary';
import { installBrowserRuntimeObservers, runtimeDiagnostics } from './platform/runtime/runtimeDiagnostics';
import { performanceMonitor } from './platform/performance/performanceMonitor';
import { runtimeConfig } from './platform/config/runtimeConfig';
import { runtimeKernel } from './platform/runtime/runtimeKernel';

const rootElement = document.getElementById('root');
if (!(rootElement instanceof HTMLElement)) {
  throw new Error('Application root element #root was not found.');
}

performanceMonitor.start();
const runtimeObserverHandle = installBrowserRuntimeObservers(runtimeDiagnostics);

let disposeAdaptiveRuntime = (): void => undefined;
if (runtimeConfig.features.adaptiveRuntime) {
  void runtimeKernel.start()
    .then((snapshot) => {
      runtimeDiagnostics.record('runtime.kernel.started', {
        phase: snapshot.phase,
        tier: snapshot.capabilities.tier,
      });
    })
    .catch((error: unknown) => {
      runtimeDiagnostics.captureError(error, { source: 'runtime.kernel.start' }, 'warn');
    });

  const stopRuntime = (): void => {
    void runtimeKernel.stop({ drain: false, timeoutMs: 2000 }).catch((error: unknown) => {
      runtimeDiagnostics.captureError(error, { source: 'runtime.kernel.stop' }, 'warn');
    });
  };
  window.addEventListener('pagehide', stopRuntime, { once: true });
  disposeAdaptiveRuntime = () => {
    window.removeEventListener('pagehide', stopRuntime);
    stopRuntime();
  };
}

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
// observers, adaptive runtime resources and performance instrumentation so HMR
// cycles cannot create duplicate diagnostics or retain detached browser state.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeAdaptiveRuntime();
    runtimeObserverHandle.dispose();
    performanceMonitor.stop();
    root.unmount();
  });
}
