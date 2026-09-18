import { createRoot } from 'react-dom/client';
import App from './App';
import '@arcgis/core/assets/esri/themes/light/main.css';
import './styles.css';
import './experience-premium.css';
import { AppErrorBoundary } from './platform/runtime/AppErrorBoundary';
import { installBrowserRuntimeObservers, runtimeDiagnostics } from './platform/runtime/runtimeDiagnostics';
import { installDeploymentRecovery } from './platform/runtime/deploymentRecovery';
import { performanceMonitor } from './platform/performance/performanceMonitor';
import { runtimeConfig } from './platform/config/runtimeConfig';

const rootElement = document.getElementById('root');
if (!(rootElement instanceof HTMLElement)) {
  throw new Error('Application root element #root was not found.');
}

performanceMonitor.start();
const deploymentRecoveryHandle = installDeploymentRecovery(runtimeDiagnostics);
const runtimeObserverHandle = installBrowserRuntimeObservers(runtimeDiagnostics);

let disposeAdaptiveRuntime = (): void => undefined;
if (runtimeConfig.features.adaptiveRuntime) {
  let lifecycleDisposed = false;
  let stopRuntime: (() => void) | null = null;

  const requestStop = (): void => {
    lifecycleDisposed = true;
    stopRuntime?.();
  };
  window.addEventListener('pagehide', requestStop, { once: true });

  void import('./platform/runtime/runtimeKernel')
    .then(async ({ runtimeKernel }) => {
      stopRuntime = () => {
        void runtimeKernel.stop({ drain: false, timeoutMs: 2000 }).catch((error: unknown) => {
          if (!lifecycleDisposed) {
            runtimeDiagnostics.captureError(error, { source: 'runtime.kernel.stop' }, 'warn');
          }
        });
      };

      if (lifecycleDisposed) {
        stopRuntime();
        return;
      }

      const snapshot = await runtimeKernel.start();
      if (lifecycleDisposed) {
        stopRuntime();
        return;
      }
      runtimeDiagnostics.record('runtime.kernel.started', {
        phase: snapshot.phase,
        tier: snapshot.capabilities.tier,
      });
    })
    .catch((error: unknown) => {
      if (!lifecycleDisposed) {
        runtimeDiagnostics.captureError(error, { source: 'runtime.kernel.start' }, 'warn');
      }
    });

  disposeAdaptiveRuntime = () => {
    lifecycleDisposed = true;
    window.removeEventListener('pagehide', requestStop);
    stopRuntime?.();
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
    deploymentRecoveryHandle.dispose();
    runtimeObserverHandle.dispose();
    performanceMonitor.stop();
    root.unmount();
  });
}
