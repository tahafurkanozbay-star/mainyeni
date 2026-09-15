import { loadModules } from 'esri-loader';
import {
  MEASUREMENT_TOOLS,
  createMeasurementCapability,
  createMeasurementController,
  createMeasurementState,
  isMeasurementToolSupported,
  normalizeMeasurementTool,
} from './measurementRuntime';

jest.mock('esri-loader', () => ({
  loadModules: jest.fn(),
}));

describe('measurementRuntime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('normalizes supported measurement tool aliases', () => {
    expect(normalizeMeasurementTool('distance')).toBe(MEASUREMENT_TOOLS.DISTANCE);
    expect(normalizeMeasurementTool('length')).toBe(MEASUREMENT_TOOLS.DISTANCE);
    expect(normalizeMeasurementTool('polygon')).toBe(MEASUREMENT_TOOLS.AREA);
    expect(normalizeMeasurementTool('none')).toBe(MEASUREMENT_TOOLS.NONE);
    expect(normalizeMeasurementTool('volume')).toBeNull();
    expect(isMeasurementToolSupported('area')).toBe(true);
    expect(isMeasurementToolSupported('volume')).toBe(false);
  });

  test('creates a stable initial state contract', () => {
    expect(createMeasurementState({ activeTool: 'length' })).toEqual({
      status: 'idle',
      activeTool: 'distance',
      error: null,
      createdAt: null,
      clearedAt: null,
      destroyedAt: null,
    });
  });

  test('loads the ArcGIS Measurement module once and reuses one widget', async () => {
    const clear = jest.fn();
    const destroy = jest.fn();
    const Measurement = jest.fn().mockImplementation((options) => ({ ...options, clear, destroy }));
    loadModules.mockResolvedValue([Measurement]);
    const view = { id: 'map-view' };
    const controller = createMeasurementController({ view, container: 'measurementDiv' });

    const first = await controller.ensureWidget();
    const second = await controller.ensureWidget();

    expect(loadModules).toHaveBeenCalledTimes(1);
    expect(loadModules).toHaveBeenCalledWith(['esri/widgets/Measurement']);
    expect(Measurement).toHaveBeenCalledTimes(1);
    expect(Measurement).toHaveBeenCalledWith({
      view,
      container: 'measurementDiv',
      activeTool: '',
    });
    expect(second).toBe(first);
    expect(controller.getState().status).toBe('ready');
  });

  test('sets distance and area tools on the same widget', async () => {
    const widget = { activeTool: '', clear: jest.fn(), destroy: jest.fn() };
    const Measurement = jest.fn().mockImplementation(() => widget);
    loadModules.mockResolvedValue([Measurement]);
    const controller = createMeasurementController({ view: {}, container: 'measurementDiv' });

    await controller.setTool('distance');
    expect(widget.activeTool).toBe('distance');
    expect(controller.getState().activeTool).toBe('distance');

    await controller.setTool('area');
    expect(widget.activeTool).toBe('area');
    expect(controller.getState().activeTool).toBe('area');
    expect(Measurement).toHaveBeenCalledTimes(1);
  });

  test('rejects unsupported tools without mutating widget state', async () => {
    const widget = { activeTool: '', clear: jest.fn(), destroy: jest.fn() };
    const Measurement = jest.fn().mockImplementation(() => widget);
    loadModules.mockResolvedValue([Measurement]);
    const controller = createMeasurementController({ view: {}, container: 'measurementDiv' });

    await expect(controller.setTool('volume')).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEASUREMENT_TOOL',
    });
    expect(Measurement).not.toHaveBeenCalled();
    expect(widget.activeTool).toBe('');
  });

  test('clear delegates to the widget and resets active tool', async () => {
    const widget = { activeTool: '', clear: jest.fn(), destroy: jest.fn() };
    const Measurement = jest.fn().mockImplementation(() => widget);
    loadModules.mockResolvedValue([Measurement]);
    const controller = createMeasurementController({ view: {}, container: 'measurementDiv' });

    await controller.setTool('distance');
    expect(controller.clear()).toBe(true);

    expect(widget.clear).toHaveBeenCalledTimes(1);
    expect(widget.activeTool).toBe('');
    expect(controller.getState().activeTool).toBe('');
    expect(controller.getState().clearedAt).toEqual(expect.any(String));
  });

  test('allows view and container replacement before widget creation', async () => {
    const Measurement = jest.fn().mockImplementation((options) => ({ ...options }));
    loadModules.mockResolvedValue([Measurement]);
    const controller = createMeasurementController({ view: { id: 'old' }, container: 'old' });
    const nextView = { id: 'new' };

    expect(controller.setView(nextView)).toBe(true);
    expect(controller.setContainer('new-container')).toBe(true);
    await controller.ensureWidget();

    expect(Measurement).toHaveBeenCalledWith({
      view: nextView,
      container: 'new-container',
      activeTool: '',
    });
  });

  test('updates an existing widget when view and container change', async () => {
    const widget = { activeTool: '', clear: jest.fn(), destroy: jest.fn() };
    const Measurement = jest.fn().mockImplementation(() => widget);
    loadModules.mockResolvedValue([Measurement]);
    const controller = createMeasurementController({ view: { id: 'old' }, container: 'old' });
    await controller.ensureWidget();
    const nextView = { id: 'new' };

    controller.setView(nextView);
    controller.setContainer('new-container');

    expect(widget.view).toBe(nextView);
    expect(widget.container).toBe('new-container');
  });

  test('requires a map view before loading the widget', async () => {
    const controller = createMeasurementController({ container: 'measurementDiv' });

    await expect(controller.ensureWidget()).rejects.toMatchObject({ code: 'MAP_VIEW_REQUIRED' });
    expect(loadModules).not.toHaveBeenCalled();
  });

  test('requires a container before loading the widget', async () => {
    const controller = createMeasurementController({ view: {} });

    await expect(controller.ensureWidget()).rejects.toMatchObject({ code: 'CONTAINER_REQUIRED' });
    expect(loadModules).not.toHaveBeenCalled();
  });

  test('reports module-load failure and can recover on the next attempt', async () => {
    const Measurement = jest.fn().mockImplementation((options) => ({ ...options }));
    loadModules
      .mockRejectedValueOnce(new Error('sdk unavailable'))
      .mockResolvedValueOnce([Measurement]);
    const controller = createMeasurementController({ view: {}, container: 'measurementDiv' });

    await expect(controller.ensureWidget()).rejects.toThrow('sdk unavailable');
    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: { code: 'MEASUREMENT_LOAD_ERROR', message: 'sdk unavailable' },
    });

    await expect(controller.ensureWidget()).resolves.toEqual(expect.any(Object));
    expect(loadModules).toHaveBeenCalledTimes(2);
    expect(controller.getState().status).toBe('ready');
  });

  test('notifies subscribers when lifecycle state changes', async () => {
    const Measurement = jest.fn().mockImplementation((options) => ({ ...options, clear: jest.fn() }));
    loadModules.mockResolvedValue([Measurement]);
    const controller = createMeasurementController({ view: {}, container: 'measurementDiv' });
    const listener = jest.fn();
    const unsubscribe = controller.subscribe(listener);

    await controller.setTool('area');
    controller.clear();
    unsubscribe();
    controller.clear();

    expect(listener).toHaveBeenCalled();
    expect(listener.mock.calls[0][0].status).toBe('idle');
    expect(listener.mock.calls.some(([state]) => state.status === 'loading')).toBe(true);
    expect(listener.mock.calls.some(([state]) => state.activeTool === 'area')).toBe(true);
  });

  test('destroy clears and destroys the widget once', async () => {
    const widget = { activeTool: '', clear: jest.fn(), destroy: jest.fn() };
    const Measurement = jest.fn().mockImplementation(() => widget);
    loadModules.mockResolvedValue([Measurement]);
    const controller = createMeasurementController({ view: {}, container: 'measurementDiv' });
    await controller.ensureWidget();

    controller.destroy();
    controller.destroy();

    expect(widget.clear).toHaveBeenCalledTimes(1);
    expect(widget.destroy).toHaveBeenCalledTimes(1);
    expect(controller.getWidget()).toBeNull();
    expect(controller.destroyed).toBe(true);
    expect(controller.getState().status).toBe('destroyed');
  });

  test('rejects further widget creation after destroy', async () => {
    const controller = createMeasurementController({ view: {}, container: 'measurementDiv' });
    controller.destroy();

    await expect(controller.ensureWidget()).rejects.toMatchObject({ code: 'DESTROYED' });
  });

  test('creates a capability description for supported and unsupported tools', () => {
    expect(createMeasurementCapability('distance')).toEqual({
      requested: 'distance',
      tool: 'distance',
      supported: true,
      sdkWidget: 'esri/widgets/Measurement',
      requiresMapView: true,
    });
    expect(createMeasurementCapability('volume')).toMatchObject({
      requested: 'volume',
      tool: null,
      supported: false,
    });
  });
});
