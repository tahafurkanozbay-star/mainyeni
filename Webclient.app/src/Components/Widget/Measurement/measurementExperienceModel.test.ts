import { describe, expect, it, vi } from 'vitest';
import {
  MEASUREMENT_TOOLS,
  type MeasurementState,
} from '../../../gis-engine/measurementRuntime';
import {
  MeasurementExperienceModel,
  createMeasurementExperienceModel,
} from './measurementExperienceModel';

const runtimeState = (overrides: Partial<MeasurementState> = {}): MeasurementState => ({
  status: 'idle',
  activeTool: MEASUREMENT_TOOLS.NONE,
  error: null,
  createdAt: null,
  clearedAt: null,
  destroyedAt: null,
  ...overrides,
});

describe('MeasurementExperienceModel', () => {
  it('starts as a hidden immutable idle session', () => {
    const model = createMeasurementExperienceModel();
    const snapshot = model.getSnapshot();

    expect(snapshot).toEqual(expect.objectContaining({
      revision: 0,
      phase: 'idle',
      visible: false,
      viewReady: false,
      busy: false,
      activeTool: MEASUREMENT_TOOLS.NONE,
      requestedTool: MEASUREMENT_TOOLS.NONE,
      retryCount: 0,
      maxRetries: 3,
      canClear: false,
      canRetry: false,
      errorMessage: null,
      errorCode: null,
      modality: 'unknown',
      activity: [],
    }));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.activity)).toBe(true);
  });

  it('opens in waiting-map phase until a map view is ready', () => {
    const model = createMeasurementExperienceModel();
    model.open(false);

    const snapshot = model.getSnapshot();
    expect(snapshot.visible).toBe(true);
    expect(snapshot.phase).toBe('waiting-map');
    expect(snapshot.viewReady).toBe(false);
    expect(snapshot.announcement).toBe('Harita görünümünün hazır olması bekleniyor.');
    expect(snapshot.guidance).toMatch(/Harita görünümü hazırlanıyor/);
    expect(snapshot.activity.at(-1)).toEqual(expect.objectContaining({ kind: 'opened' }));
  });

  it('opens directly into the runtime phase when the map is ready', () => {
    const model = createMeasurementExperienceModel();
    model.open(true);

    expect(model.getSnapshot()).toEqual(expect.objectContaining({
      visible: true,
      viewReady: true,
      phase: 'idle',
    }));
  });

  it('moves waiting-map sessions to a usable phase when the view becomes ready', () => {
    const model = createMeasurementExperienceModel();
    model.open(false);
    model.setViewReady(true);

    const snapshot = model.getSnapshot();
    expect(snapshot.viewReady).toBe(true);
    expect(snapshot.phase).toBe('idle');
    expect(snapshot.guidance).toMatch(/Alan veya mesafe/);
  });

  it('returns to waiting-map when a ready view disappears', () => {
    const model = createMeasurementExperienceModel();
    model.open(true);
    model.syncRuntime(runtimeState({ status: 'ready' }));
    model.setViewReady(false);

    expect(model.getSnapshot()).toEqual(expect.objectContaining({
      viewReady: false,
      phase: 'waiting-map',
      errorMessage: null,
      errorCode: null,
    }));
  });

  it('tracks requested tools while an operation is loading', () => {
    const model = createMeasurementExperienceModel();
    model.open(true);
    model.beginOperation(MEASUREMENT_TOOLS.AREA);

    expect(model.getSnapshot()).toEqual(expect.objectContaining({
      phase: 'loading',
      busy: true,
      requestedTool: MEASUREMENT_TOOLS.AREA,
      activeTool: MEASUREMENT_TOOLS.NONE,
      canClear: false,
    }));
  });

  it('synchronizes the ArcGIS runtime without duplicating transport state', () => {
    const model = createMeasurementExperienceModel();
    model.open(true);
    model.beginOperation(MEASUREMENT_TOOLS.AREA);
    model.syncRuntime(runtimeState({
      status: 'ready',
      activeTool: MEASUREMENT_TOOLS.AREA,
      createdAt: '2026-10-01T12:00:00.000Z',
    }));

    const snapshot = model.getSnapshot();
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.busy).toBe(false);
    expect(snapshot.activeTool).toBe(MEASUREMENT_TOOLS.AREA);
    expect(snapshot.requestedTool).toBe(MEASUREMENT_TOOLS.AREA);
    expect(snapshot.canClear).toBe(true);
    expect(snapshot.announcement).toBe('Alan ölçümü etkin.');
    expect(snapshot.guidance).toMatch(/alanın köşelerini/);
    expect(snapshot.activity.at(-1)).toEqual(expect.objectContaining({
      kind: 'tool',
      tool: MEASUREMENT_TOOLS.AREA,
    }));
  });

  it('announces distance mode independently of area mode', () => {
    const model = createMeasurementExperienceModel();
    model.open(true);
    model.syncRuntime(runtimeState({ status: 'ready', activeTool: MEASUREMENT_TOOLS.DISTANCE }));

    expect(model.getSnapshot().announcement).toBe('Mesafe ölçümü etkin.');
    expect(model.getSnapshot().guidance).toMatch(/hattın noktalarını/);
  });

  it('records runtime clear transitions only when the tool changes', () => {
    const model = createMeasurementExperienceModel();
    model.open(true);
    model.syncRuntime(runtimeState({ status: 'ready', activeTool: MEASUREMENT_TOOLS.AREA }));
    const activityCount = model.getSnapshot().activity.length;

    model.syncRuntime(runtimeState({ status: 'ready', activeTool: MEASUREMENT_TOOLS.AREA }));
    expect(model.getSnapshot().activity).toHaveLength(activityCount);

    model.syncRuntime(runtimeState({ status: 'ready', activeTool: MEASUREMENT_TOOLS.NONE }));
    expect(model.getSnapshot().activity.at(-1)).toEqual(expect.objectContaining({ kind: 'clear' }));
  });

  it('can record an optimistic clear while keeping the view-ready state', () => {
    const model = createMeasurementExperienceModel();
    model.open(true);
    model.syncRuntime(runtimeState({ status: 'ready', activeTool: MEASUREMENT_TOOLS.DISTANCE }));
    model.recordClear();

    expect(model.getSnapshot()).toEqual(expect.objectContaining({
      phase: 'ready',
      activeTool: MEASUREMENT_TOOLS.NONE,
      requestedTool: MEASUREMENT_TOOLS.NONE,
      canClear: false,
      errorMessage: null,
    }));
  });

  it('sanitizes runtime error text and error codes', () => {
    const model = createMeasurementExperienceModel({ maxErrorLength: 64 });
    model.open(true);
    model.syncRuntime(runtimeState({
      status: 'error',
      error: {
        code: ' bad code:<script> ',
        message: '  Ölçüm\u0000 başarısız   oldu.  ',
      },
    }));

    const snapshot = model.getSnapshot();
    expect(snapshot.phase).toBe('error');
    expect(snapshot.errorMessage).toBe('Ölçüm başarısız oldu.');
    expect(snapshot.errorCode).toBe('BADCODESCRIPT');
    expect(snapshot.errorCode).toMatch(/^[A-Z0-9_-]+$/u);
    expect(snapshot.announcement).toContain('Ölçüm başarısız oldu.');
    expect(snapshot.canRetry).toBe(true);
  });

  it('sanitizes action errors without retaining arbitrary objects', () => {
    const model = createMeasurementExperienceModel();
    model.open(true);
    const error = Object.assign(new Error('  Bağlantı\n  kesildi  '), { code: 'NETWORK_01' });
    model.recordError(error);

    expect(model.getSnapshot()).toEqual(expect.objectContaining({
      phase: 'error',
      errorMessage: 'Bağlantı kesildi',
      errorCode: 'NETWORK_01',
    }));
    expect(model.getSnapshot().activity.at(-1)?.kind).toBe('error');
  });

  it('does not expose error details before a map view exists', () => {
    const model = createMeasurementExperienceModel();
    model.open(false);
    model.recordError(new Error('internal details'));

    expect(model.getSnapshot()).toEqual(expect.objectContaining({
      phase: 'waiting-map',
      errorMessage: null,
      errorCode: null,
      canRetry: false,
    }));
  });

  it('bounds retry attempts and exposes the current retry count', () => {
    const model = createMeasurementExperienceModel({ maxRetries: 2 });
    model.open(true);
    model.recordError(new Error('failed'));

    expect(model.recordRetry()).toBe(true);
    expect(model.getSnapshot()).toEqual(expect.objectContaining({
      retryCount: 1,
      maxRetries: 2,
      phase: 'loading',
      canRetry: false,
    }));

    model.recordError(new Error('failed again'));
    expect(model.recordRetry()).toBe(true);
    model.recordError(new Error('failed third time'));
    expect(model.getSnapshot()).toEqual(expect.objectContaining({
      retryCount: 2,
      canRetry: false,
    }));
    expect(model.recordRetry()).toBe(false);
  });

  it('resets retry budget after a successful runtime transition', () => {
    const model = createMeasurementExperienceModel({ maxRetries: 3 });
    model.open(true);
    model.recordError(new Error('failed'));
    expect(model.recordRetry()).toBe(true);
    model.syncRuntime(runtimeState({ status: 'ready', activeTool: MEASUREMENT_TOOLS.AREA }));

    expect(model.getSnapshot().retryCount).toBe(0);
  });

  it('supports an explicit zero-retry policy', () => {
    const model = createMeasurementExperienceModel({ maxRetries: 0 });
    model.open(true);
    model.recordError(new Error('failed'));

    expect(model.getSnapshot().maxRetries).toBe(0);
    expect(model.getSnapshot().canRetry).toBe(false);
    expect(model.recordRetry()).toBe(false);
  });

  it('clamps excessive configuration values', () => {
    const model = createMeasurementExperienceModel({
      maxRetries: 999,
      maxObservers: 999,
      historyLimit: 999,
      maxErrorLength: 9999,
    });
    model.open(true);
    model.recordError(new Error('x'.repeat(500)));

    expect(model.getSnapshot().maxRetries).toBe(6);
    expect(model.getSnapshot().errorMessage?.length).toBeLessThanOrEqual(320);
  });

  it('tracks keyboard and pointer modality without generating duplicate revisions', () => {
    const model = createMeasurementExperienceModel();
    const initialRevision = model.getSnapshot().revision;

    model.setInputModality('keyboard');
    const keyboardRevision = model.getSnapshot().revision;
    expect(keyboardRevision).toBe(initialRevision + 1);
    expect(model.getSnapshot().modality).toBe('keyboard');

    model.setInputModality('keyboard');
    expect(model.getSnapshot().revision).toBe(keyboardRevision);

    model.setInputModality('pointer');
    expect(model.getSnapshot().modality).toBe('pointer');
  });

  it('bounds activity history while keeping monotonically increasing ids', () => {
    const model = createMeasurementExperienceModel({ historyLimit: 3 });
    model.open(true);
    model.syncRuntime(runtimeState({ status: 'ready', activeTool: MEASUREMENT_TOOLS.AREA }));
    model.syncRuntime(runtimeState({ status: 'ready', activeTool: MEASUREMENT_TOOLS.NONE }));
    model.syncRuntime(runtimeState({ status: 'ready', activeTool: MEASUREMENT_TOOLS.DISTANCE }));
    model.recordClear();

    const activity = model.getSnapshot().activity;
    expect(activity).toHaveLength(3);
    expect(activity.map((entry) => entry.id)).toEqual(activity.map((entry) => entry.id).sort((a, b) => a - b));
    expect(activity.at(-1)?.kind).toBe('clear');
    expect(activity.every(Object.isFrozen)).toBe(true);
  });

  it('clamps activity history to at least one entry', () => {
    const model = createMeasurementExperienceModel({ historyLimit: 0 });
    model.open(true);
    model.close();
    expect(model.getSnapshot().activity).toHaveLength(1);
    expect(model.getSnapshot().activity[0]?.kind).toBe('closed');
  });

  it('notifies healthy observers even when an earlier observer throws', () => {
    const onObserverError = vi.fn();
    const model = createMeasurementExperienceModel({ onObserverError });
    const healthy = vi.fn();
    model.subscribe(() => {
      throw new TypeError('observer failed');
    });
    model.subscribe(healthy);

    model.open(true);

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(onObserverError).toHaveBeenCalledTimes(1);
    expect(model.getDiagnostics()).toEqual(expect.objectContaining({
      observerFailureCount: 1,
      reporterFailureCount: 0,
      lastObserverFailureRevision: model.getSnapshot().revision,
      lastObserverFailureKind: 'TypeError',
    }));
  });

  it('contains observer-error reporter failures instead of breaking state propagation', () => {
    const healthy = vi.fn();
    const model = createMeasurementExperienceModel({
      onObserverError() {
        throw new RangeError('reporter failed');
      },
    });
    model.subscribe(() => {
      throw new Error('observer failed');
    });
    model.subscribe(healthy);

    expect(() => model.open(true)).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getDiagnostics()).toEqual(expect.objectContaining({
      observerFailureCount: 1,
      reporterFailureCount: 1,
      lastObserverFailureKind: 'reporter:RangeError',
    }));
  });

  it('bounds observer cardinality and records rejected subscriptions', () => {
    const model = createMeasurementExperienceModel({ maxObservers: 2 });
    const first = vi.fn();
    const second = vi.fn();
    const rejected = vi.fn();

    const unsubscribeFirst = model.subscribe(first);
    model.subscribe(second);
    const unsubscribeRejected = model.subscribe(rejected);

    expect(model.getDiagnostics()).toEqual(expect.objectContaining({
      activeObserverCount: 2,
      rejectedObserverCount: 1,
    }));
    model.open(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(rejected).not.toHaveBeenCalled();

    unsubscribeRejected();
    unsubscribeFirst();
    expect(model.getDiagnostics().activeObserverCount).toBe(1);
  });

  it('treats duplicate observer subscriptions as one observer', () => {
    const model = createMeasurementExperienceModel({ maxObservers: 1 });
    const observer = vi.fn();
    const first = model.subscribe(observer);
    const second = model.subscribe(observer);

    expect(model.getDiagnostics().activeObserverCount).toBe(1);
    model.open(true);
    expect(observer).toHaveBeenCalledTimes(1);

    first();
    second();
    expect(model.getDiagnostics().activeObserverCount).toBe(0);
  });

  it('closes without destroying the reusable experience authority', () => {
    const model = createMeasurementExperienceModel();
    model.open(true);
    model.close();

    expect(model.getSnapshot()).toEqual(expect.objectContaining({
      visible: false,
      requestedTool: MEASUREMENT_TOOLS.NONE,
    }));
    model.open(true);
    expect(model.getSnapshot().visible).toBe(true);
  });

  it('resets runtime-facing state while preserving input modality', () => {
    const model = createMeasurementExperienceModel();
    model.setInputModality('keyboard');
    model.open(true);
    model.syncRuntime(runtimeState({ status: 'ready', activeTool: MEASUREMENT_TOOLS.AREA }));
    model.reset();

    expect(model.getSnapshot()).toEqual(expect.objectContaining({
      phase: 'idle',
      visible: false,
      viewReady: false,
      activeTool: MEASUREMENT_TOOLS.NONE,
      requestedTool: MEASUREMENT_TOOLS.NONE,
      retryCount: 0,
      modality: 'keyboard',
      activity: [],
    }));
  });

  it('reflects destroyed ArcGIS runtime state and disables actions', () => {
    const model = createMeasurementExperienceModel();
    model.open(true);
    model.syncRuntime(runtimeState({ status: 'destroyed', activeTool: MEASUREMENT_TOOLS.NONE }));

    expect(model.getSnapshot()).toEqual(expect.objectContaining({
      phase: 'destroyed',
      busy: false,
      canClear: false,
      canRetry: false,
      announcement: 'Ölçüm oturumu kapatıldı.',
    }));
  });

  it('disposes observers and rejects subsequent subscriptions and mutations', () => {
    const model = new MeasurementExperienceModel();
    const observer = vi.fn();
    model.subscribe(observer);
    model.dispose();
    const revision = model.getSnapshot().revision;
    const rejected = model.subscribe(vi.fn());

    model.open(true);
    model.recordError(new Error('ignored'));
    model.setInputModality('keyboard');
    rejected();

    expect(observer).not.toHaveBeenCalled();
    expect(model.getSnapshot().revision).toBe(revision);
    expect(model.getDiagnostics()).toEqual(expect.objectContaining({
      activeObserverCount: 0,
      rejectedObserverCount: 1,
      disposed: true,
    }));
  });
});
