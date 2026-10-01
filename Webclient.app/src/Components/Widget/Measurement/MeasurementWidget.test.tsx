import React, { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MEASUREMENT_TOOLS } from '../../../gis-engine/measurementRuntime';
import type { ExperienceToolbarItem } from '../../Common/ExperienceToolbar';
import type { MeasurementExperienceSnapshot } from './measurementExperienceModel';
import type { MeasurementExperienceController } from './measurementExperienceController';
import { MeasurementWidget, type MeasurementWindowHandle } from './MeasurementWidget';

const focusOpen = vi.fn();
const focusClose = vi.fn();
const focusDispose = vi.fn();
const createFocusLifecycle = vi.fn(() => ({
  open: focusOpen,
  close: focusClose,
  dispose: focusDispose,
}));

vi.mock('../../Query/_Common/ManagedWindowFocus', () => ({
  createManagedWindowFocusLifecycle: () => createFocusLifecycle(),
}));

vi.mock('../../Query/_Common/CommonQueryWindowTools', () => ({
  CommonQueryWindowTools: ({ windowId }: { windowId: string }) => (
    <div data-testid="window-tools" data-window-id={windowId}>Pencere araçları</div>
  ),
}));

vi.mock('../../Common/ExperienceToolbar', () => ({
  ExperienceToolbar: ({ label, items }: { label: string; items: readonly ExperienceToolbarItem[] }) => (
    <div role="toolbar" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-label={item.label}
          aria-pressed={item.pressed}
          disabled={item.disabled}
          data-roving-focus-id={item.id}
          onClick={item.onActivate}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  ),
}));

const captureError = vi.fn();
const recordDiagnostic = vi.fn();
vi.mock('../../../platform/runtime/runtimeDiagnostics', () => ({
  runtimeDiagnostics: {
    captureError,
    record: recordDiagnostic,
  },
}));

const mapView = { id: 'map-view' };
const getMapView = vi.fn(() => mapView as unknown);
vi.mock('../../../Store/Managers/MapManager', () => ({
  default: {
    GetMapView: () => getMapView(),
  },
}));

let currentController: FakeMeasurementController;
const createController = vi.fn(() => currentController.controller);
vi.mock('./measurementExperienceController', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./measurementExperienceController')>();
  return {
    ...actual,
    createMeasurementExperienceController: (...args: unknown[]) => createController(...args),
  };
});

const createSnapshot = (
  overrides: Partial<MeasurementExperienceSnapshot> = {},
): MeasurementExperienceSnapshot => ({
  revision: 1,
  phase: 'ready',
  visible: true,
  viewReady: true,
  busy: false,
  activeTool: MEASUREMENT_TOOLS.NONE,
  requestedTool: MEASUREMENT_TOOLS.NONE,
  canClear: false,
  canRetry: false,
  retryCount: 0,
  maxRetries: 3,
  errorMessage: null,
  errorCode: null,
  announcement: 'Ölçüm araçları hazır.',
  guidance: 'Alan veya mesafe aracını seçin.',
  modality: 'unknown',
  activity: [],
  ...overrides,
});

interface FakeMeasurementController {
  readonly controller: MeasurementExperienceController;
  readonly open: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  readonly close: ReturnType<typeof vi.fn<() => void>>;
  readonly refreshView: ReturnType<typeof vi.fn<() => boolean>>;
  readonly selectTool: ReturnType<typeof vi.fn<(tool: typeof MEASUREMENT_TOOLS.AREA | typeof MEASUREMENT_TOOLS.DISTANCE | typeof MEASUREMENT_TOOLS.NONE) => Promise<boolean>>>;
  readonly clear: ReturnType<typeof vi.fn<() => boolean>>;
  readonly retry: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  readonly recordInputModality: ReturnType<typeof vi.fn<(modality: 'unknown' | 'keyboard' | 'pointer') => void>>;
  readonly dispose: ReturnType<typeof vi.fn<() => void>>;
  readonly update: (snapshot: MeasurementExperienceSnapshot) => void;
}

