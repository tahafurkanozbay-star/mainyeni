import React from 'react';
import { act, render, screen } from '@testing-library/react';
import App from './App';
import { bootstrapApplication } from './platform/bootstrap/bootstrapApplication';
import { WindowManager } from './Store/Managers/WindowManager';

jest.mock('./platform/bootstrap/bootstrapApplication', () => ({
  bootstrapApplication: jest.fn()
}));

jest.mock('./platform/bootstrap/bootstrapCore', () => ({
  isBootstrapAbortError: (error) => Boolean(
    error && (error.code === 'BOOTSTRAP_ABORTED' || error.name === 'AbortError')
  )
}));

jest.mock('./Components/App/MapComponent', () => ({
  MapComponent: () => <div data-testid="map-shell" />
}));

jest.mock('./Components/Common/ExperienceUXLayer', () => ({
  ExperienceUXLayer: () => <div data-testid="experience-layer" />
}));

jest.mock('./Components/Common/ExperienceCommandCenter', () => ({
  ExperienceCommandCenter: () => <div data-testid="command-center" />
}));

jest.mock('./Store/Managers/WindowManager', () => ({
  WindowManager: jest.fn(function MockWindowManager() {})
}));

jest.mock('esri-loader', () => ({ setDefaultOptions: jest.fn() }));

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
    bootstrapApplication.mockReset();
    WindowManager.mockClear();
    bootstrapApplication.mockImplementation(() => new Promise(() => {}));
  });

  test('renders the enterprise loading experience before GIS configuration resolves', () => {
    render(<App />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/lütfen bekleyin/i)).toBeInTheDocument();
    expect(screen.queryByTestId('map-shell')).not.toBeInTheDocument();
    expect(screen.queryByTestId('experience-layer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('command-center')).not.toBeInTheDocument();
  });

  test('starts bootstrap exactly once with a cancellation signal', () => {
    render(<App />);
    expect(bootstrapApplication).toHaveBeenCalledTimes(1);
    expect(bootstrapApplication).toHaveBeenCalledWith({
      signal: expect.objectContaining({ aborted: false })
    });
  });

  test('renders map, UX layer and command center after bootstrap completes', async () => {
    const operation = deferred();
    bootstrapApplication.mockReturnValue(operation.promise);
    render(<App />);

    await act(async () => {
      operation.resolve({ status: 'completed' });
      await operation.promise;
    });

    expect(screen.getByTestId('map-shell')).toBeInTheDocument();
    expect(screen.getByTestId('experience-layer')).toBeInTheDocument();
    expect(screen.getByTestId('command-center')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('constructs WindowManager once while rendering all experience surfaces', async () => {
    bootstrapApplication.mockResolvedValue({ status: 'completed' });

    await act(async () => {
      render(<App />);
    });

    expect(WindowManager).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('map-shell')).toBeInTheDocument();
    expect(screen.getByTestId('experience-layer')).toBeInTheDocument();
    expect(screen.getByTestId('command-center')).toBeInTheDocument();
  });

  test('renders the controlled error experience when bootstrap fails', async () => {
    const operation = deferred();
    bootstrapApplication.mockReturnValue(operation.promise);
    render(<App />);

    await act(async () => {
      operation.reject(new Error('network details that must not reach UI'));
      try {
        await operation.promise;
      } catch (_error) {
        // App owns the rejection; the await only drains the deferred promise for React act.
      }
    });

    expect(screen.getByText(/harita yapılandırması yüklenemedi/i)).toBeInTheDocument();
    expect(screen.queryByText(/network details/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('map-shell')).not.toBeInTheDocument();
  });

  test('keeps the loading shell when an explicit bootstrap cancellation is reported', async () => {
    const operation = deferred();
    bootstrapApplication.mockReturnValue(operation.promise);
    render(<App />);

    await act(async () => {
      operation.reject(Object.assign(new Error('cancelled'), { code: 'BOOTSTRAP_ABORTED' }));
      try {
        await operation.promise;
      } catch (_error) {
        // Expected cancellation.
      }
    });

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText(/harita yapılandırması yüklenemedi/i)).not.toBeInTheDocument();
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
      try {
        await operation.promise;
      } catch (_error) {
        // Expected rejection after unmount.
      }
    });

    expect(screen.queryByText(/harita yapılandırması yüklenemedi/i)).not.toBeInTheDocument();
  });
});
