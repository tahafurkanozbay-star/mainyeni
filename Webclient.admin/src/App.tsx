import { useEffect, useState } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';

import './App.css';
import { AuthBusiness } from './Business/AuthBusiness';
import { FullScreenLoading } from './Components/Loading';
import { Constants } from './Core/Constants';
import { BasemapLayersPage } from './Pages/BasemapLayers/BasemapLayersPage';
import { ConfigServicesPage } from './Pages/ConfigServices/ConfigServicesPage';
import { HomePage } from './Pages/Home/HomePage';
import { LayersPage } from './Pages/Layers/LayersPage';
import { LoginPage } from './Pages/Auth/LoginPage';
import { MapSettingsPage } from './Pages/MapSettings/MapSettingsPage';
import { SystemLogsPage } from './Pages/System/SystemLogsPage';
import { TakbisSettingsPage } from './Pages/TakbisSettings/TakbisSettingsPage';
import { NavMenu } from './Shared/NavMenu';
import { Page404 } from './Shared/Page404';

type SessionStatus = typeof Constants.SessionStatus[keyof typeof Constants.SessionStatus];

const readSessionStatus = (): SessionStatus =>
  AuthBusiness.GetSessionFromLocalStorage()
    ? Constants.SessionStatus.EXISTS
    : Constants.SessionStatus.NOT_EXISTS;

const AdminRoutes = () => (
  <HashRouter>
    <NavMenu />
    <main className="container" id="admin-main-content">
      <div className="row">
        <div className="col-12">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/mapconfig" element={<MapSettingsPage />} />
            <Route path="/configservices" element={<ConfigServicesPage />} />
            <Route path="/takbisconfig" element={<TakbisSettingsPage />} />
            <Route path="/layers" element={<LayersPage />} />
            <Route path="/basemaps" element={<BasemapLayersPage />} />
            <Route path="/syslogs" element={<SystemLogsPage />} />
            <Route path="*" element={<Page404 />} />
          </Routes>
        </div>
      </div>
    </main>
  </HashRouter>
);

function App() {
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>(
    Constants.SessionStatus.UNDECIDED,
  );

  useEffect(() => {
    setSessionStatus(readSessionStatus());
  }, []);

  if (sessionStatus === Constants.SessionStatus.UNDECIDED) {
    return <FullScreenLoading />;
  }

  if (sessionStatus === Constants.SessionStatus.NOT_EXISTS) {
    return <LoginPage />;
  }

  return <AdminRoutes />;
}

export default App;
