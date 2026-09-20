import {
  ADVANCED_SKETCH_TOOLS,
  DEFAULT_ADVANCED_SKETCH_STYLE,
  buildLineSymbol,
  buildPointSymbol,
  buildPolygonSymbol,
  createAdvancedSketchSession,
  normalizeAdvancedSketchStyle,
  normalizeHexColor,
  type GraphicsLayerLike,
  type SketchMapViewLike,
  type SketchViewModelLike,
} from './AdvancedSketchRuntime';

const collection = (items: readonly unknown[] = []) => ({
  get length() { return items.length; },
  items,
  toArray: () => [...items],
});

const createHarness = () => {
  let graphicItems: unknown[] = [];
  let selectedItems: unknown[] = [];
  const callbacks = new Map<string, (event: unknown) => void>();
  const viewCallbacks = new Map<string, (event: unknown) => void>();
  const layer: GraphicsLayerLike = {
    get graphics() { return collection(graphicItems); },
    removeAll: vi.fn(() => { graphicItems = []; }),
  };
  const vm: SketchViewModelLike = {
    create: vi.fn(),
    update: vi.fn(),
    cancel: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    delete: vi.fn(() => { selectedItems = []; }),
    canUndo: vi.fn(() => true),
    canRedo: vi.fn(() => true),
    get updateGraphics() { return collection(selectedItems); },
    on: vi.fn((eventName: string, callback: (event: unknown) => void) => {
      callbacks.set(eventName, callback);
      return { remove: vi.fn(() => callbacks.delete(eventName)) };
    }),
    destroy: vi.fn(),
  };
  const view: SketchMapViewLike = {
    hitTest: vi.fn(async () => ({ results: [] })),
    on: vi.fn((eventName: string, callback: (event: unknown) => void) => {
      viewCallbacks.set(eventName, callback);
      return { remove: vi.fn(() => viewCallbacks.delete(eventName)) };
    }),
  };
  const changes: unknown[] = [];
  const errors: unknown[] = [];
  const session = createAdvancedSketchSession({
    view,
    layer,
    sketchViewModel: vm,
    onChange: (snapshot) => changes.push(snapshot),
    onError: (error) => errors.push(error),
  });

  return {
    session,
    layer,
    vm,
    view,
    callbacks,
    viewCallbacks,
    changes,
    errors,
    setGraphics: (items: unknown[]) => { graphicItems = items; },
    setSelected: (items: unknown[]) => { selectedItems = items; },
  };
};

describe('AdvancedSketchRuntime color and style normalization', () => {
  test.each([
    ['#ABC', '#aabbcc'],
    ['#abcdef', '#abcdef'],
    [' #123456 ', '#123456'],
    ['bad', '#010203'],
    [null, '#010203'],
  ])('normalizes color %s', (input, expected) => {
    expect(normalizeHexColor(input, '#010203')).toBe(expected);
  });

  test('normalizes every style family without mutating defaults', () => {
    const next = normalizeAdvancedSketchStyle({
      point: {
        color: '#ABC',
        size: 100,
        style: 'diamond',
        outlineColor: '#111111',
        outlineWidth: -1,
      },
      line: {
        color: '#222222',
        width: 0,
        style: 'dash-dot',
      },
      fill: {
        color: '#333333',
        opacity: 5,
        style: 'cross',
        outlineColor: '#444444',
        outlineWidth: 99,
        outlineStyle: 'dot',
      },
    });

    expect(next).toEqual({
      point: {
        color: '#aabbcc',
        size: 64,
        style: 'diamond',
        outlineColor: '#111111',
        outlineWidth: 0,
      },
      line: {
        color: '#222222',
        width: 1,
        style: 'dash-dot',
      },
      fill: {
        color: '#333333',
        opacity: 1,
        style: 'cross',
        outlineColor: '#444444',
        outlineWidth: 16,
        outlineStyle: 'dot',
      },
    });
    expect(DEFAULT_ADVANCED_SKETCH_STYLE.point.color).toBe('#f17013');
  });

  test('uses current style as fallback for partial updates', () => {
    const first = normalizeAdvancedSketchStyle({ line: { width: 7 } });
    const second = normalizeAdvancedSketchStyle({ fill: { opacity: 0.25 } }, first);
    expect(second.line.width).toBe(7);
    expect(second.fill.opacity).toBe(0.25);
    expect(second.point).toEqual(DEFAULT_ADVANCED_SKETCH_STYLE.point);
  });

  test('builds ArcGIS point, line and polygon symbol contracts', () => {
    const style = normalizeAdvancedSketchStyle({
      point: { color: '#112233', size: 18, style: 'square' },
      line: { color: '#223344', width: 5, style: 'dash' },
      fill: {
        color: '#336699',
        opacity: 0.5,
        style: 'solid',
        outlineColor: '#445566',
        outlineWidth: 4,
        outlineStyle: 'dot',
      },
    });
    expect(buildPointSymbol(style)).toMatchObject({
      type: 'simple-marker',
      color: '#112233',
      size: 18,
      style: 'square',
    });
    expect(buildLineSymbol(style)).toEqual({
      type: 'simple-line',
      color: '#223344',
      width: 5,
      style: 'dash',
    });
    expect(buildPolygonSymbol(style)).toEqual({
      type: 'simple-fill',
      color: [51, 102, 153, 0.5],
      style: 'solid',
      outline: {
        color: '#445566',
        width: 4,
        style: 'dot',
      },
    });
  });
});

