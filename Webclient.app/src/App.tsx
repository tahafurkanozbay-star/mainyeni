import { useCallback, useEffect, useMemo, useState } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import './bootstrap-overrides.css';
import './styles.responsive.css';
import './Components/Common/experience-ui.css';
import './Components/Common/experience-quality.css';
import './Components/Common/experience-shell.css';
import './Components/Common/experience-data-ux.css';
import './experience/legacyPresentationModernization.css';
import { MapComponent } from './Components/App/MapComponent';
import { AppConfig } from './Core/AppConfig';
import { useWindowManager } from './Store/Managers/WindowManager';
import { ExperienceConnectivityNotice } from './Components/Common/ExperienceConnectivityNotice';
import { ExperienceUXLayer } from './Components/Common/ExperienceUXLayer';
import { ExperienceCommandCenterModern as ExperienceCommandCenter } from './Components/Common/ExperienceCommandCenterModern';
import { ExperienceThemeProvider } from './Components/Common/ExperienceDesignSystem';
import { ExperienceWorkspace } from './Components/Common/ExperienceWorkspace';
import { ExperienceRuntimeBridge } from './Components/Common/ExperienceRuntimeBridge';
import { ExperienceStartupBoundary } from './Components/Common/ExperienceStartupBoundary';
import { createStartupExperienceModel } from './experience/startupExperienceModel';
import { configureArcgisModuleRuntime } from './gis-engine/arcgisModuleRuntime';
import { bootstrapApplication } from './platform/bootstrap/bootstrapApplication';
import { isBootstrapAbortError } from './platform/bootstrap/bootstrapCore';
import { runtimeDiagnostics } from './platform/runtime/runtimeDiagnostics';
import { DebugHelper } from './Toolbox/DebugHelper';

const bootstrapErrorCode = (error: unknown): string | null => {
  if (!(error instanceof Error)) return null;
  const diagnostic = error as Error & { code?: unknown };
  if (typeof diagnostic.code !== 'string') return null;
  const normalized = diagnostic.code.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,48}$/.test(normalized) ? normalized : null;
};

const describeBootstrapError = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return 'Harita yapılandırması yüklenemedi. Bağlantınızı kontrol edip tekrar deneyin.';
  }

  return 'Harita çalışma alanı güvenli biçimde başlatılamadı. Bağlantınızı kontrol edip tekrar deneyin.';
};

const SiteDataDisclaimer = () => (
  <aside
    aria-label="Veri kullanım uyarısı"
    className="position-fixed start-50 translate-middle-x px-3 py-2 rounded-3 border shadow-sm text-center fw-semibold"
    role="note"
    style={{
      bottom: 'calc(8px + env(safe-area-inset-bottom))',
      zIndex: 1004,
      maxWidth: 'calc(100vw - 24px)',
      width: 'max-content',
      pointerEvents: 'none',
      backgroundColor: 'var(--exp-surface)',
      borderColor: 'var(--exp-border)',
      color: 'var(--exp-text)',
      fontSize: '0.78rem',
      lineHeight: 1.35,
    }}
  >
    Sitede Gösterilen Veriler Bilgi Amaçlıdır. Resmî İşlemlerde <strong>KULLANILAMAZ!</strong>
  </aside>
);

function App() {
  const windowManager = useWindowManager();
  const [bootstrapGeneration, setBootstrapGeneration] = useState(0);
  const startupModel = useMemo(() => createStartupExperienceModel({
    delayedAfterMs: 7_000,
    maxAttempts: 4,
    initialOnline: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
    onObserverError(error) {
      runtimeDiagnostics.captureError(error, {
        source: 'app.startup-experience.observer',
      }, 'warn');
    },
  }), []);

  useEffect(() => {
    startupModel.beginAttempt();

    const arcgisRuntime = configureArcgisModuleRuntime({
      version: AppConfig.App.EsriApiVersion,
      css: true,
      insertCssBefore: 'link[rel="stylesheet"]',
    });

    const controller = new AbortController();
    const startedAt = performance.now();
    const attempt = startupModel.snapshot().attempt;

    runtimeDiagnostics.record('app.bootstrap.started', {
      attempt,
      esriApiVersion: AppConfig.App.EsriApiVersion,
      arcgisModuleBackend: arcgisRuntime.backend,
      esriStylesheet: 'managed-by-arcgis-module-runtime',
    });

    bootstrapApplication({ signal: controller.signal })
      .then(() => {
        if (controller.signal.aborted) return;
        const durationMs = Math.round(performance.now() - startedAt);
        runtimeDiagnostics.record('app.bootstrap.completed', {
          attempt,
          durationMs,
        });
        startupModel.succeed();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isBootstrapAbortError(error)) return;
        const durationMs = Math.round(performance.now() - startedAt);
        DebugHelper.Log(error);
        runtimeDiagnostics.captureError(error, {
          source: 'app.bootstrap',
          attempt,
          durationMs,
        });
        startupModel.fail({
          message: describeBootstrapError(error),
          code: bootstrapErrorCode(error),
          retryable: true,
        });
      });

    return () => controller.abort();
  }, [bootstrapGeneration, startupModel]);

  const retryBootstrap = useCallback((): void => {
    if (!startupModel.snapshot().canRetry) return;
    setBootstrapGeneration((generation) => generation + 1);
  }, [startupModel]);

  return (
    <ExperienceThemeProvider>
      <ExperienceRuntimeBridge />
      <div id="app-shell">
        <ExperienceStartupBoundary
          model={startupModel}
          onRetry={retryBootstrap}
        >
          <MapComponent windowManager={windowManager} />
          <ExperienceWorkspace />
          <ExperienceUXLayer windowManager={windowManager} />
          <ExperienceCommandCenter windowManager={windowManager} />
          <ExperienceConnectivityNotice />
          <SiteDataDisclaimer />
        </ExperienceStartupBoundary>
      </div>
    </ExperienceThemeProvider>
  );
}

export default App;
