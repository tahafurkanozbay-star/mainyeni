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

function App() {

  const windowManager = new WindowManager();

  const [configLoadStatus, setConfigLoadStatus] = useState(Constants_LoadingStatus.LOADING);


  setDefaultOptions({ version: AppConfig.App.EsriApiVersion })

  useEffect(() => {


    let promises = [];

    promises.push(ConfigurationBusiness.GetMapConfiguration());
    promises.push(ConfigurationBusiness.GetConfigServices());

    Promise.all(promises).then((_results) => {

      let mapConfigResult = _results[0];
      let configServicesResult = _results[1];

      if (mapConfigResult.isSuccess && configServicesResult.isSuccess) {

        MapManager.SetMapConfiguration(JSON.parse(mapConfigResult.data.configValue));

        let configServices = configServicesResult.data;
        configServices.forEach(service => {
          CommonBusiness.AddProxyRule(CommonBusiness.GenerateUrl(service),"Appjs");
        });

        MapManager.SetConfigurationServices(configServices);

        setConfigLoadStatus(Constants_LoadingStatus.COMPLETED);
      }
      else {
        setConfigLoadStatus(Constants_LoadingStatus.ERROR);
      }

    });

  }, []);

  return (
    <div id="root">

      {
        configLoadStatus == Constants_LoadingStatus.LOADING ? <FullScreenLoading /> :
          configLoadStatus == Constants_LoadingStatus.ERROR ? <FullScreenError /> :
            <>
                <MapComponent windowManager={windowManager} />
            </>
      }
    </div>
  );
}

export default App;