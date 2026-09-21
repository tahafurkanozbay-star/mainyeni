import { describe, expect, it, vi } from 'vitest';
import {
  applySceneQualityPolicy,
  createSceneExperienceRuntime,
  sceneBudgetLimitsForProfile,
  sceneQualityPolicyForProfile,
  type SceneExperienceView,
} from './sceneExperienceRuntime';
import {
  createAdaptivePerformanceRuntime,
  GIS_PERFORMANCE_PROFILE,
  type GisDeviceCapabilities,
} from './adaptivePerformanceRuntime';

const capabilities = (profile: 'eco' | 'balanced' | 'quality'): GisDeviceCapabilities => Object.freeze({
  memoryGb: profile === 'quality' ? 16 : profile === 'eco' ? 2 : 6,
  logicalCores: profile === 'quality' ? 12 : profile === 'eco' ? 2 : 6,
  reducedMotion: false,
  saveData: false,
  effectiveType: '4g',
  constrainedNetwork: false,
  profile,
});

const createView = (): SceneExperienceView & {
  watchers: Map<string, (value: unknown) => void>;
  recover: ReturnType<typeof vi.fn>;
} => {
  const watchers = new Map<string, (value: unknown) => void>();
  const recover = vi.fn(async () => undefined);
  return {
    qualityProfile: 'medium',
    environment: {
      atmosphereEnabled: true,
      starsEnabled: true,
      lighting: {
        directShadowsEnabled: false,
        cameraTrackingEnabled: true,
      },
    },
    watchers,
    recover,
    watch: (property: string, callback: (value: unknown) => void) => {
      watchers.set(property, callback);
      return { remove: () => watchers.delete(property) };
    },
    tryFatalErrorRecovery: recover,
  };
};

describe('sceneExperienceRuntime policies', () => {
  it('maps adaptive profiles to progressively richer SceneView policies', () => {
    const eco = sceneQualityPolicyForProfile(GIS_PERFORMANCE_PROFILE.ECO);
    const balanced = sceneQualityPolicyForProfile(GIS_PERFORMANCE_PROFILE.BALANCED);
    const quality = sceneQualityPolicyForProfile(GIS_PERFORMANCE_PROFILE.QUALITY);

    expect(eco.sdkQuality).toBe('low');
    expect(eco.directShadowsEnabled).toBe(false);
    expect(balanced.sdkQuality).toBe('medium');
    expect(quality.sdkQuality).toBe('high');
    expect(quality.directShadowsEnabled).toBe(true);
    expect(eco.budgetLimits.maxGpuBytes).toBeLessThan(balanced.budgetLimits.maxGpuBytes);
    expect(balanced.budgetLimits.maxGpuBytes).toBeLessThan(quality.budgetLimits.maxGpuBytes);
  });

  it('scales feature budgets from the shared adaptive GIS budget', () => {
    const limits = sceneBudgetLimitsForProfile(GIS_PERFORMANCE_PROFILE.BALANCED, {
      maxVisibleFeatures: 9_000,
      sceneQuality: 0.8,
    });
    expect(limits.maxFeatures).toBeGreaterThanOrEqual(72_000);
    expect(limits.maxDrawCalls).toBe(1_500);
  });

  it('applies quality, atmosphere and lighting without replacing environment objects', () => {
    const view = createView();
    const environment = view.environment;
    const lighting = environment?.lighting;

    applySceneQualityPolicy(view, sceneQualityPolicyForProfile(GIS_PERFORMANCE_PROFILE.QUALITY));

    expect(view.qualityProfile).toBe('high');
    expect(view.environment).toBe(environment);
    expect(view.environment?.lighting).toBe(lighting);
    expect(view.environment?.atmosphereEnabled).toBe(true);
    expect(view.environment?.starsEnabled).toBe(false);
    expect(view.environment?.lighting?.directShadowsEnabled).toBe(true);
    expect(view.environment?.lighting?.cameraTrackingEnabled).toBe(false);
  });
});

