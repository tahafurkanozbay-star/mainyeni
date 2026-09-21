import { createGovernanceStateStore, type GovernanceStateStore } from './governanceState';
import { createGovernanceTelemetry, type GovernanceTelemetry } from './governanceTelemetry';
import {
  freezeArray,
  stableFingerprint,
  type FeatureEvaluation,
  type FeatureEvaluationContext,
  type GovernanceClock,
  type GovernanceKernelSnapshot,
  type GovernanceKernelState,
  type ReadinessSnapshot,
  defaultGovernanceClock,
} from './contracts';
import { createConfigSchemaRegistry, type ConfigRegistryOptions, type ConfigSchemaRegistry } from './schemaRegistry';
import { createFeaturePolicy, type FeaturePolicy, type FeaturePolicyOptions } from './featurePolicy';
import { createRuntimeManifestRegistry, type RuntimeManifestOptions, type RuntimeManifestRegistry } from './manifestRegistry';
import { createReadinessGate, type ReadinessGate, type ReadinessGateOptions } from './readinessGate';

export interface PlatformGovernanceKernelOptions {
  readonly clock?: GovernanceClock;
  readonly config?: ConfigRegistryOptions;
  readonly features?: FeaturePolicyOptions;
  readonly manifest?: RuntimeManifestOptions;
  readonly readiness?: ReadinessGateOptions;
  readonly telemetryCapacity?: number;
  readonly onListenerError?: (error: unknown) => void;
}

export interface GovernanceStartOptions {
  readonly configSource?: Readonly<Record<string, unknown>>;
  readonly rejectInvalidConfig?: boolean;
  readonly strictUnknownConfigKeys?: boolean;
}

export interface PlatformGovernanceKernel {
  readonly config: ConfigSchemaRegistry;
  readonly features: FeaturePolicy;
  readonly manifest: RuntimeManifestRegistry;
  readonly readiness: ReadinessGate;
  readonly telemetry: GovernanceTelemetry;
  readonly state: GovernanceStateStore;
  readonly start: (options?: GovernanceStartOptions) => GovernanceKernelSnapshot;
  readonly stop: () => GovernanceKernelSnapshot;
  readonly reconfigure: (source: Readonly<Record<string, unknown>>, options?: Omit<GovernanceStartOptions, 'configSource'>) => GovernanceKernelSnapshot;
  readonly evaluateFeature: (id: string, context?: FeatureEvaluationContext) => FeatureEvaluation;
  readonly recordReadiness: (id: string, status: 'pass' | 'fail' | 'unknown', options?: { readonly code?: string; readonly detail?: string; readonly observedAt?: number }) => ReadinessSnapshot;
  readonly snapshot: () => GovernanceKernelSnapshot;
  readonly dispose: () => void;
}

const initialState = (now: number): GovernanceKernelState => Object.freeze({
  phase: 'idle',
  generation: 0,
  configRevision: 0,
  featureRevision: 0,
  manifestRevision: 0,
  readinessState: 'unknown',
  startedAt: null,
  lastTransitionAt: now,
});

const validateKernelState = (state: Readonly<GovernanceKernelState>): void => {
  if (!['idle', 'starting', 'ready', 'degraded', 'blocked', 'stopped', 'disposed'].includes(state.phase)) {
    throw new TypeError('invalid governance kernel phase');
  }
  if (!Number.isSafeInteger(state.generation) || state.generation < 0) throw new RangeError('invalid governance generation');
  if (!Number.isSafeInteger(state.configRevision) || state.configRevision < 0) throw new RangeError('invalid config revision');
  if (!Number.isSafeInteger(state.featureRevision) || state.featureRevision < 0) throw new RangeError('invalid feature revision');
  if (!Number.isSafeInteger(state.manifestRevision) || state.manifestRevision < 0) throw new RangeError('invalid manifest revision');
};

const phaseFromReadiness = (readiness: ReadinessSnapshot): GovernanceKernelState['phase'] => {
  if (readiness.state === 'ready') return 'ready';
  if (readiness.state === 'degraded') return 'degraded';
  return 'blocked';
};

