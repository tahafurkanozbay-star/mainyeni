import React, { useEffect, useState } from 'react';
import axios from 'axios';
import 'bootstrap/dist/css/bootstrap.min.css';
import './bootstrap-overrides.css';
import './styles.css';
import './styles.responsive.css';
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
import './Components/Common/experience-ui.css';

function App() {
  const [windowManager] = useState(() => new WindowManager());
  const [configLoadStatus, setConfigLoadStatus] = useState(Constants_LoadingStatus.LOADING);

  setDefaultOptions({ version: AppConfig.App.EsriApiVersion });

  useEffect(() => {
    const cancelSource = axios.CancelToken.source();
    let active = true;

    Promise.all([
      ConfigurationBusiness.GetMapConfiguration({ cancelToken: cancelSource.token, cache: true, dedupe: true }),
      ConfigurationBusiness.GetConfigServices({ cancelToken: cancelSource.token, cache: true, dedupe: true })
    ])
      .then(([mapConfigResult, configServicesResult]) => {
        if (!active) return;
        if (!mapConfigResult?.isSuccess || !configServicesResult?.isSuccess) {
          setConfigLoadStatus(Constants_LoadingStatus.ERROR);
          return;
        }

        try {
          MapManager.SetMapConfiguration(JSON.parse(mapConfigResult.data.configValue));
          const configServices = Array.isArray(configServicesResult.data) ? configServicesResult.data : [];
          configServices.forEach((service) => {
            const serviceUrl = CommonBusiness.GenerateUrl(service);
            if (serviceUrl) CommonBusiness.AddProxyRule(serviceUrl, 'Appjs');
          });
          MapManager.SetConfigurationServices(configServices);
          setConfigLoadStatus(Constants_LoadingStatus.COMPLETED);
        } catch (error) {
          setConfigLoadStatus(Constants_LoadingStatus.ERROR);
        }
      })
      .catch((error) => {
        if (!active || axios.isCancel(error)) return;
        setConfigLoadStatus(Constants_LoadingStatus.ERROR);
      });

    return () => {
      active = false;
      cancelSource.cancel('Application bootstrap cancelled');
    };
  }, []);

  return (
    <div id="root">
      {configLoadStatus === Constants_LoadingStatus.LOADING ? <FullScreenLoading /> :
        configLoadStatus === Constants_LoadingStatus.ERROR ? <FullScreenError /> :
          <>
            <MapComponent windowManager={windowManager} />
            <ExperienceUXLayer />
          </>}
    </div>
  );
}

export default App;
