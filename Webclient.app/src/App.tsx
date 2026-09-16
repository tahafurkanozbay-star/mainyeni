import { useEffect, useState } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import './bootstrap-overrides.css';
import './styles.css';
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

function App() {
  const windowManager = useWindowManager();
  const [configLoadStatus, setConfigLoadStatus] = useState(Constants_LoadingStatus.LOADING);

  useEffect(() => {
    setDefaultOptions({ version: AppConfig.App.EsriApiVersion });
    const controller = new AbortController();
    const startedAt = performance.now();

    runtimeDiagnostics.record('app.bootstrap.started', {
      esriApiVersion: AppConfig.App.EsriApiVersion,
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
        runtimeDiagnostics.captureError(error, {
          source: 'app.bootstrap',
          durationMs: Math.round(performance.now() - startedAt),
        });
        setConfigLoadStatus(Constants_LoadingStatus.ERROR);
      });

    return () => controller.abort();
  }, []);

  return (
    <ExperienceThemeProvider>
      <div id="app-shell">
        {configLoadStatus === Constants_LoadingStatus.LOADING ? <FullScreenLoading /> :
          configLoadStatus === Constants_LoadingStatus.ERROR ? <FullScreenError message="Harita yapılandırması yüklenemedi. Lütfen bağlantınızı kontrol edip sayfayı yenileyin." /> :
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
