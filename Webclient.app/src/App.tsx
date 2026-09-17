import { useEffect, useState } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import './bootstrap-overrides.css';
import './styles.responsive.css';
import './Components/Common/experience-ui.css';
import './Components/Common/experience-quality.css';
import './Components/Common/experience-shell.css';
import './Components/Common/experience-data-ux.css';
import { MapComponent } from './Components/App/MapComponent';
import { Constants_LoadingStatus } from './Core/Constants';
import { AppConfig } from './Core/AppConfig';
import { useWindowManager } from './Store/Managers/WindowManager';
import { FullScreenLoading } from './Components/Common/Loading';
import { FullScreenError } from './Components/Common/Error';
import { setDefaultOptions } from 'esri-loader';
import { ExperienceUXLayer } from './Components/Common/ExperienceUXLayer';
import { ExperienceCommandCenter } from './Components/Common/ExperienceCommandCenter';
import { ExperienceThemeProvider } from './Components/Common/ExperienceDesignSystem';
import { ExperienceWorkspace } from './Components/Common/ExperienceWorkspace';
import { bootstrapApplication } from './platform/bootstrap/bootstrapApplication';
import { isBootstrapAbortError } from './platform/bootstrap/bootstrapCore';
import { runtimeDiagnostics } from './platform/runtime/runtimeDiagnostics';
import { DebugHelper } from './Toolbox/DebugHelper';

const describeBootstrapError = (error: unknown): string => {
  if (!(error instanceof Error)) return 'Harita yapılandırması yüklenemedi.';
  if (!import.meta.env.DEV) return error.message;

  const diagnostic = error as Error & { code?: unknown; cause?: unknown };
  const code = diagnostic.code ? ` [${String(diagnostic.code)}]` : '';
  const cause = diagnostic.cause instanceof Error && diagnostic.cause.message
    ? ` — ${diagnostic.cause.message}`
    : '';
  const source = diagnostic.cause instanceof Error && diagnostic.cause.stack
    ? ` (${diagnostic.cause.stack.split('\n')[1]?.trim() || ''})`
    : '';
  return `${diagnostic.message}${code}${cause}${source}`;
};

function App() {
  const windowManager = useWindowManager();
  const [configLoadStatus, setConfigLoadStatus] = useState(Constants_LoadingStatus.LOADING);
  const [configErrorMessage, setConfigErrorMessage] = useState('');

  useEffect(() => {
    // esri-loader must own both SDK script and stylesheet resolution. Keeping the
    // version in one runtime contract prevents a 4.x JavaScript/CSS mismatch and
    // avoids an unconditional ArcGIS stylesheet request before configuration is ready.
    setDefaultOptions({
      version: AppConfig.App.EsriApiVersion,
      css: true,
      insertCssBefore: 'link[rel="stylesheet"]',
    });

    const controller = new AbortController();
    const startedAt = performance.now();

    runtimeDiagnostics.record('app.bootstrap.started', {
      esriApiVersion: AppConfig.App.EsriApiVersion,
      esriStylesheet: 'managed-by-esri-loader',
    });

    bootstrapApplication({ signal: controller.signal })
      .then(() => {
        if (controller.signal.aborted) return;
        runtimeDiagnostics.record('app.bootstrap.completed', {
          durationMs: Math.round(performance.now() - startedAt),
        });
        setConfigLoadStatus(Constants_LoadingStatus.COMPLETED);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isBootstrapAbortError(error)) return;
        DebugHelper.Log(error);
        runtimeDiagnostics.captureError(error, {
          source: 'app.bootstrap',
          durationMs: Math.round(performance.now() - startedAt),
        });
        setConfigErrorMessage(describeBootstrapError(error));
        setConfigLoadStatus(Constants_LoadingStatus.ERROR);
      });

    return () => controller.abort();
  }, []);

  return (
    <ExperienceThemeProvider>
      <div id="app-shell">
        {configLoadStatus === Constants_LoadingStatus.LOADING ? <FullScreenLoading /> :
          configLoadStatus === Constants_LoadingStatus.ERROR ? <FullScreenError message={configErrorMessage || "Harita yapılandırması yüklenemedi. Lütfen bağlantınızı kontrol edip sayfayı yenileyin."} /> :
            <>
              <MapComponent windowManager={windowManager} />
              <ExperienceWorkspace />
              <ExperienceUXLayer windowManager={windowManager} />
              <ExperienceCommandCenter windowManager={windowManager} />
            </>}
      </div>
    </ExperienceThemeProvider>
  );
}

export default App;
