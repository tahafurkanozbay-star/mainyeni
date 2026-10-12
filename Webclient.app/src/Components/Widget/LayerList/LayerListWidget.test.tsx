import React, { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Constants_ServiceResultType } from '../../../Core/Constants';
import type { ManagedQueryWindowHandle } from '../../Query/_Common/QuerySurfaceContracts';
import { LayerListWidget } from './LayerListWidget';

const runtime = vi.hoisted(() => ({
  getLayers: vi.fn(),
  createLayer: vi.fn(),
  getMapView: vi.fn(),
  dynamicLayers: vi.fn(),
  loadModules: vi.fn(),
  ownerAdd: vi.fn(),
  ownerClear: vi.fn(),
  ownerDestroy: vi.fn(),
  legendConstruct: vi.fn(),
  legendDestroy: vi.fn(),
}));

vi.mock('../../../Business/LayerBusiness', () => ({
  LayerBusiness: {
    GetLayers: runtime.getLayers,
  },
}));

vi.mock('../../../Business/CommonBusiness', () => ({
  CommonBusiness: {
    CreateLayer: runtime.createLayer,
  },
}));

vi.mock('../../../Store/Managers/MapManager', () => ({
  default: {
    GetMapView: runtime.getMapView,
  },
}));

vi.mock('../../../Store/Managers/DynamicLayerManager', () => ({
  default: {
    GetLayers: runtime.dynamicLayers,
  },
}));

vi.mock('../../../gis-engine/layerOwnership', () => ({
  createLayerOwner: vi.fn(() => ({
    add: runtime.ownerAdd,
    clear: runtime.ownerClear,
    destroy: runtime.ownerDestroy,
  })),
}));

vi.mock('../../../gis-engine/arcgisModuleRuntime', () => ({
  loadArcgisModules: runtime.loadModules,
}));

vi.mock('../../Common/SharedGISIcon', () => ({
  SharedGISIcon: ({ size = 24 }: { size?: number }) => (
    <span data-testid="shared-gis-icon" data-size={String(size)} aria-hidden="true" />
  ),
}));

vi.mock('../../Query/_Common/CommonQueryWindowTools', () => ({
  CommonQueryWindowTools: () => <div data-testid="window-tools" />,
}));

class LegendMock {
  constructor(options: unknown) {
    runtime.legendConstruct(options);
  }

  destroy(): void {
    runtime.legendDestroy();
  }
}

const makeRuntimeLayer = (visible = true, opacity = 1) => ({
  visible,
  opacity,
  destroy: vi.fn(),
});

const serviceGroups = [
  {
    id: 'base',
    title: 'Temel Katmanlar',
    layers: [
      { id: 'roads', title: 'Ana Yollar', visible: true, opacity: 100, priority: 1 },
      { id: 'parks', title: 'Yeşil Alanlar', visible: false, opacity: 75, priority: 2 },
    ],
  },
  {
    id: 'planning',
    title: 'İmar ve Planlama',
    layers: [
      { id: 'zoning', title: 'İmar Planı', visible: true, opacity: 90, priority: 3 },
    ],
  },
];

const createWindowManager = (visible = true, minimized = false) => ({
  IsVisible: vi.fn(() => visible),
  IsMinimized: vi.fn(() => minimized),
  RegisterWindow: vi.fn(),
  UnregisterWindow: vi.fn(),
  ShowWindow: vi.fn(),
  HideWindow: vi.fn(),
  ToggleMinimiseWindow: vi.fn(),
  ShowMessage: vi.fn(),
});

const renderWidget = (visible = true, minimized = false) => {
  const windowManager = createWindowManager(visible, minimized);
  const ref = createRef<ManagedQueryWindowHandle>();
  const result = render(
    <LayerListWidget id="layer-list-test" windowManager={windowManager} ref={ref} />,
  );
  return { ...result, ref, windowManager };
};

const resolveCatalog = (): void => {
  runtime.getLayers.mockResolvedValue({
    type: Constants_ServiceResultType.Success,
    data: serviceGroups,
  });
  runtime.createLayer.mockImplementation(async (definition: { visible?: boolean; opacity?: number }) =>
    makeRuntimeLayer(Boolean(definition.visible), Number(definition.opacity ?? 100) / 100));
};