describe('AdvancedSketchRuntime tool lifecycle', () => {
  test('starts in deterministic selection mode and applies symbols', () => {
    const { session, vm } = createHarness();
    expect(session.snapshot()).toMatchObject({
      tool: 'select',
      phase: 'selecting',
      graphicCount: 0,
      selectionCount: 0,
    });
    expect(vm.pointSymbol).toMatchObject({ type: 'simple-marker' });
    expect(vm.polylineSymbol).toMatchObject({ type: 'simple-line' });
    expect(vm.polygonSymbol).toMatchObject({ type: 'simple-fill' });
    session.destroy();
  });

  test.each([
    ['point', 'point', 'click'],
    ['polyline', 'polyline', 'click'],
    ['polygon', 'polygon', 'click'],
    ['rectangle', 'rectangle', 'click'],
    ['circle', 'circle', 'click'],
    ['freehand', 'polyline', 'freehand'],
  ] as const)('maps %s to supported SketchViewModel create request', (tool, expectedTool, expectedMode) => {
    const { session, vm } = createHarness();
    expect(session.activateTool(tool)).toBe(true);
    expect(vm.cancel).toHaveBeenCalled();
    expect(vm.create).toHaveBeenLastCalledWith(expectedTool, { mode: expectedMode });
    expect(session.snapshot()).toMatchObject({ tool, phase: 'drawing' });
    session.destroy();
  });

  test('selection mode cancels active create without invalid create calls', () => {
    const { session, vm } = createHarness();
    session.activateTool('polygon');
    vi.mocked(vm.create!).mockClear();
    expect(session.activateTool('select')).toBe(true);
    expect(vm.cancel).toHaveBeenCalled();
    expect(vm.create).not.toHaveBeenCalled();
    expect(session.snapshot()).toMatchObject({
      tool: 'select',
      phase: 'selecting',
    });
    session.destroy();
  });

  test('rejects unknown tools at runtime', () => {
    const { session, vm } = createHarness();
    expect(session.activateTool('bad' as never)).toBe(false);
    expect(vm.create).not.toHaveBeenCalled();
    session.destroy();
  });

  test('tracks create lifecycle messages', () => {
    const { session, callbacks } = createHarness();
    session.activateTool('polygon');
    callbacks.get('create')?.({ state: 'active' });
    expect(session.snapshot()).toMatchObject({
      phase: 'drawing',
      message: 'Çizim devam ediyor.',
    });
    callbacks.get('create')?.({ state: 'complete' });
    expect(session.snapshot()).toMatchObject({
      phase: 'idle',
      message: 'Çizim haritaya eklendi.',
    });
    callbacks.get('create')?.({ state: 'cancel' });
    expect(session.snapshot().message).toBe('Çizim iptal edildi.');
    session.destroy();
  });

  test('tracks update lifecycle independently', () => {
    const { session, callbacks } = createHarness();
    callbacks.get('update')?.({ state: 'start' });
    expect(session.snapshot().phase).toBe('updating');
    callbacks.get('update')?.({ state: 'complete' });
    expect(session.snapshot()).toMatchObject({
      phase: 'selecting',
      message: 'Çizim güncellendi.',
    });
    session.destroy();
  });
});