export const createPlatformGovernanceKernel = (
  options: PlatformGovernanceKernelOptions = {},
): PlatformGovernanceKernel => {
  const clock = options.clock ?? defaultGovernanceClock;
  const config = createConfigSchemaRegistry({ ...options.config, clock });
  const features = createFeaturePolicy(options.features);
  const manifest = createRuntimeManifestRegistry(options.manifest);
  const readiness = createReadinessGate({
    ...options.readiness,
    clock,
    onListenerError: options.readiness?.onListenerError ?? options.onListenerError,
  });
  const telemetry = createGovernanceTelemetry({
    capacity: options.telemetryCapacity ?? 400,
    clock,
  });
  const state = createGovernanceStateStore({
    initialState: initialState(clock.now()),
    clock,
    validate: validateKernelState,
    historyLimit: 64,
    onListenerError: options.onListenerError,
  });
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) throw new Error('platform governance kernel has been disposed');
  };

  const transition = (
    phase: GovernanceKernelState['phase'],
    reason: string,
    readinessSnapshot?: ReadinessSnapshot,
  ): void => {
    state.update((current) => ({
      ...current,
      phase,
      generation: current.generation + 1,
      configRevision: config.snapshot().revision,
      featureRevision: features.snapshot().revision,
      manifestRevision: manifest.snapshot().revision,
      readinessState: readinessSnapshot?.state ?? readiness.snapshot().state,
      startedAt: current.startedAt,
      lastTransitionAt: clock.now(),
    }), reason);
  };

  const kernelSnapshot = (): GovernanceKernelSnapshot => {
    const stateSnapshot = state.get();
    const configSnapshot = config.snapshot();
    const featureSnapshot = features.snapshot();
    const manifestSnapshot = manifest.snapshot();
    const readinessSnapshot = readiness.snapshot();
    const telemetrySnapshot = telemetry.summary();
    return Object.freeze({
      state: stateSnapshot,
      config: configSnapshot,
      features: featureSnapshot,
      manifest: manifestSnapshot,
      readiness: readinessSnapshot,
      telemetryEvents: telemetrySnapshot.totalEvents,
      fingerprint: stableFingerprint({
        state: stateSnapshot,
        config: configSnapshot.fingerprint,
        features: featureSnapshot.fingerprint,
        manifest: manifestSnapshot.fingerprint,
        readiness: readinessSnapshot.fingerprint,
      }),
    });
  };

  const synchronizeBuiltInReadiness = (): ReadinessSnapshot => {
    const configSnapshot = config.snapshot();
    const manifestSnapshot = manifest.snapshot();
    readiness.record('platform.config', configSnapshot.valid ? 'pass' : 'fail', {
      code: configSnapshot.valid ? 'CONFIG_VALID' : 'CONFIG_INVALID',
      detail: configSnapshot.valid ? 'configuration validated' : `${configSnapshot.issues.length} configuration issue(s)`,
    });
    return readiness.record('platform.manifest', manifestSnapshot.valid ? 'pass' : 'fail', {
      code: manifestSnapshot.valid ? 'MANIFEST_VALID' : 'MANIFEST_INVALID',
      detail: manifestSnapshot.valid ? 'runtime manifest validated' : `${manifestSnapshot.issues.length} manifest issue(s)`,
    });
  };

  const start = (startOptions: GovernanceStartOptions = {}): GovernanceKernelSnapshot => {
    assertActive();
    if (state.get().phase === 'ready' || state.get().phase === 'degraded') return kernelSnapshot();
    transition('starting', 'governance-starting');
    telemetry.info('governance', 'start', { phase: 'starting' });

    try {
      config.resolve(startOptions.configSource ?? {}, {
        rejectInvalid: startOptions.rejectInvalidConfig === true,
        strictUnknownKeys: startOptions.strictUnknownConfigKeys === true,
      });
      const readinessSnapshot = synchronizeBuiltInReadiness();
      const phase = phaseFromReadiness(readinessSnapshot);
      state.update((current) => ({
        ...current,
        phase,
        generation: current.generation + 1,
        configRevision: config.snapshot().revision,
        featureRevision: features.snapshot().revision,
        manifestRevision: manifest.snapshot().revision,
        readinessState: readinessSnapshot.state,
        startedAt: current.startedAt ?? clock.now(),
        lastTransitionAt: clock.now(),
      }), 'governance-started');
      telemetry.info('governance', 'started', {
        phase,
        result: readinessSnapshot.state,
        count: manifest.snapshot().components.length,
      });
      return kernelSnapshot();
    } catch (error) {
      telemetry.error('governance', 'start-failed', {
        result: 'failure',
        code: error instanceof Error ? error.name : 'error',
      });
      transition('blocked', 'governance-start-failed');
      throw error;
    }
  };

  const reconfigure = (
    source: Readonly<Record<string, unknown>>,
    reconfigureOptions: Omit<GovernanceStartOptions, 'configSource'> = {},
  ): GovernanceKernelSnapshot => {
    assertActive();
    const previous = config.snapshot();
    try {
      config.resolve(source, {
        rejectInvalid: reconfigureOptions.rejectInvalidConfig === true,
        strictUnknownKeys: reconfigureOptions.strictUnknownConfigKeys === true,
      });
      const readinessSnapshot = synchronizeBuiltInReadiness();
      const phase = phaseFromReadiness(readinessSnapshot);
      state.update((current) => ({
        ...current,
        phase,
        generation: current.generation + 1,
        configRevision: config.snapshot().revision,
        featureRevision: features.snapshot().revision,
        manifestRevision: manifest.snapshot().revision,
        readinessState: readinessSnapshot.state,
        startedAt: current.startedAt,
        lastTransitionAt: clock.now(),
      }), 'governance-reconfigured');
      telemetry.info('governance', 'reconfigured', {
        result: config.snapshot().valid ? 'success' : 'invalid',
        count: config.snapshot().issues.length,
      });
      return kernelSnapshot();
    } catch (error) {
      telemetry.warn('governance', 'reconfigure-rejected', {
        result: 'failure',
        count: previous.issues.length,
      });
      throw error;
    }
  };

  const stop = (): GovernanceKernelSnapshot => {
    assertActive();
    state.update((current) => ({
      ...current,
      phase: 'stopped',
      generation: current.generation + 1,
      readinessState: readiness.snapshot().state,
      lastTransitionAt: clock.now(),
    }), 'governance-stopped');
    telemetry.info('governance', 'stopped', { result: 'success' });
    return kernelSnapshot();
  };

  const evaluateFeature = (id: string, context: FeatureEvaluationContext = {}): FeatureEvaluation => {
    assertActive();
    const result = features.evaluate(id, context);
    telemetry.debug('feature', 'evaluated', {
      operation: result.id,
      result: result.enabled ? 'enabled' : 'disabled',
      reason: result.reason,
      count: result.bucket ?? 0,
    });
    return result;
  };

  const recordReadiness: PlatformGovernanceKernel['recordReadiness'] = (id, status, recordOptions = {}) => {
    assertActive();
    const readinessSnapshot = readiness.record(id, status, recordOptions);
    const current = state.get();
    if (current.phase !== 'idle' && current.phase !== 'stopped') {
      const phase = phaseFromReadiness(readinessSnapshot);
      if (phase !== current.phase) transition(phase, 'readiness-changed', readinessSnapshot);
    }
    telemetry.info('readiness', 'evidence', {
      operation: id,
      result: status,
      reason: recordOptions.code ?? 'none',
    });
    return readinessSnapshot;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    telemetry.info('governance', 'disposed', { result: 'success' });
    state.set({
      ...state.get(),
      phase: 'disposed',
      generation: state.get().generation + 1,
      lastTransitionAt: clock.now(),
    }, 'governance-disposed');
    readiness.dispose();
    manifest.dispose();
    features.dispose();
    config.dispose();
    state.dispose();
    telemetry.clear();
  };

  const kernel: PlatformGovernanceKernel = Object.freeze({
    config,
    features,
    manifest,
    readiness,
    telemetry,
    state,
    start,
    stop,
    reconfigure,
    evaluateFeature,
    recordReadiness,
    snapshot: () => {
      assertActive();
      return kernelSnapshot();
    },
    dispose,
  });

  readiness.subscribe((snapshot) => {
    if (disposed) return;
    const phase = state.get().phase;
    if (phase === 'idle' || phase === 'starting' || phase === 'stopped') return;
    const nextPhase = phaseFromReadiness(snapshot);
    if (nextPhase !== phase) transition(nextPhase, 'readiness-subscription', snapshot);
  });

  return kernel;
};

export const governanceSnapshotSummary = (snapshot: GovernanceKernelSnapshot): Readonly<Record<string, unknown>> =>
  Object.freeze({
    phase: snapshot.state.phase,
    generation: snapshot.state.generation,
    configValid: snapshot.config.valid,
    configIssueCount: snapshot.config.issues.length,
    manifestValid: snapshot.manifest.valid,
    componentCount: snapshot.manifest.components.length,
    readiness: snapshot.readiness.state,
    blockerCount: snapshot.readiness.blockers.length,
    degradedCount: snapshot.readiness.degraded.length,
    featureCount: snapshot.features.ruleCount,
    telemetryEvents: snapshot.telemetryEvents,
    fingerprint: snapshot.fingerprint,
  });

export const governanceBlockingReasons = (snapshot: GovernanceKernelSnapshot): readonly string[] =>
  freezeArray([
    ...snapshot.config.issues.map((item) => `config:${item.key}:${item.code}`),
    ...snapshot.manifest.issues.map((item) => `manifest:${item.componentId ?? 'root'}:${item.code}`),
    ...snapshot.readiness.blockers.map((id) => `readiness:${id}`),
  ]);
