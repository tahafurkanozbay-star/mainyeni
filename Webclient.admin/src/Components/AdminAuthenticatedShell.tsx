import { lazy, Suspense } from 'react';
import { HashRouter, Route, Routes } from 'react-router';

import { AdminRouteBoundary } from './AdminRouteBoundary';
import { ContainerLoading } from './Loading';
import { HomePage } from '../Pages/Home/HomePage';
import { NavMenu } from '../Shared/NavMenu';
import { Page404 } from '../Shared/Page404';

const MapSettingsPage = lazy(async () => ({
  default: (await import('../Pages/MapSettings/MapSettingsPage')).MapSettingsPage,
}));
const ConfigServicesPage = lazy(async () => ({
  default: (await import('../Pages/ConfigServices/ConfigServicesPage')).ConfigServicesPage,
}));
const TakbisSettingsPage = lazy(async () => ({
  default: (await import('../Pages/TakbisSettings/TakbisSettingsPage')).TakbisSettingsPage,
}));
const LayersPage = lazy(async () => ({
  default: (await import('../Pages/Layers/LayersPage')).LayersPage,
}));
const BasemapLayersPage = lazy(async () => ({
  default: (await import('../Pages/BasemapLayers/BasemapLayersPage')).BasemapLayersPage,
}));
const SystemLogsPage = lazy(async () => ({
  default: (await import('../Pages/System/SystemLogsPage')).SystemLogsPage,
}));

const LazyRouteFallback = () => (
  <ContainerLoading text="Yönetim modülü yükleniyor" />
);

export const AdminAuthenticatedShell = () => (
  <HashRouter>
    <NavMenu />
    <main className="container" id="admin-main-content">
      <div className="row">
        <div className="col-12">
          <AdminRouteBoundary>
            <Suspense fallback={<LazyRouteFallback />}>
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
            </Suspense>
          </AdminRouteBoundary>
        </div>
      </div>
    </main>
  </HashRouter>
);
