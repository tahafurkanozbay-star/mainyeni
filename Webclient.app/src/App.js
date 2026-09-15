import React, { useEffect, useState } from 'react';
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
import { ConfigurationBusiness } from './Business/ConfigurationBusiness';
import MapManager from './Store/Managers/MapManager';
import { FullScreenLoading } from './Components/Common/Loading';
import { FullScreenError } from './Components/Common/Error';
import { CommonBusiness } from './Business/CommonBusiness';
import { setDefaultOptions } from 'esri-loader';
import { ExperienceUXLayer } from './Components/Common/ExperienceUXLayer';
import { ExperienceCommandCenter } from './Components/Common/ExperienceCommandCenter';
import { ExperienceThemeProvider } from './Components/Common/ExperienceDesignSystem';

function App() {
  const windowManager = new WindowManager();
  const [configLoadStatus, setConfigLoadStatus] = useState(Constants_LoadingStatus.LOADING);

  setDefaultOptions({ version: AppConfig.App.EsriApiVersion });

  useEffect(() => {
    let cancelled = false;
    const loadConfiguration = async () => {
      try {
        const [mapConfigResult, configServicesResult] = await Promise.all([
          ConfigurationBusiness.GetMapConfiguration(),
          ConfigurationBusiness.GetConfigServices()
        ]);
        if (cancelled) return;
        if (mapConfigResult.isSuccess && configServicesResult.isSuccess) {
          MapManager.SetMapConfiguration(JSON.parse(mapConfigResult.data.configValue));
          const configServices = configServicesResult.data || [];
          configServices.forEach(service => CommonBusiness.AddProxyRule(CommonBusiness.GenerateUrl(service), "Appjs"));
          MapManager.SetConfigurationServices(configServices);
          setConfigLoadStatus(Constants_LoadingStatus.COMPLETED);
        } else {
          setConfigLoadStatus(Constants_LoadingStatus.ERROR);
        }
      } catch (error) {
        if (!cancelled) setConfigLoadStatus(Constants_LoadingStatus.ERROR);
      }
    };
    loadConfiguration();
    return () => { cancelled = true; };
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
