import React from 'react';
import { act, render, screen } from '@testing-library/react';
import App from './App';
import { bootstrapApplication } from './platform/bootstrap/bootstrapApplication';
import { configureArcgisModuleRuntime } from './gis-engine/arcgisModuleRuntime';

vi.mock('./platform/bootstrap/bootstrapApplication', () => ({
  bootstrapApplication: vi.fn()
}));

// CRA enables resetMocks, so lifecycle-independent collaborators use plain functions here.
// Otherwise Jest clears factory-provided vi.fn implementations before every test.
vi.mock('./platform/bootstrap/bootstrapCore', () => ({
  isBootstrapAbortError: (error) => error?.code === 'BOOTSTRAP_ABORTED'
}));

vi.mock('./Components/App/MapComponent', () => ({
  MapComponent: ({ windowManager }) => (
    <div data-testid="map-shell" data-manager-id={windowManager?.id || 'none'} />
  )
}));

vi.mock('./Components/Common/ExperienceUXLayer', () => ({
  ExperienceUXLayer: ({ windowManager }) => (
    <div data-testid="experience-layer" data-manager-id={windowManager?.id || 'none'} />
  )
}));

vi.mock('./Components/Common/ExperienceCommandCenter', () => ({
  ExperienceCommandCenter: ({ windowManager }) => (
    <div data-testid="command-center" data-manager-id={windowManager?.id || 'none'} />
  )
}));

vi.mock('./Components/Common/ExperienceCommandCenterModern', () => ({
  ExperienceCommandCenterModern: ({ windowManager }) => (
    <div data-testid="command-center" data-manager-id={windowManager?.id || 'none'} />
  )
}));

vi.mock('./Store/Managers/WindowManager', () => ({
  useWindowManager: () => ({ id: 'window-manager-1' })
}));

vi.mock('./gis-engine/arcgisModuleRuntime', () => ({ configureArcgisModuleRuntime: vi.fn() }));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('App bootstrap lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureArcgisModuleRuntime.mockReturnValue({ backend: 'arcgis-core-esm' });
    bootstrapApplication.mockImplementation(() => new Promise(() => {}));
  });

  test('configures ArcGIS and starts bootstrap once with a cancellation signal', () => {
    render(<App />);

    expect(configureArcgisModuleRuntime).toHaveBeenCalledTimes(1);
    expect(configureArcgisModuleRuntime).toHaveBeenCalledWith(expect.objectContaining({ version: '5.1.24', css: true }));
    expect(bootstrapApplication).toHaveBeenCalledTimes(1);
    expect(bootstrapApplication).toHaveBeenCalledWith({
      signal: expect.objectContaining({ aborted: false })
    });
  });

  test('renders the enterprise loading experience before GIS configuration resolves', () => {
    render(<App />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /kent rehberi hazırlanıyor/i })).toBeInTheDocument();
    expect(screen.getByText(/harita motoru, çalışma alanı ve güvenli uygulama yapılandırması yükleniyor/i)).toBeInTheDocument();
    expect(screen.queryByTestId('map-shell')).not.toBeInTheDocument();
    expect(screen.queryByTestId('experience-layer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('command-center')).not.toBeInTheDocument();
  });

  test('renders map, UX layer, command center and data disclaimer after bootstrap completes', async () => {
    const operation = deferred();
    bootstrapApplication.mockReturnValue(operation.promise);
    render(<App />);

    await act(async () => {
      operation.resolve({ status: 'completed' });
      await operation.promise;
    });

    expect(screen.getByTestId('map-shell')).toHaveAttribute('data-manager-id', 'window-manager-1');
    expect(screen.getByTestId('experience-layer')).toHaveAttribute('data-manager-id', 'window-manager-1');
    expect(screen.getByTestId('command-center')).toHaveAttribute('data-manager-id', 'window-manager-1');
    expect(screen.getByRole('note', { name: /veri kullanım uyarısı/i })).toHaveTextContent(
      'Sitede Gösterilen Veriler Bilgi Amaçlıdır. Resmî İşlemlerde KULLANILAMAZ!'
    );
    expect(screen.queryByRole('heading', { name: /kent rehberi hazırlanıyor/i })).not.toBeInTheDocument();
    expect(document.getElementById('experience-global-live-region')).toHaveAttribute('role', 'status');
  });

  test('renders the controlled error experience when bootstrap fails', async () => {
    const operation = deferred();
    bootstrapApplication.mockReturnValue(operation.promise);
    render(<App />);

    await act(async () => {
      operation.reject(new Error('network details that must not reach UI'));
      await expect(operation.promise).rejects.toThrow('network details that must not reach UI');
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/harita çalışma alanı güvenli biçimde başlatılamadı/i);
    expect(screen.getByRole('button', { name: /tekrar dene/i })).toBeInTheDocument();
    expect(screen.queryByText(/network details/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('map-shell')).not.toBeInTheDocument();
  });

  test('keeps the loading shell when an explicit bootstrap cancellation is reported', async () => {
    const operation = deferred();
    bootstrapApplication.mockReturnValue(operation.promise);
    render(<App />);

    await act(async () => {
      operation.reject(Object.assign(new Error('cancelled'), { code: 'BOOTSTRAP_ABORTED' }));
      await expect(operation.promise).rejects.toMatchObject({ code: 'BOOTSTRAP_ABORTED' });
    });

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText(/harita çalışma alanı güvenli biçimde başlatılamadı/i)).not.toBeInTheDocument();
  });

  test('aborts the active bootstrap operation when the application unmounts', () => {
    const { unmount } = render(<App />);
    const signal = bootstrapApplication.mock.calls[0][0].signal;
    expect(signal.aborted).toBe(false);

    unmount();
    expect(signal.aborted).toBe(true);
  });

  test('does not render application content after an operation resolves post-unmount', async () => {
    const operation = deferred();
    bootstrapApplication.mockReturnValue(operation.promise);
    const { unmount } = render(<App />);
    unmount();

    await act(async () => {
      operation.resolve({ status: 'completed' });
      await operation.promise;
    });

    expect(screen.queryByTestId('map-shell')).not.toBeInTheDocument();
  });

  test('does not render an error after an operation rejects post-unmount', async () => {
    const operation = deferred();
    bootstrapApplication.mockReturnValue(operation.promise);
    const { unmount } = render(<App />);
    unmount();

    await act(async () => {
      operation.reject(new Error('late failure'));
      await expect(operation.promise).rejects.toThrow('late failure');
    });

    expect(screen.queryByText(/harita çalışma alanı güvenli biçimde başlatılamadı/i)).not.toBeInTheDocument();
  });
});