const createFakeController = (
  initial = createSnapshot(),
): FakeMeasurementController => {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const open = vi.fn(async () => true);
  const close = vi.fn();
  const refreshView = vi.fn(() => snapshot.viewReady);
  const selectTool = vi.fn(async () => true);
  const clear = vi.fn(() => true);
  const retry = vi.fn(async () => true);
  const recordInputModality = vi.fn();
  const dispose = vi.fn();
  const controller: MeasurementExperienceController = {
    getSnapshot: () => snapshot,
    getDiagnostics: () => ({
      operationRevision: 0,
      staleCompletionCount: 0,
      runtimeCreationCount: 0,
      runtimeReplacementCount: 0,
      controllerFailureCount: 0,
      reporterFailureCount: 0,
      lastFailurePhase: null,
      lastFailureKind: null,
      disposed: false,
    }),
    getModelDiagnostics: () => ({
      activeObserverCount: listeners.size,
      rejectedObserverCount: 0,
      observerFailureCount: 0,
      reporterFailureCount: 0,
      lastObserverFailureRevision: null,
      lastObserverFailureKind: null,
      disposed: false,
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open,
    close,
    refreshView,
    selectTool,
    clear,
    retry,
    recordInputModality,
    dispose,
    get destroyed() {
      return false;
    },
  };

  return {
    controller,
    open,
    close,
    refreshView,
    selectTool,
    clear,
    retry,
    recordInputModality,
    dispose,
    update(nextSnapshot) {
      snapshot = nextSnapshot;
      for (const listener of listeners) listener();
    },
  };
};

const createWindowManager = (visible = true) => ({
  RegisterWindow: vi.fn(),
  ShowWindow: vi.fn(),
  IsVisible: vi.fn(() => visible),
  CloseWindow: vi.fn(),
  MinimizeWindow: vi.fn(),
  OpenWindow: vi.fn(),
});

const renderWidget = (options: {
  visible?: boolean;
  snapshot?: MeasurementExperienceSnapshot;
} = {}) => {
  currentController = createFakeController(options.snapshot ?? createSnapshot());
  const windowManager = createWindowManager(options.visible ?? true);
  const ref = createRef<MeasurementWindowHandle>();
  const result = render(
    <MeasurementWidget
      ref={ref}
      id="measurement-window"
      windowManager={windowManager}
    />,
  );
  return { ...result, windowManager, ref };
};

describe('MeasurementWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMapView.mockReturnValue(mapView);
  });

  it('creates one governed controller and refreshes view readiness on mount', () => {
    renderWidget();

    expect(createController).toHaveBeenCalledTimes(1);
    expect(currentController.refreshView).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Ölçüm rehberi' })).toBeInTheDocument();
  });

  it('registers the imperative window handle with WindowManager', () => {
    const { windowManager, ref } = renderWidget();

    expect(windowManager.RegisterWindow).toHaveBeenCalledTimes(1);
    expect(windowManager.RegisterWindow).toHaveBeenCalledWith(ref);
    expect(ref.current).toEqual(expect.objectContaining({
      id: 'measurement-window',
      visible: false,
      minimized: false,
    }));
  });

  it('shows the sidebar, opens governed focus and starts the measurement session on OnShow', async () => {
    const { windowManager, ref } = renderWidget();

    await act(async () => {
      ref.current?.OnShow();
      await Promise.resolve();
    });

    expect(windowManager.ShowWindow).toHaveBeenCalledWith('sidebar');
    expect(focusOpen).toHaveBeenCalledWith(expect.objectContaining({
      root: expect.any(HTMLElement),
      initialFocusSelector: '[data-roving-focus-id]',
      restorePolicy: 'if-focus-within',
    }));
    expect(currentController.open).toHaveBeenCalledTimes(1);
  });

  it('closes the session and restores focus through the managed lifecycle', () => {
    const { ref } = renderWidget();

    ref.current?.OnClose();

    expect(currentController.close).toHaveBeenCalledTimes(1);
    expect(focusClose).toHaveBeenCalledTimes(1);
  });

  it('disposes both measurement and focus lifecycle authorities on unmount', async () => {
    const { ref, unmount } = renderWidget();
    await act(async () => {
      ref.current?.OnShow();
      await Promise.resolve();
    });

    unmount();

    expect(currentController.dispose).toHaveBeenCalledTimes(1);
    expect(focusDispose).toHaveBeenCalledTimes(1);
  });

  it('renders a semantic labelled measurement window', () => {
    const { container } = renderWidget();
    const section = container.querySelector('section.measurement-widget');

    expect(section).toHaveAttribute('aria-labelledby', 'measurement-window-title');
    expect(screen.getByText('Ölçüm Araçları')).toHaveAttribute('id', 'measurement-window-title');
    expect(screen.getByTestId('window-tools')).toHaveAttribute('data-window-id', 'measurement-window');
  });

  it('preserves WindowManager visibility without unmounting the session state', () => {
    const { container } = renderWidget({ visible: false });
    const section = container.querySelector('section.measurement-widget');

    expect(section).toHaveStyle({ visibility: 'hidden' });
    expect(screen.getByRole('toolbar', { name: 'Ölçüm araçları' })).toBeInTheDocument();
  });

  it('renders the modernized toolbar with area, distance and clear actions', () => {
    renderWidget();

    expect(screen.getByRole('button', { name: 'Alan ölç' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Mesafe ölç' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Ölçümü temizle' })).toBeDisabled();
  });

  it('routes area activation through the governed controller', () => {
    renderWidget();
    fireEvent.click(screen.getByRole('button', { name: 'Alan ölç' }));
    expect(currentController.selectTool).toHaveBeenCalledWith(MEASUREMENT_TOOLS.AREA);
  });

  it('routes distance activation through the governed controller', () => {
    renderWidget();
    fireEvent.click(screen.getByRole('button', { name: 'Mesafe ölç' }));
    expect(currentController.selectTool).toHaveBeenCalledWith(MEASUREMENT_TOOLS.DISTANCE);
  });

  it('routes clear through the governed controller when a measurement is active', () => {
    renderWidget({
      snapshot: createSnapshot({
        activeTool: MEASUREMENT_TOOLS.AREA,
        requestedTool: MEASUREMENT_TOOLS.AREA,
        canClear: true,
        announcement: 'Alan ölçümü etkin.',
      }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Ölçümü temizle' }));
    expect(currentController.clear).toHaveBeenCalledTimes(1);
  });

  it('reflects the active area tool as a pressed toolbar button', () => {
    renderWidget({
      snapshot: createSnapshot({
        activeTool: MEASUREMENT_TOOLS.AREA,
        requestedTool: MEASUREMENT_TOOLS.AREA,
        canClear: true,
      }),
    });

    expect(screen.getByRole('button', { name: 'Alan ölç' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Mesafe ölç' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reflects the active distance tool independently', () => {
    renderWidget({
      snapshot: createSnapshot({
        activeTool: MEASUREMENT_TOOLS.DISTANCE,
        requestedTool: MEASUREMENT_TOOLS.DISTANCE,
        canClear: true,
      }),
    });

    expect(screen.getByRole('button', { name: 'Mesafe ölç' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Alan ölç' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('disables all measurement actions while the map view is unavailable', () => {
    renderWidget({
      snapshot: createSnapshot({
        phase: 'waiting-map',
        viewReady: false,
        announcement: 'Harita görünümünün hazır olması bekleniyor.',
        guidance: 'Harita görünümü hazırlanıyor.',
      }),
    });

    expect(screen.getByRole('button', { name: 'Alan ölç' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mesafe ölç' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ölçümü temizle' })).toBeDisabled();
  });

  it('disables toolbar interactions and marks surfaces busy while loading', () => {
    const { container } = renderWidget({
      snapshot: createSnapshot({
        phase: 'loading',
        busy: true,
        requestedTool: MEASUREMENT_TOOLS.AREA,
        announcement: 'Ölçüm aracı hazırlanıyor.',
      }),
    });

    expect(container.querySelector('section.measurement-widget')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByLabelText('ArcGIS ölçüm denetimi')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Alan ölç' })).toBeDisabled();
  });

  it('exposes stable phase and tool hooks for responsive presentation', () => {
    const { container } = renderWidget({
      snapshot: createSnapshot({
        phase: 'ready',
        activeTool: MEASUREMENT_TOOLS.DISTANCE,
        requestedTool: MEASUREMENT_TOOLS.DISTANCE,
        canClear: true,
      }),
    });

    const section = container.querySelector('section.measurement-widget');
    expect(section).toHaveAttribute('data-measurement-phase', 'ready');
    expect(section).toHaveAttribute('data-measurement-tool', 'distance');
  });

  it('uses none as the presentation hook when no tool is active', () => {
    const { container } = renderWidget();
    expect(container.querySelector('section.measurement-widget')).toHaveAttribute('data-measurement-tool', 'none');
  });

  it('records keyboard modality from interactions inside the measurement window', () => {
    const { container } = renderWidget();
    const section = container.querySelector('section.measurement-widget');
    expect(section).not.toBeNull();

    fireEvent.keyDown(section!, { key: 'Tab' });
    expect(currentController.recordInputModality).toHaveBeenCalledWith('keyboard');
  });

  it('records pointer modality from interactions inside the measurement window', () => {
    const { container } = renderWidget();
    const section = container.querySelector('section.measurement-widget');
    expect(section).not.toBeNull();

    fireEvent.pointerDown(section!);
    expect(currentController.recordInputModality).toHaveBeenCalledWith('pointer');
  });

  it('renders measurement canvas instructions as an accessible description', () => {
    renderWidget();
    const canvas = screen.getByLabelText('ArcGIS ölçüm denetimi');
    expect(canvas).toHaveAttribute('aria-describedby', 'measurement-widget-canvas-help');
    expect(screen.getByText(/Ölçüm aracını seçtikten sonra/)).toHaveAttribute('id', 'measurement-widget-canvas-help');
  });

  it('renders user-facing introduction instead of relying on icon-only controls', () => {
    renderWidget();
    expect(screen.getByText(/Harita üzerinde alan ve mesafe ölçün/)).toBeInTheDocument();
  });

  it('routes the recovery action to bounded controller retry', () => {
    renderWidget({
      snapshot: createSnapshot({
        phase: 'error',
        canRetry: true,
        errorMessage: 'Ölçüm başlatılamadı.',
        errorCode: 'LOAD_ERROR',
        announcement: 'Ölçüm başlatılamadı.',
      }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Yeniden dene' }));
    expect(currentController.retry).toHaveBeenCalledTimes(1);
  });

  it('rerenders from the external-store snapshot without reconstructing the controller', () => {
    renderWidget();
    expect(screen.getByRole('button', { name: 'Alan ölç' })).toHaveAttribute('aria-pressed', 'false');

    act(() => {
      currentController.update(createSnapshot({
        revision: 2,
        activeTool: MEASUREMENT_TOOLS.AREA,
        requestedTool: MEASUREMENT_TOOLS.AREA,
        canClear: true,
        announcement: 'Alan ölçümü etkin.',
        activity: [{ id: 1, kind: 'tool', tool: MEASUREMENT_TOOLS.AREA, label: 'Alan etkin' }],
      }));
    });

    expect(screen.getByRole('button', { name: 'Alan ölç' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Alan ölçümü etkin.')).toBeInTheDocument();
    expect(createController).toHaveBeenCalledTimes(1);
  });

  it('rerenders error recovery from external-store updates', () => {
    renderWidget();

    act(() => {
      currentController.update(createSnapshot({
        revision: 2,
        phase: 'error',
        canRetry: true,
        errorMessage: 'Bağlantı kesildi.',
        errorCode: 'NETWORK_ERROR',
        announcement: 'Ölçüm aracı hazırlanamadı. Bağlantı kesildi.',
      }));
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Bağlantı kesildi.');
    expect(screen.getByText('NETWORK_ERROR')).toBeInTheDocument();
  });

  it('renders activity history from the same snapshot authority', () => {
    renderWidget({
      snapshot: createSnapshot({
        activity: [
          { id: 1, kind: 'opened', tool: MEASUREMENT_TOOLS.NONE, label: 'Açıldı' },
          { id: 2, kind: 'tool', tool: MEASUREMENT_TOOLS.AREA, label: 'Alan etkin' },
        ],
      }),
    });

    expect(screen.getByText('Oturum hareketleri')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Son ölçüm oturumu hareketleri' })).toHaveTextContent('Alan etkin');
  });

  it('renders header icon as decorative', () => {
    const { container } = renderWidget();
    const icon = container.querySelector('.common-query-window-header-icon');
    expect(icon).toHaveAttribute('alt', '');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('does not recreate controller across external parent rerenders', () => {
    const windowManager = createWindowManager();
    currentController = createFakeController();
    const ref = createRef<MeasurementWindowHandle>();
    const { rerender } = render(<MeasurementWidget ref={ref} id="measurement-window" windowManager={windowManager} />);

    rerender(<MeasurementWidget ref={ref} id="measurement-window" windowManager={windowManager} />);

    expect(createController).toHaveBeenCalledTimes(1);
  });
});
