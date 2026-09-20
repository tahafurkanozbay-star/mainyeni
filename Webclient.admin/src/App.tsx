import { useEffect, useState } from "react";
import { HashRouter, Route, Switch } from "react-router-dom";
import "./App.css";
import { AdminErrorBoundary } from "./Components/AdminErrorBoundary";
import { FullScreenLoading } from "./Components/Loading";
import { Constants, type SessionStatus } from "./Core/Constants";
import { BasemapLayersPage } from "./Pages/BasemapLayers/BasemapLayersPage";
import { ConfigServicesPage } from "./Pages/ConfigServices/ConfigServicesPage";
import { HomePage } from "./Pages/Home/HomePage";
import { LayersPage } from "./Pages/Layers/LayersPage";
import { LoginPage } from "./Pages/Auth/LoginPage";
import { MapSettingsPage } from "./Pages/MapSettings/MapSettingsPage";
import { SystemLogsPage } from "./Pages/System/SystemLogsPage";
import { TakbisSettingsPage } from "./Pages/TakbisSettings/TakbisSettingsPage";
import { SharedPage404 } from "./Shared/SharedPage404";
import { NavMenu } from "./Shared/NavMenu";
import { authSessionStore } from "./platform/authSession";
import { getAdminRoute } from "./platform/routeManifest";

function App() {
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>(
    Constants.SessionStatus.UNDECIDED,
  );

  useEffect(() => {
    const refresh = (): void => {
      setSessionStatus(
        authSessionStore.read()
          ? Constants.SessionStatus.EXISTS
          : Constants.SessionStatus.NOT_EXISTS,
      );
    };
    refresh();
    return authSessionStore.subscribe((snapshot) => {
      setSessionStatus(
        snapshot.authenticated
          ? Constants.SessionStatus.EXISTS
          : Constants.SessionStatus.NOT_EXISTS,
      );
    });
  }, []);

  if (sessionStatus === Constants.SessionStatus.UNDECIDED) {
    return <FullScreenLoading />;
  }
  if (sessionStatus === Constants.SessionStatus.NOT_EXISTS) {
    return <LoginPage />;
  }

  return (
    <AdminErrorBoundary>
      <HashRouter>
        <NavMenu />
        <div className="container">
          <div className="row">
            <div className="col-12">
              <Switch>
                <Route path={getAdminRoute("home").path} exact component={HomePage} />
                <Route path={getAdminRoute("map-config").path} exact component={MapSettingsPage} />
                <Route path={getAdminRoute("config-services").path} exact component={ConfigServicesPage} />
                <Route path={getAdminRoute("takbis-config").path} exact component={TakbisSettingsPage} />
                <Route path={getAdminRoute("layers").path} exact component={LayersPage} />
                <Route path={getAdminRoute("basemaps").path} exact component={BasemapLayersPage} />
                <Route path={getAdminRoute("system-logs").path} exact component={SystemLogsPage} />
                <Route path="*">
                  <SharedPage404 />
                </Route>
              </Switch>
            </div>
          </div>
        </div>
      </HashRouter>
    </AdminErrorBoundary>
  );
}

export default App;
