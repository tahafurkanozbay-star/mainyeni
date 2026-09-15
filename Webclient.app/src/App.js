import React, { useEffect, useState } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import './bootstrap-overrides.css';
import './styles.css';
import './styles.responsive.css';
import { MapComponent } from './Components/App/MapComponent';
import { Constants_LoadingStatus } from './Core/Constants';
import { AppConfig } from './Core/AppConfig';
import { WindowManager } from './Store/Managers/WindowManager';
import { ConfigurationBusiness } from "./Business/ConfigurationBusiness";
import MapManager from './Store/Managers/MapManager';
import { FullScreenLoading } from './Components/Common/Loading';
import { FullScreenError } from './Components/Common/Error';
import { CommonBusiness } from './Business/CommonBusiness';
import { setDefaultOptions } from 'esri-loader';
import { ExperienceUXLayer } from './Components/Common/ExperienceUXLayer';
import './Components/Common/experience-ui.css';

function App() {
  const windowManager = WindowManager();
  const [configLoadStatus, setConfigLoadStatus] = useState(Constants_LoadingStatus.LOADING);

  setDefaultOptions({ version: AppConfig.App.EsriApiVersion });

  useEffect(() => {
    let cancelled = false;
    const promises = [
      ConfigurationBusiness.GetMapConfiguration(),
      ConfigurationBusiness.GetConfigServices()
    ];

    Promise.all(promises).then((_results) => {
      if (cancelled) return;
      const mapConfigResult = _results[0];
      const configServicesResult = _results[1];

      if (mapConfigResult.isSuccess && configServicesResult.isSuccess) {
        MapManager.SetMapConfiguration(JSON.parse(mapConfigResult.data.configValue));
        const configServices = configServicesResult.data;
        configServices.forEach(service => {
          CommonBusiness.AddProxyRule(CommonBusiness.GenerateUrl(service), "Appjs");
        });
        MapManager.SetConfigurationServices(configServices);
        setConfigLoadStatus(Constants_LoadingStatus.COMPLETED);
      } else {
        setConfigLoadStatus(Constants_LoadingStatus.ERROR);
      }
    }).catch(() => {
      if (!cancelled) setConfigLoadStatus(Constants_LoadingStatus.ERROR);
    });

    return () => { cancelled = true; };
  }, []);

  return (
    <div id="root">
      {
        configLoadStatus === Constants_LoadingStatus.LOADING ? <FullScreenLoading /> :
          configLoadStatus === Constants_LoadingStatus.ERROR ? <FullScreenError /> :
            <>
              <MapComponent windowManager={windowManager} />
              <ExperienceUXLayer />
            </>
      }
    </div>
  );
}

export default App;
