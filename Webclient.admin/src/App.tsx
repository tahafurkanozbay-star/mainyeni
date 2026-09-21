import { lazy, Suspense, useState } from 'react';

import './App.css';
import { FullScreenLoading } from './Components/Loading';
import { readAdminSession } from './runtime/adminSession';

const LoginPage = lazy(async () => ({
  default: (await import('./Pages/Auth/LoginPage')).LoginPage,
}));

const AdminAuthenticatedShell = lazy(async () => ({
  default: (await import('./Components/AdminAuthenticatedShell')).AdminAuthenticatedShell,
}));

type BootstrapSurface = 'login' | 'authenticated';

const resolveBootstrapSurface = (): BootstrapSurface =>
  readAdminSession() ? 'authenticated' : 'login';

function App() {
  const [surface] = useState<BootstrapSurface>(resolveBootstrapSurface);

  return (
    <Suspense
      fallback={<FullScreenLoading text="Yönetim uygulaması yükleniyor" />}
    >
      {surface === 'authenticated'
        ? <AdminAuthenticatedShell />
        : <LoginPage />}
    </Suspense>
  );
}

export default App;