describe('sceneExperienceRuntime lifecycle', () => {
  it('starts and stops the frame sampler with 3D activation', () => {
    const view = createView();
    const scheduled = new Map<number, FrameRequestCallback>();
    let nextHandle = 0;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      nextHandle += 1;
      scheduled.set(nextHandle, callback);
      return nextHandle;
    });
    const cancelFrame = vi.fn((handle: number) => {
      scheduled.delete(handle);
    });

    const runtime = createSceneExperienceRuntime(view, { requestFrame, cancelFrame });
    expect(runtime.getSnapshot().active).toBe(false);

    runtime.setActive(true);
    expect(runtime.getSnapshot().active).toBe(true);
    expect(requestFrame).toHaveBeenCalledTimes(1);

    runtime.setActive(false);
    expect(cancelFrame).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().status).toBe('idle');
    runtime.dispose();
  });

  it('adapts down from quality under repeated long frames', () => {
    const view = createView();
    let clock = 0;
    const adaptive = createAdaptivePerformanceRuntime({
      now: () => clock,
      capabilities: capabilities('quality'),
      profile: GIS_PERFORMANCE_PROFILE.QUALITY,
      settings: {
        minSamples: 4,
        sampleWindow: 8,
        cooldownMs: 0,
        longFrameMs: 30,
        criticalFrameMs: 60,
        longFrameRatio: 0.25,
        criticalFrameRatio: 0.25,
      },
    });
    const runtime = createSceneExperienceRuntime(view, {
      adaptiveRuntime: adaptive,
      now: () => clock,
      requestFrame: () => 1,
      cancelFrame: () => undefined,
    });

    runtime.setActive(true);
    for (const duration of [80, 72, 65, 70, 66]) {
      clock += duration;
      runtime.recordFrame(duration);
    }

    expect(runtime.getSnapshot().profile).not.toBe(GIS_PERFORMANCE_PROFILE.QUALITY);
    expect(view.qualityProfile).not.toBe('high');
    runtime.dispose();
    adaptive.destroy();
  });

  it('supports explicit performance profile overrides', () => {
    const view = createView();
    const runtime = createSceneExperienceRuntime(view, {
      requestFrame: () => 1,
      cancelFrame: () => undefined,
    });

    runtime.setProfile(GIS_PERFORMANCE_PROFILE.ECO, 'test');
    expect(runtime.getSnapshot().profile).toBe(GIS_PERFORMANCE_PROFILE.ECO);
    expect(view.qualityProfile).toBe('low');

    runtime.setProfile(GIS_PERFORMANCE_PROFILE.QUALITY, 'test');
    expect(view.qualityProfile).toBe('high');
    runtime.dispose();
  });

  it('recovers lost WebGL contexts and reapplies the active policy', async () => {
    const view = createView();
    let clock = 10_000;
    const runtime = createSceneExperienceRuntime(view, {
      now: () => clock,
      recoveryCooldownMs: 500,
      requestFrame: () => 1,
      cancelFrame: () => undefined,
    });
    runtime.setActive(true);

    const recovered = await runtime.recoverFatalError();
    expect(recovered).toBe(true);
    expect(view.recover).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().recovery.successes).toBe(1);
    expect(runtime.getSnapshot().status).toBe('ready');

    clock += 100;
    expect(await runtime.recoverFatalError()).toBe(false);
    expect(view.recover).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('reacts to SceneView fatalError watchers', async () => {
    const view = createView();
    const runtime = createSceneExperienceRuntime(view, {
      now: () => 50_000,
      recoveryCooldownMs: 250,
      requestFrame: () => 1,
      cancelFrame: () => undefined,
    });

    view.watchers.get('fatalError')?.(new Error('context lost'));
    await Promise.resolve();
    await Promise.resolve();

    expect(view.recover).toHaveBeenCalledTimes(1);
    runtime.dispose();
    expect(view.watchers.has('fatalError')).toBe(false);
  });

  it('caps recovery attempts and enters degraded status after repeated failures', async () => {
    const view = createView();
    let clock = 1_000;
    view.recover.mockRejectedValue(new Error('GPU recovery failed'));
    const runtime = createSceneExperienceRuntime(view, {
      now: () => clock,
      recoveryCooldownMs: 250,
      maximumRecoveryAttempts: 2,
      requestFrame: () => 1,
      cancelFrame: () => undefined,
    });
    runtime.setActive(true);

    expect(await runtime.recoverFatalError()).toBe(false);
    clock += 500;
    expect(await runtime.recoverFatalError()).toBe(false);
    expect(runtime.getSnapshot().status).toBe('degraded');

    clock += 500;
    expect(await runtime.recoverFatalError()).toBe(false);
    expect(view.recover).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });
});


describe('sceneExperienceRuntime reactive watch boundary', () => {
  it('uses an injected reactive watcher instead of deprecated Accessor.watch', () => {
    const view = createView();
    const legacyWatch = vi.spyOn(view, 'watch');
    const remove = vi.fn();
    const accessorWatch = vi.fn(() => ({ remove }));

    const runtime = createSceneExperienceRuntime(view, {
      accessorWatch,
      requestFrame: () => 1,
      cancelFrame: () => undefined,
    });

    expect(accessorWatch).toHaveBeenCalledWith(view, 'fatalError', expect.any(Function));
    expect(legacyWatch).not.toHaveBeenCalled();

    runtime.dispose();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