const waitForLayerTree = async (): Promise<HTMLElement> => {
  if (!screen.queryByLabelText('Katman ve lejand yönetimi')) renderWidget();
  await waitFor(() => {
    expect(runtime.getLayers).toHaveBeenCalled();
    expect(screen.getByText('Temel Katmanlar')).toBeVisible();
  }, { timeout: 5_000 });
  return screen.getByRole('tree', { name: 'Harita katmanları' });
};

describe('LayerListWidget modern workspace', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    runtime.getLayers.mockReset();
    runtime.createLayer.mockReset();
    runtime.getMapView.mockReset();
    runtime.dynamicLayers.mockReset();
    runtime.loadModules.mockReset();
    runtime.ownerAdd.mockReset();
    runtime.ownerClear.mockReset();
    runtime.ownerDestroy.mockReset();
    runtime.legendConstruct.mockReset();
    runtime.legendDestroy.mockReset();
    runtime.getMapView.mockReturnValue({
      map: {
        add: vi.fn(),
        remove: vi.fn(),
      },
    });
    runtime.dynamicLayers.mockReturnValue([]);
    runtime.loadModules.mockResolvedValue([LegendMock]);
    resolveCatalog();
  });

  it('registers the managed window and starts loading the catalog', async () => {
    const { windowManager } = renderWidget();
    expect(windowManager.RegisterWindow).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(runtime.getLayers).toHaveBeenCalledTimes(1));
  });

  it('renders semantic tabs instead of Bootstrap tab state', () => {
    renderWidget();
    const tabs = screen.getByRole('tablist', { name: 'Katman yönetimi görünümleri' });
    expect(within(tabs).getByRole('tab', { name: 'Katmanlar' }))
      .toHaveAttribute('aria-selected', 'true');
    expect(within(tabs).getByRole('tab', { name: 'Katmanlar' })).toHaveAttribute('tabindex', '0');
    expect(within(tabs).getByRole('tab', { name: 'Lejant' }))
      .toHaveAttribute('aria-selected', 'false');
    expect(within(tabs).getByRole('tab', { name: 'Lejant' })).toHaveAttribute('tabindex', '-1');
  });

  it('uses roving tab focus with Arrow, Home and End keys', async () => {
    renderWidget();
    const tabs = screen.getByRole('tablist', { name: 'Katman yönetimi görünümleri' });
    const layers = within(tabs).getByRole('tab', { name: 'Katmanlar' });
    const legend = within(tabs).getByRole('tab', { name: 'Lejant' });
    layers.focus();
    fireEvent.keyDown(layers, { key: 'ArrowRight' });
    expect(legend).toHaveAttribute('aria-selected', 'true');
    expect(legend).toHaveAttribute('tabindex', '0');
    expect(document.activeElement).toBe(legend);
    fireEvent.keyDown(legend, { key: 'Home' });
    expect(layers).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(layers);
    fireEvent.keyDown(layers, { key: 'End' });
    expect(legend).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(legend);
  });

  it('renders a labelled searchable tree after the catalog is ready', async () => {
    const tree = await waitForLayerTree();
    expect(tree).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('searchbox', { name: 'Katman ara' })).toBeVisible();
    expect(screen.getByText('3 katman hazır.')).toBeInTheDocument();
  });

  it('keeps operational groups collapsed by default', async () => {
    await waitForLayerTree();
    expect(screen.getByRole('treeitem', { name: /Temel Katmanlar/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Ana Yollar')).not.toBeInTheDocument();
  });

  it('expands a group and exposes nested layer tree metadata', async () => {
    await waitForLayerTree();
    fireEvent.click(screen.getByRole('button', { name: 'Temel Katmanlar grubunu genişlet' }));
    const roads = screen.getByRole('treeitem', { name: /Ana Yollar/i });
    expect(roads).toHaveAttribute('aria-level', '2');
    expect(roads).toHaveAttribute('aria-posinset', '1');
    expect(roads).toHaveAttribute('aria-setsize', '2');
  });

  it('searches across collapsed groups and opens matching results virtually', async () => {
    await waitForLayerTree();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Katman ara' }), {
      target: { value: 'imar' },
    });
    expect(screen.getByText('İmar Planı')).toBeVisible();
    expect(screen.getByText('1 katman bulundu.')).toBeInTheDocument();
    expect(screen.queryByText('Ana Yollar')).not.toBeInTheDocument();
  });

  it('supports Turkish-insensitive search', async () => {
    await waitForLayerTree();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Katman ara' }), {
      target: { value: 'YESIL' },
    });
    expect(screen.getByText('Yeşil Alanlar')).toBeVisible();
  });

  it('shows a recoverable no-results state and clears it', async () => {
    await waitForLayerTree();
    const search = screen.getByRole('searchbox', { name: 'Katman ara' });
    fireEvent.change(search, { target: { value: 'uydu yörünge' } });
    expect(screen.getByText('Eşleşme bulunamadı')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Tüm katmanları göster' }));
    expect(search).toHaveValue('');
    expect(screen.getByText('Temel Katmanlar')).toBeVisible();
  });

  it('keeps a dedicated search clear action', async () => {
    await waitForLayerTree();
    const search = screen.getByRole('searchbox', { name: 'Katman ara' });
    fireEvent.change(search, { target: { value: 'park' } });
    fireEvent.click(screen.getByRole('button', { name: 'Katman aramasını temizle' }));
    expect(search).toHaveValue('');
  });

  it('exposes one keyboard tree tab stop with active descendant', async () => {
    const tree = await waitForLayerTree();
    expect(tree).toHaveAttribute('aria-activedescendant');
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(2);
  });

  it('moves the active descendant with ArrowDown while keeping DOM focus on the tree', async () => {
    const tree = await waitForLayerTree();
    tree.focus();
    const before = tree.getAttribute('aria-activedescendant');
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(tree.getAttribute('aria-activedescendant')).not.toBe(before);
    expect(document.activeElement).toBe(tree);
  });

  it('uses the ARIA tree ArrowRight and ArrowLeft expansion pattern', async () => {
    const tree = await waitForLayerTree();
    tree.focus();
    const groupId = tree.getAttribute('aria-activedescendant');
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(screen.getByText('Ana Yollar')).toBeVisible();
    expect(tree).toHaveAttribute('aria-activedescendant', groupId);
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(tree.getAttribute('aria-activedescendant')).not.toBe(groupId);
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(tree).toHaveAttribute('aria-activedescendant', groupId);
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(screen.queryByText('Ana Yollar')).not.toBeInTheDocument();
    expect(tree).toHaveAttribute('aria-activedescendant', groupId);
  });

  it('supports Home and End navigation without wrapping', async () => {
    const tree = await waitForLayerTree();
    tree.focus();
    fireEvent.keyDown(tree, { key: 'End' });
    const end = tree.getAttribute('aria-activedescendant');
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(tree.getAttribute('aria-activedescendant')).toBe(end);
    fireEvent.keyDown(tree, { key: 'Home' });
    expect(tree.getAttribute('aria-activedescendant')).not.toBe(end);
  });

  it('focuses search with the slash shortcut', async () => {
    const tree = await waitForLayerTree();
    tree.focus();
    fireEvent.keyDown(tree, { key: '/' });
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Katman ara' }));
  });

  it('clears the query with Escape from the search control', async () => {
    await waitForLayerTree();
    const search = screen.getByRole('searchbox', { name: 'Katman ara' });
    fireEvent.change(search, { target: { value: 'park' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
  });

  it('toggles layer visibility through explicit pointer controls', async () => {
    await waitForLayerTree();
    fireEvent.click(screen.getByRole('button', { name: 'Temel Katmanlar grubunu genişlet' }));
    const hideRoads = screen.getByRole('button', { name: 'Ana Yollar katmanını gizle' });
    fireEvent.click(hideRoads);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ana Yollar katmanını göster' })).toBeVisible());
  });

  it('toggles active layer visibility with Space keyboard intent', async () => {
    const tree = await waitForLayerTree();
    fireEvent.click(screen.getByRole('button', { name: 'Temel Katmanlar grubunu genişlet' }));
    tree.focus();
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: ' ' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ana Yollar katmanını göster' })).toBeVisible());
  });

  it('toggles all enabled layers from the group visibility action', async () => {
    await waitForLayerTree();
    fireEvent.click(screen.getByRole('button', { name: 'Temel Katmanlar grubunu genişlet' }));
    const groupVisibility = screen.getByRole('button', { name: /Temel Katmanlar grubunu gizle/i });
    fireEvent.click(groupVisibility);
    expect(screen.getByRole('button', { name: 'Ana Yollar katmanını göster' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Yeşil Alanlar katmanını göster' })).toBeVisible();
  });

  it('updates runtime opacity through a labelled range control', async () => {
    await waitForLayerTree();
    fireEvent.click(screen.getByRole('button', { name: 'Temel Katmanlar grubunu genişlet' }));
    const slider = screen.getByRole('slider', { name: 'Katman opaklığı: Ana Yollar' });
    fireEvent.change(slider, { target: { value: '45' } });
    expect(slider).toHaveValue('45');
    expect(slider).toHaveAttribute('aria-valuetext', 'Yüzde 45');
  });

  it('keeps opacity controls present in the DOM for responsive CSS rather than deleting mobile capability', async () => {
    await waitForLayerTree();
    fireEvent.click(screen.getByRole('button', { name: 'Temel Katmanlar grubunu genişlet' }));
    expect(screen.getAllByRole('slider')).toHaveLength(2);
  });

  it('uses the shared GIS icon primitive for groups, layers and dynamic items', async () => {
    runtime.dynamicLayers.mockReturnValue([{ id: 'custom', title: 'Özel Çizim' }]);
    renderWidget();
    await waitForLayerTree();
    expect(screen.getAllByTestId('shared-gis-icon').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Özel Çizim')).toBeVisible();
  });

  it('announces bounded loading progress while layer creation is pending', async () => {
    const releases: Array<() => void> = [];
    runtime.createLayer.mockImplementation(() => new Promise((resolve) => {
      releases.push(() => resolve(makeRuntimeLayer(true, 1)));
    }));
    renderWidget();
    await waitFor(() => expect(runtime.createLayer).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('status')).toHaveTextContent(/Katmanlar yükleniyor: yüzde 0/);
    expect(screen.getByRole('status')).toHaveTextContent(/%0/);
    await act(async () => {
      releases.forEach((release) => release());
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText('3 katman hazır.')).toBeVisible());
  });

  it('keeps successful layers usable while announcing partial load degradation', async () => {
    runtime.createLayer.mockImplementation(async (definition: { title?: string; visible?: boolean; opacity?: number }) => {
      if (definition.title === 'Yeşil Alanlar') throw new TypeError('layer failed');
      return makeRuntimeLayer(Boolean(definition.visible), Number(definition.opacity ?? 100) / 100);
    });
    renderWidget();
    await waitFor(() => {
      expect(screen.getByText('Bazı katmanlar yüklenemedi')).toBeVisible();
      expect(screen.getByText('1 katman hazır, 1 katman yüklenemedi.')).toBeVisible();
    });
    expect(screen.getByRole('tree', { name: 'Harita katmanları' })).toBeVisible();
    expect(screen.getByText(/1 katman kullanılabilir durumda; 1 katman yüklenemedi/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Katmanları yeniden yükle' })).toBeVisible();
  });

  it('recovers to the normal catalog after the user reloads a degraded layer set', async () => {
    let shouldFail = true;
    runtime.createLayer.mockImplementation(async (definition: { title?: string; visible?: boolean; opacity?: number }) => {
      if (shouldFail && definition.title === 'Yeşil Alanlar') throw new TypeError('layer failed');
      return makeRuntimeLayer(Boolean(definition.visible), Number(definition.opacity ?? 100) / 100);
    });
    renderWidget();
    expect(await screen.findByText('Bazı katmanlar yüklenemedi')).toBeVisible();
    shouldFail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Katmanları yeniden yükle' }));
    await waitFor(() => expect(runtime.getLayers).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('Bazı katmanlar yüklenemedi')).not.toBeInTheDocument());
    expect(screen.getByText('3 katman hazır.')).toBeVisible();
  });

  it('shows a manual retry action when the catalog service fails', async () => {
    runtime.getLayers.mockRejectedValueOnce(new Error('  servis   kullanılamıyor  '));
    renderWidget();
    expect(await screen.findByText('Katmanlar kullanılamıyor')).toBeVisible();
    expect(screen.getByText('servis kullanılamıyor')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Tekrar dene' })).toBeVisible();
  });

  it('still renders the recovery surface when the global error reporter throws', async () => {
    vi.stubGlobal('reportError', vi.fn(() => { throw new Error('reporter failed'); }));
    runtime.getLayers.mockRejectedValueOnce(new Error('catalog failure'));
    renderWidget();
    expect(await screen.findByText('Katmanlar kullanılamıyor')).toBeVisible();
    expect(screen.getByText('catalog failure')).toBeVisible();
  });

  it('retries only after explicit user action', async () => {
    runtime.getLayers
      .mockRejectedValueOnce(new Error('ilk hata'))
      .mockResolvedValueOnce({ type: Constants_ServiceResultType.Success, data: serviceGroups });
    renderWidget();
    expect(await screen.findByText('ilk hata')).toBeVisible();
    expect(runtime.getLayers).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Tekrar dene' }));
    await waitFor(() => expect(runtime.getLayers).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Temel Katmanlar')).toBeVisible();
  });

  it('renders service-result failures as a safe recovery surface', async () => {
    runtime.getLayers.mockResolvedValueOnce({ type: 'failed', data: [] });
    renderWidget();
    expect(await screen.findByText('Katmanlar kullanılamıyor')).toBeVisible();
    expect(screen.getByText('Katman kataloğu alınamadı.')).toBeVisible();
  });

  it('renders a safe map-not-ready failure instead of calling the catalog', async () => {
    runtime.getMapView.mockReturnValue(null);
    renderWidget();
    expect(await screen.findByText('Harita görünümü hazır değil.')).toBeVisible();
    expect(runtime.getLayers).not.toHaveBeenCalled();
  });

  it('opens the governed legend tab and creates one ArcGIS legend', async () => {
    await waitForLayerTree();
    fireEvent.click(screen.getByRole('tab', { name: 'Lejant' }));
    await waitFor(() => expect(runtime.loadModules).toHaveBeenCalledWith(['esri/widgets/Legend']));
    await waitFor(() => expect(runtime.legendConstruct).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('tabpanel', { name: 'Lejant' })).toBeVisible();
  });

  it('ignores a late legend import after returning to layers', async () => {
    let resolveImport: (value: unknown) => void = () => undefined;
    runtime.loadModules.mockImplementationOnce(() => new Promise((resolve) => {
      resolveImport = resolve;
    }));
    await waitForLayerTree();
    fireEvent.click(screen.getByRole('tab', { name: 'Lejant' }));
    expect(runtime.loadModules).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('tab', { name: 'Katmanlar' }));
    await act(async () => {
      resolveImport([LegendMock]);
      await Promise.resolve();
    });
    expect(runtime.legendConstruct).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Lejant' }));
    await waitFor(() => expect(runtime.legendConstruct).toHaveBeenCalledTimes(1));
  });

  it('keeps the newest legend when an older import resolves later', async () => {
    let resolveOld: (value: unknown) => void = () => undefined;
    runtime.loadModules.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOld = resolve;
    }));
    await waitForLayerTree();
    fireEvent.click(screen.getByRole('tab', { name: 'Lejant' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Katmanlar' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Lejant' }));
    await waitFor(() => expect(runtime.legendConstruct).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveOld([LegendMock]);
      await Promise.resolve();
    });
    expect(runtime.legendConstruct).toHaveBeenCalledTimes(1);
    expect(runtime.legendDestroy).not.toHaveBeenCalled();
  });

  it('does not report a stale import rejection over a newer legend', async () => {
    let rejectOld: (reason: Error) => void = () => undefined;
    runtime.loadModules.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectOld = reject;
    }));
    const report = vi.fn();
    vi.stubGlobal('reportError', report);
    await waitForLayerTree();
    fireEvent.click(screen.getByRole('tab', { name: 'Lejant' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Katmanlar' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Lejant' }));
    await waitFor(() => expect(runtime.legendConstruct).toHaveBeenCalledTimes(1));
    await act(async () => {
      rejectOld(new Error('obsolete import'));
      await Promise.resolve();
    });
    expect(report).not.toHaveBeenCalled();
    expect(runtime.legendDestroy).not.toHaveBeenCalled();
    expect(screen.queryByText('Lejant yüklenemedi')).not.toBeInTheDocument();
  });

  it('does not construct a legend after managed close during import', async () => {
    let resolveImport: (value: unknown) => void = () => undefined;
    runtime.loadModules.mockImplementationOnce(() => new Promise((resolve) => {
      resolveImport = resolve;
    }));
    const { ref } = renderWidget();
    await waitForLayerTree();
    fireEvent.click(screen.getByRole('tab', { name: 'Lejant' }));
    act(() => ref.current?.OnClose?.());
    await act(async () => {
      resolveImport([LegendMock]);
      await Promise.resolve();
    });
    expect(runtime.legendConstruct).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: 'Katmanlar' })).toHaveAttribute('aria-selected', 'true');
  });

  it('destroys the legend when returning to layers', async () => {
    await waitForLayerTree();
    fireEvent.click(screen.getByRole('tab', { name: 'Lejant' }));
    await waitFor(() => expect(runtime.legendConstruct).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('tab', { name: 'Katmanlar' }));
    expect(runtime.legendDestroy).toHaveBeenCalledTimes(1);
  });

  it('contains legend module failures and keeps the panel usable', async () => {
    runtime.loadModules.mockRejectedValueOnce(new Error('legend failure'));
    const report = vi.fn();
    vi.stubGlobal('reportError', report);
    await waitForLayerTree();
    fireEvent.click(screen.getByRole('tab', { name: 'Lejant' }));
    await waitFor(() => expect(report).toHaveBeenCalled());
    expect(screen.getByText('Lejant yüklenemedi')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Tekrar dene' }));
    await waitFor(() => expect(runtime.legendConstruct).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Lejant yüklenemedi')).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('refreshes the managed surface without closing it on OnShow', async () => {
    const { ref, windowManager } = renderWidget(false);
    await waitFor(() => expect(runtime.getLayers).toHaveBeenCalledTimes(1));
    await act(async () => {
      ref.current?.OnShow?.();
      await Promise.resolve();
    });
    expect(windowManager.ShowWindow).not.toHaveBeenCalledWith('sidebar');
    await waitFor(() => expect(runtime.getLayers).toHaveBeenCalledTimes(2));
  });

  it('cancels active loading and disposes legend on managed OnClose', async () => {
    const { ref } = renderWidget();
    await waitForLayerTree();
    fireEvent.click(screen.getByRole('tab', { name: 'Lejant' }));
    await waitFor(() => expect(runtime.legendConstruct).toHaveBeenCalledTimes(1));
    act(() => ref.current?.OnClose?.());
    expect(runtime.legendDestroy).toHaveBeenCalledTimes(1);
  });

  it('clears owned layers and unregisters on unmount', async () => {
    const { unmount, windowManager } = renderWidget();
    await waitForLayerTree();
    unmount();
    expect(runtime.ownerClear).toHaveBeenCalled();
    expect(windowManager.UnregisterWindow).toHaveBeenCalledTimes(1);
  });

  it('renders minimized content as inert hidden body content', async () => {
    renderWidget(true, true);
    await waitFor(() => expect(runtime.getLayers).toHaveBeenCalled());
    expect(screen.queryByRole('tree', { name: 'Harita katmanları' })).not.toBeInTheDocument();
  });

  it('mirrors managed-window visibility through aria-hidden and visibility style', () => {
    const { container } = renderWidget(false);
    const section = container.querySelector('section[aria-label="Katman ve lejand yönetimi"]');
    expect(section).toHaveAttribute('aria-hidden', 'true');
    expect(section).toHaveStyle({ visibility: 'hidden' });
  });

it('protects React-owned legend DOM when the SDK removes its container during destruction', async () => {
  const { ref } = renderWidget();
  await waitForLayerTree();
  fireEvent.click(screen.getByRole('tab', { name: 'Lejant' }));
  await waitFor(() => expect(runtime.legendConstruct).toHaveBeenCalledTimes(1));
  const container = runtime.legendConstruct.mock.calls[0]?.[0].container as HTMLElement;
  const parent = screen.getByLabelText('Harita lejantı');
  expect(container).not.toBe(parent); expect(parent).toContainElement(container);
  runtime.legendDestroy.mockImplementationOnce(() => container.remove());
  act(() => { ref.current?.OnClose?.(); });
  expect(parent).toBeInTheDocument(); expect(container).not.toBeInTheDocument();
  expect(screen.getByRole('tabpanel', { name: 'Katmanlar' })).toBeVisible();
});

});
