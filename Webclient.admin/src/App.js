import './App.css';
import { NavMenu } from './Shared/NavMenu';
import { BrowserRouter as Router, Switch, Route, HashRouter } from 'react-router-dom';
import { HomePage } from './Pages/Home/HomePage';
import { Page404 } from './Shared/Page404';
import { MapSettingsPage } from './Pages/MapSettings/MapSettingsPage';
import { ConfigServicesPage } from './Pages/ConfigServices/ConfigServicesPage';
import { BasemapLayersPage } from './Pages/BasemapLayers/BasemapLayersPage';
import { LayersPage } from './Pages/Layers/LayersPage';
import { useEffect, useState } from 'react';
import { AuthBusiness } from './Business/AuthBusiness';
import { LoginPage } from './Pages/Auth/LoginPage';
import { TakbisSettingsPage } from './Pages/TakbisSettings/TakbisSettingsPage';
import { Constants } from './Core/Constants';
import { FullScreenLoading } from './Components/Loading';
import { SystemLogsPage } from './Pages/System/SystemLogsPage';
import axios from 'axios';

function App() {

  const [sessionStatus, setSessionStatus] = useState(Constants.SessionStatus.UNDECIDED);

  useEffect(() => {
    
    var session = AuthBusiness.GetSessionFromLocalStorage();
    
    if (session == null) {
      setSessionStatus(Constants.SessionStatus.NOT_EXISTS);
    }
    else {
      setSessionStatus(Constants.SessionStatus.EXISTS);
    }

    return (() => {
      console.log("Appjs destructor")
    });

  }, [window.location.pathname]);

  return (<>
    {
      sessionStatus == Constants.SessionStatus.UNDECIDED ? <FullScreenLoading></FullScreenLoading>
        : sessionStatus == Constants.SessionStatus.NOT_EXISTS ? <LoginPage></LoginPage>
          : <HashRouter>

            <NavMenu></NavMenu>
            <div className='container'>

              <div className='row'>
                <div className='col-12'>
                  <Switch>

                    <Route path="/" exact component={HomePage} />

                    <Route path="/mapconfig" exact component={MapSettingsPage} />
                    <Route path="/configservices" exact component={ConfigServicesPage} />
                    <Route path="/takbisconfig" exact component={TakbisSettingsPage} />

                    <Route path="/layers" exact component={LayersPage} />
                    <Route path="/basemaps" exact component={BasemapLayersPage} />

                    <Route path="/syslogs" exact component={SystemLogsPage} />

                    <Route path="*">
                      <Page404 />
                    </Route>
                  </Switch>
                </div>
              </div>
            </div>
          </HashRouter>
    }

  </>

  );
}

export default App;