describe('AdvancedSketchRuntime style application', () => {
  test('applies immutable style updates to future drawing symbols', () => {
    const { session, vm } = createHarness();
    const before = session.snapshot().style;
    const next = session.setStyle({
      line: { color: '#ff0000', width: 8, style: 'dash' },
      fill: { outlineColor: '#ff0000', outlineWidth: 8 },
    });

    expect(before.line.color).toBe('#514644');
    expect(next.line).toMatchObject({
      color: '#ff0000',
      width: 8,
      style: 'dash',
    });
    expect(vm.polylineSymbol).toEqual({
      type: 'simple-line',
      color: '#ff0000',
      width: 8,
      style: 'dash',
    });
    expect(vm.polygonSymbol).toMatchObject({
      outline: {
        color: '#ff0000',
        width: 8,
      },
    });
    session.destroy();
  });

  test('clamps unsafe numeric style values', () => {
    const { session } = createHarness();
    session.setStyle({
      point: { size: -100, outlineWidth: 100 },
      line: { width: 100 },
      fill: { opacity: -2 },
    });
    expect(session.snapshot().style).toMatchObject({
      point: { size: 4, outlineWidth: 12 },
      line: { width: 16 },
      fill: { opacity: 0 },
    });
    session.destroy();
  });

  test('reports symbol assignment failures without throwing into React', () => {
    const errors: unknown[] = [];
    const vm = {
      set pointSymbol(_value: unknown) { throw new Error('symbol write failed'); },
    } as SketchViewModelLike;
    expect(() => createAdvancedSketchSession({
      view: {},
      layer: {},
      sketchViewModel: vm,
      onError: (error) => errors.push(error),
    })).toThrow('symbol write failed');
    expect(errors).toEqual([]);
  });
});

describe('AdvancedSketchRuntime selection and editing', () => {
  test('selects only graphics owned by the drawing layer', async () => {
    const harness = createHarness();
    const ownedGraphic = { layer: harness.layer, id: 1 };
    vi.mocked(harness.view.hitTest!).mockResolvedValue({
      results: [
        { graphic: { layer: {}, id: 2 } },
        { graphic: ownedGraphic },
      ],
    });
    const selected = await harness.session.selectFromMapEvent({ x: 1, y: 2 });
    expect(selected).toBe(true);
    expect(harness.vm.update).toHaveBeenCalledWith(
      [ownedGraphic],
      { tool: 'transform', enableRotation: true },
    );
    expect(harness.session.snapshot()).toMatchObject({
      phase: 'updating',
      message: expect.stringContaining('Çizim seçildi'),
    });
    harness.session.destroy();
  });

  test('returns a stable empty-selection status when hitTest misses', async () => {
    const harness = createHarness();
    vi.mocked(harness.view.hitTest!).mockResolvedValue({ results: [] });
    await expect(harness.session.selectFromMapEvent({})).resolves.toBe(false);
    expect(harness.session.snapshot()).toMatchObject({
      phase: 'selecting',
      message: 'Bu konumda kullanıcı çizimi bulunamadı.',
    });
    harness.session.destroy();
  });

  test('ignores map selections while a drawing tool is active', async () => {
    const harness = createHarness();
    harness.session.activateTool('point');
    await expect(harness.session.selectFromMapEvent({})).resolves.toBe(false);
    expect(harness.view.hitTest).not.toHaveBeenCalled();
    harness.session.destroy();
  });

  test('view click delegates to selection only in selection mode', async () => {
    const harness = createHarness();
    const ownedGraphic = { layer: harness.layer };
    vi.mocked(harness.view.hitTest!).mockResolvedValue({
      results: [{ graphic: ownedGraphic }],
    });
    harness.viewCallbacks.get('click')?.({ mapPoint: {} });
    await vi.waitFor(() => {
      expect(harness.vm.update).toHaveBeenCalled();
    });
    harness.session.destroy();
  });

  test('turning to drawing mode prevents subsequent click selection', async () => {
    const harness = createHarness();
    harness.session.activateTool('polygon');
    harness.viewCallbacks.get('click')?.({});
    await Promise.resolve();
    expect(harness.view.hitTest).not.toHaveBeenCalled();
    harness.session.destroy();
  });

  test('reports hitTest rejection as a session error', async () => {
    const harness = createHarness();
    vi.mocked(harness.view.hitTest!).mockRejectedValue(new Error('hit test failed'));
    await expect(harness.session.selectFromMapEvent({})).resolves.toBe(false);
    expect(harness.session.snapshot()).toMatchObject({
      phase: 'error',
      error: 'hit test failed',
    });
    expect(harness.errors).toHaveLength(1);
    harness.session.destroy();
  });
});

