import React, { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import { BasemapWidget } from './BasemapWidget';

const runtime = vi.hoisted(() => ({
  loadModules: vi.fn(),
  getMapView: vi.fn(),
  fromId: vi.fn(),
  galleryDestroy: vi.fn(),
  galleryConstruct: vi.fn(),
}));

vi.mock('../../../gis-engine/arcgisModuleRuntime', () => ({
  loadArcgisModules: runtime.loadModules,
}));

vi.mock('../../../Store/Managers/MapManager', () => ({
  default: {
    GetMapView: runtime.getMapView,
  },
}));

class GalleryMock {
  readonly options: unknown;

  constructor(options: unknown) {
    this.options = options;
    runtime.galleryConstruct(options);
  }

  destroy(): void {
    runtime.galleryDestroy();
  }
}

const BasemapMock = {
  fromId: runtime.fromId,
};

const createWindowManager = (visible = true) => ({
  IsVisible: vi.fn(() => visible),
  IsMinimized: vi.fn(() => false),
  ToggleMinimiseWindow: vi.fn(),
  HideWindow: vi.fn(),
  ShowMessage: vi.fn(),
  ShowWindow: vi.fn(),
  RegisterWindow: vi.fn(),
  UnregisterWindow: vi.fn(),
});

const renderWidget = (visible = true) => {
  const windowManager = createWindowManager(visible);
  const ref = createRef<ManagedWindowHandle>();
  const result = render(<BasemapWidget id="basemap-test" windowManager={windowManager} ref={ref} />);
  return { ...result, ref, windowManager };
};

const resolveModules = (): void => {
  runtime.loadModules.mockResolvedValue([GalleryMock, BasemapMock]);
};

describe('BasemapWidget governed lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.getMapView.mockReturnValue({ id: 'map-view' });
    runtime.fromId.mockImplementation((id: string) => ({ id }));
    resolveModules();
  });

  it('registers the managed window', () => {
    const { windowManager } = renderWidget(false);
    expect(windowManager.RegisterWindow).toHaveBeenCalledTimes(1);
  });

  it('loads once on the first visible mount', async () => {
    renderWidget(true);
    await waitFor(() => expect(runtime.loadModules).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(runtime.galleryConstruct).toHaveBeenCalledTimes(1));
    expect(runtime.loadModules).toHaveBeenCalledWith([
      'esri/widgets/BasemapGallery',
      'esri/Basemap',
    ]);
  });

  it('passes the current map view and bounded basemap source to ArcGIS gallery', async () => {
    renderWidget(true);
    await waitFor(() => expect(runtime.galleryConstruct).toHaveBeenCalledTimes(1));
    const options = runtime.galleryConstruct.mock.calls[0]?.[0] as {
      readonly view: unknown;
      readonly source: readonly { readonly id: string }[];
    };
    expect(options.view).toEqual({ id: 'map-view' });
    expect(options.source).toHaveLength(17);
    expect(options.source[0]?.id).toBe('topo');
  });

  it('filters basemap ids that ArcGIS cannot resolve', async () => {
    runtime.fromId.mockImplementation((id: string) => id === 'oceans' ? null : { id });
    renderWidget(true);
    await waitFor(() => expect(runtime.galleryConstruct).toHaveBeenCalledTimes(1));
    const options = runtime.galleryConstruct.mock.calls[0]?.[0] as {
      readonly source: readonly { readonly id: string }[];
    };
    expect(options.source).toHaveLength(16);
    expect(options.source.some((item) => item.id === 'oceans')).toBe(false);
  });

  it('announces the ready basemap count', async () => {
    renderWidget(true);
    expect(await screen.findByText('17 altlık harita kullanıma hazır')).toBeVisible();
    expect(screen.getByText('17 altlık harita kullanıma hazır.')).toBeInTheDocument();
  });

  it('marks the ArcGIS host busy while modules are pending', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    runtime.loadModules.mockReturnValue(new Promise((next) => { resolve = next; }));
    renderWidget(true);
    await waitFor(() => expect(screen.getByLabelText('Altlık harita galerisi')).toHaveAttribute('aria-busy', 'true'));
    expect(screen.getByLabelText('Altlık haritalar hazırlanıyor')).toBeVisible();
    await act(async () => {
      resolve?.([GalleryMock, BasemapMock]);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByLabelText('Altlık harita galerisi')).not.toHaveAttribute('aria-busy'));
  });

  it('shows sanitized loading failure with a manual reload action', async () => {
    runtime.loadModules.mockRejectedValueOnce(new Error('  ArcGIS   unavailable  '));
    renderWidget(true);
    expect(await screen.findByText('ArcGIS unavailable')).toBeVisible();
    expect(screen.getByText('Altlık harita galerisi açılamadı')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Galeriyi yeniden yükle' })).toBeVisible();
    expect(screen.getByText(/2 deneme hakkı kaldı/)).toBeVisible();
  });

  it('reloads only after the user chooses the reload action', async () => {
    runtime.loadModules
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce([GalleryMock, BasemapMock]);
    renderWidget(true);
    expect(await screen.findByText('first failure')).toBeVisible();
    expect(runtime.loadModules).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Galeriyi yeniden yükle' }));
    });
    await waitFor(() => expect(runtime.loadModules).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(runtime.galleryConstruct).toHaveBeenCalledTimes(1));
  });

  it('stops exposing reload after three failed attempts', async () => {
    runtime.loadModules.mockRejectedValue(new Error('unavailable'));
    renderWidget(true);

    expect(await screen.findByText('unavailable')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Galeriyi yeniden yükle' }));
    await waitFor(() => expect(runtime.loadModules).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Galeriyi yeniden yükle' })).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Galeriyi yeniden yükle' }));
    await waitFor(() => expect(runtime.loadModules).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Galeriyi yeniden yükle' })).not.toBeInTheDocument());
    expect(screen.getByText(/yükleme sınırına ulaşıldı/)).toBeVisible();
  });

  it('does not automatically loop after a failure', async () => {
    runtime.loadModules.mockRejectedValue(new Error('single failure'));
    renderWidget(true);
    expect(await screen.findByText('single failure')).toBeVisible();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(runtime.loadModules).toHaveBeenCalledTimes(1);
  });

  it('resets the exhausted budget when the managed window is shown again', async () => {
    runtime.loadModules.mockRejectedValue(new Error('unavailable'));
    const { ref } = renderWidget(true);
    expect(await screen.findByText('unavailable')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Galeriyi yeniden yükle' }));
    await waitFor(() => expect(runtime.loadModules).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Galeriyi yeniden yükle' }));
    await waitFor(() => expect(runtime.loadModules).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('button', { name: 'Galeriyi yeniden yükle' })).not.toBeInTheDocument();

    runtime.loadModules.mockResolvedValue([GalleryMock, BasemapMock]);
    await act(async () => {
      ref.current?.OnShow?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(runtime.loadModules).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(runtime.galleryConstruct).toHaveBeenCalledTimes(1));
  });

  it('opens the sidebar when the managed window is shown', async () => {
    const { ref, windowManager } = renderWidget(false);
    await act(async () => {
      ref.current?.OnShow?.();
      await Promise.resolve();
    });
    expect(windowManager.ShowWindow).toHaveBeenCalledWith('sidebar');
  });

  it('destroys an existing gallery when closing', async () => {
    const { ref } = renderWidget(true);
    await waitFor(() => expect(runtime.galleryConstruct).toHaveBeenCalledTimes(1));
    act(() => ref.current?.OnClose?.());
    expect(runtime.galleryDestroy).toHaveBeenCalledTimes(1);
  });

  it('does not recreate the gallery after close from the reset state', async () => {
    const { ref } = renderWidget(true);
    await waitFor(() => expect(runtime.galleryConstruct).toHaveBeenCalledTimes(1));
    act(() => ref.current?.OnClose?.());
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(runtime.galleryConstruct).toHaveBeenCalledTimes(1);
  });

  it('destroys the gallery and unregisters on unmount', async () => {
    const { unmount, windowManager } = renderWidget(true);
    await waitFor(() => expect(runtime.galleryConstruct).toHaveBeenCalledTimes(1));
    unmount();
    expect(runtime.galleryDestroy).toHaveBeenCalledTimes(1);
    expect(windowManager.UnregisterWindow).toHaveBeenCalledTimes(1);
  });

  it('does not auto-load while the managed window is hidden', async () => {
    renderWidget(false);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(runtime.loadModules).not.toHaveBeenCalled();
  });

  it('keeps the ArcGIS host labelled for assistive technology', () => {
    renderWidget(false);
    expect(screen.getByLabelText('Altlık harita galerisi')).toBeInTheDocument();
  });
});
