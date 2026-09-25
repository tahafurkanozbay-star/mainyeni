import { createRoot } from 'react-dom/client';
import App from './App';
import '@arcgis/core/assets/esri/themes/light/main.css';
import './styles.css';
import './experience-premium.css';
import { ExperienceRuntimeRecoveryBoundary } from './Components/Common/ExperienceRuntimeRecoveryBoundary';
import { installBrowserRuntimeObservers, runtimeDiagnostics } from './platform/runtime/runtimeDiagnostics';
import { installDeploymentRecovery } from './platform/runtime/deploymentRecovery';
import { performanceMonitor } from './platform/performance/performanceMonitor';
import { runtimeConfig } from './platform/config/runtimeConfig';
import { installInputModalityRuntime } from './experience/inputModalityRuntime';
import {
  browserPerformanceDiagnosticEnvironment,
  installPerformanceLifecycleCapture,
  performanceRuntime,
  recordPerformanceDiagnostic,
  registerWebVitals,
  startupProfiler,
} from './performance';

const rootElement = document.getElementById('root');
if (!(rootElement instanceof HTMLElement)) {
  throw new Error('Application root element #root was not found.');
}

performanceMonitor.start();
startupProfiler.begin('application-bootstrap', typeof performance !== 'undefined' ? performance.now() : 0);
const webVitalsRegistration = registerWebVitals(performanceRuntime.recordVital);
const performanceLifecycleHandle = installPerformanceLifecycleCapture(performanceRuntime, {
  onCapture(snapshot) {
    recordPerformanceDiagnostic(
      runtimeDiagnostics,
      snapshot,
      browserPerformanceDiagnosticEnvironment(),
    );
  },
  onCaptureError(error) {
    runtimeDiagnostics.captureError(
      error,
      { source: 'performance.lifecycle.capture-observer' },
      'warn',
    );
  },
});
const deploymentRecoveryHandle = installDeploymentRecovery(runtimeDiagnostics);
const runtimeObserverHandle = installBrowserRuntimeObservers(runtimeDiagnostics);
const inputModalityHandle = installInputModalityRuntime({ document, window });

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
  <ExperienceRuntimeRecoveryBoundary>
    <App />
  </ExperienceRuntimeRecoveryBoundary>,
);

const markInitialRenderComplete = (): void => {
  performanceMonitor.markRenderComplete();
  startupProfiler.end('application-bootstrap', typeof performance !== 'undefined' ? performance.now() : 0);
};

if (typeof requestAnimationFrame === 'function') {
  requestAnimationFrame(markInitialRenderComplete);
} else {
  queueMicrotask(markInitialRenderComplete);
}

// Vite can replace the entry module while developing. Dispose global listeners,
// observers, adaptive runtime resources and performance instrumentation so HMR
// cycles cannot create duplicate diagnostics or retain detached browser state.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    inputModalityHandle.dispose();
    disposeAdaptiveRuntime();
    deploymentRecoveryHandle.dispose();
    runtimeObserverHandle.dispose();
    performanceLifecycleHandle.dispose();
    webVitalsRegistration.stop();
    performanceMonitor.stop();
    root.unmount();
  });
}