describe('AdvancedSketchRuntime history and destructive actions', () => {
  test('uses SketchViewModel undo and redo capability gates', () => {
    const harness = createHarness();
    expect(harness.session.undo()).toBe(true);
    expect(harness.vm.undo).toHaveBeenCalledTimes(1);
    expect(harness.session.redo()).toBe(true);
    expect(harness.vm.redo).toHaveBeenCalledTimes(1);
    harness.session.destroy();
  });

  test('does not call undo when runtime says it is unavailable', () => {
    const harness = createHarness();
    vi.mocked(harness.vm.canUndo!).mockReturnValue(false);
    expect(harness.session.undo()).toBe(false);
    expect(harness.vm.undo).not.toHaveBeenCalled();
    harness.session.destroy();
  });

  test('deletes only when update selection exists', () => {
    const harness = createHarness();
    expect(harness.session.deleteSelection()).toBe(false);
    harness.setSelected([{ id: 1 }]);
    expect(harness.session.snapshot().selectionCount).toBe(1);
    expect(harness.session.deleteSelection()).toBe(true);
    expect(harness.vm.delete).toHaveBeenCalledTimes(1);
    harness.session.destroy();
  });

  test('clears owned layer graphics and cancels active work', () => {
    const harness = createHarness();
    harness.setGraphics([{ id: 1 }, { id: 2 }]);
    expect(harness.session.snapshot().graphicCount).toBe(2);
    expect(harness.session.clear()).toBe(true);
    expect(harness.layer.removeAll).toHaveBeenCalledTimes(1);
    expect(harness.vm.cancel).toHaveBeenCalled();
    expect(harness.session.snapshot().graphicCount).toBe(0);
    harness.session.destroy();
  });

  test('cancel preserves existing graphics', () => {
    const harness = createHarness();
    harness.setGraphics([{ id: 1 }]);
    expect(harness.session.cancel()).toBe(true);
    expect(harness.layer.removeAll).not.toHaveBeenCalled();
    expect(harness.session.snapshot().graphicCount).toBe(1);
    harness.session.destroy();
  });
});

describe('AdvancedSketchRuntime cleanup and error boundaries', () => {
  test('destroy removes event handles, cancels and destroys the view model', () => {
    const harness = createHarness();
    harness.session.destroy();
    expect(harness.callbacks.size).toBe(0);
    expect(harness.viewCallbacks.size).toBe(0);
    expect(harness.vm.cancel).toHaveBeenCalled();
    expect(harness.vm.destroy).toHaveBeenCalled();
    expect(harness.session.snapshot().phase).toBe('disposed');
  });

  test('destroy is idempotent', () => {
    const harness = createHarness();
    harness.session.destroy();
    harness.session.destroy();
    expect(harness.vm.destroy).toHaveBeenCalledTimes(1);
  });

  test('commands become no-ops after destroy', async () => {
    const harness = createHarness();
    harness.session.destroy();
    expect(harness.session.activateTool('point')).toBe(false);
    expect(harness.session.clear()).toBe(false);
    expect(harness.session.cancel()).toBe(false);
    expect(harness.session.undo()).toBe(false);
    expect(harness.session.redo()).toBe(false);
    expect(harness.session.deleteSelection()).toBe(false);
    await expect(harness.session.selectFromMapEvent({})).resolves.toBe(false);
  });

  test('synchronous create failures are captured and reported', () => {
    const harness = createHarness();
    vi.mocked(harness.vm.create!).mockImplementation(() => {
      throw new Error('create failed');
    });
    expect(harness.session.activateTool('polygon')).toBe(false);
    expect(harness.session.snapshot()).toMatchObject({
      phase: 'error',
      error: 'create failed',
    });
    expect(harness.errors).toHaveLength(1);
    harness.session.destroy();
  });

  test('clear failures do not escape the session boundary', () => {
    const errors: unknown[] = [];
    const layer: GraphicsLayerLike = {
      removeAll: () => {
        throw new Error('remove failed');
      },
    };
    const session = createAdvancedSketchSession({
      view: {},
      layer,
      sketchViewModel: {},
      onError: (error) => errors.push(error),
    });
    expect(session.clear()).toBe(false);
    expect(session.snapshot().error).toBe('remove failed');
    expect(errors).toHaveLength(1);
    session.destroy();
  });
});
