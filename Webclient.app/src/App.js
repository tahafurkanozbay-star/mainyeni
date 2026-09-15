import React, { useEffect, useMemo, useState } from 'react';
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
import { WindowManager } from './Store/Managers/WindowManager';
import { FullScreenLoading } from './Components/Common/Loading';
import { FullScreenError } from './Components/Common/Error';
import { setDefaultOptions } from 'esri-loader';
import { ExperienceUXLayer } from './Components/Common/ExperienceUXLayer';
import { ExperienceCommandCenter } from './Components/Common/ExperienceCommandCenter';
import { ExperienceThemeProvider } from './Components/Common/ExperienceDesignSystem';
import { bootstrapApplication } from './platform/bootstrap/bootstrapApplication';
import { isBootstrapAbortError } from './platform/bootstrap/bootstrapCore';

setDefaultOptions({ version: AppConfig.App.EsriApiVersion });

function App() {
  const windowManager = useMemo(() => new WindowManager(), []);
  const [configLoadStatus, setConfigLoadStatus] = useState(Constants_LoadingStatus.LOADING);

  useEffect(() => {
    const controller = new AbortController();

    bootstrapApplication({ signal: controller.signal })
      .then(() => {
        if (!controller.signal.aborted) {
          setConfigLoadStatus(Constants_LoadingStatus.COMPLETED);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted && !isBootstrapAbortError(error)) {
          setConfigLoadStatus(Constants_LoadingStatus.ERROR);
        }
      });

    return () => controller.abort();
  }, []);

  return (
    <ExperienceThemeProvider>
      <div id="root">
        {configLoadStatus === Constants_LoadingStatus.LOADING ? <FullScreenLoading /> :
          configLoadStatus === Constants_LoadingStatus.ERROR ? <FullScreenError message="Harita yapılandırması yüklenemedi. Lütfen bağlantınızı kontrol edip sayfayı yenileyin." /> :
            <>
              <MapComponent windowManager={windowManager} />
              <ExperienceUXLayer windowManager={windowManager} />
              <ExperienceCommandCenter windowManager={windowManager} />
            </>}
      </div>
    </ExperienceThemeProvider>
  );
}

export default App;
