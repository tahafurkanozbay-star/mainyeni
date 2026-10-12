import { describe, expect, it } from 'vitest';
import { MapModeExperienceModel } from './mapModeExperienceModel';
import { resolveMapModePresentation } from './mapModePresentationPolicy';

const withModel = (
  configure?: (model: MapModeExperienceModel) => void,
): ReturnType<MapModeExperienceModel['getSnapshot']> => {
  const model = new MapModeExperienceModel();
  configure?.(model);
  return model.getSnapshot();
};

describe('resolveMapModePresentation', () => {
  it('uses floating 44px controls for the default desktop pointer profile', () => {
    const facts = resolveMapModePresentation(withModel());
    expect(facts).toMatchObject({
      layout: 'floating',
      targetSizePx: 44,
      motion: 'full',
      contrast: 'normal',
      statusRole: 'status',
      livePoliteness: 'polite',
      interactionState: 'ready',
      transitionSpeed: 'unknown',
      recoveryActionVisible: false,
      controlsDisabled: false,
      activeModeLabel: '2B',
      requestedModeLabel: null,
    });
    expect(Object.isFrozen(facts)).toBe(true);
  });

  it('uses a compact dock on compact viewports', () => {
    const facts = resolveMapModePresentation(withModel((model) => {
      model.setEnvironment({ viewport: 'compact' });
    }));
    expect(facts.layout).toBe('compact-dock');
  });

  it('keeps medium and wide viewports in floating layout', () => {
    const medium = resolveMapModePresentation(withModel((model) => {
      model.setEnvironment({ viewport: 'medium' });
    }));
    const wide = resolveMapModePresentation(withModel((model) => {
      model.setEnvironment({ viewport: 'wide' });
    }));
    expect(medium.layout).toBe('floating');
    expect(wide.layout).toBe('floating');
  });

  it('raises the interaction target contract to 48px for coarse pointers', () => {
    const facts = resolveMapModePresentation(withModel((model) => {
      model.setEnvironment({ coarsePointer: true });
    }));
    expect(facts.targetSizePx).toBe(48);
  });

  it('exposes reduced motion independently from viewport and pointer facts', () => {
    const facts = resolveMapModePresentation(withModel((model) => {
      model.setEnvironment({
        viewport: 'compact',
        coarsePointer: true,
        reducedMotion: true,
      });
    }));
    expect(facts).toMatchObject({
      layout: 'compact-dock',
      targetSizePx: 48,
      motion: 'reduced',
    });
  });

  it('exposes forced-colors as an explicit presentation contract', () => {
    const facts = resolveMapModePresentation(withModel((model) => {
      model.setEnvironment({ forcedColors: true });
    }));
    expect(facts.contrast).toBe('forced');
  });

  it('locks controls while a mode request is pending', () => {
    const facts = resolveMapModePresentation(withModel((model) => {
      model.requestMode('3d');
    }));
    expect(facts).toMatchObject({
      interactionState: 'locked',
      controlsDisabled: true,
      statusRole: 'status',
      livePoliteness: 'polite',
      requestedModeLabel: '3B',
      activeModeLabel: '2B',
    });
  });

  it('marks retryable errors as recoverable and assertive', () => {
    const facts = resolveMapModePresentation(withModel((model) => {
      const requestId = model.requestMode('3d');
      model.markTimeout(requestId!);
    }));
    expect(facts).toMatchObject({
      interactionState: 'recoverable',
      recoveryActionVisible: true,
      controlsDisabled: false,
      statusRole: 'alert',
      livePoliteness: 'assertive',
      requestedModeLabel: '3B',
    });
  });

  it('marks exhausted failures as terminal errors', () => {
    const model = new MapModeExperienceModel({ maxAttempts: 1 });
    const requestId = model.requestMode('3d');
    model.markTimeout(requestId!);

    const facts = resolveMapModePresentation(model.getSnapshot());
    expect(facts).toMatchObject({
      interactionState: 'terminal-error',
      recoveryActionVisible: false,
      statusRole: 'alert',
      livePoliteness: 'assertive',
    });
  });

  it('reports active and requested 2B labels deterministically', () => {
    const model = new MapModeExperienceModel({ initialMode: '3d' });
    model.requestMode('2d');
    const facts = resolveMapModePresentation(model.getSnapshot());
    expect(facts.activeModeLabel).toBe('3B');
    expect(facts.requestedModeLabel).toBe('2B');
  });

  it('classifies sub-120ms transitions as instant', () => {
    let now = 0;
    const model = new MapModeExperienceModel({ now: () => now });
    model.requestMode('3d');
    now = 119;
    model.confirmMode('3d');
    expect(resolveMapModePresentation(model.getSnapshot()).transitionSpeed).toBe('instant');
  });

  it('classifies 120-499ms transitions as fast', () => {
    let now = 0;
    const model = new MapModeExperienceModel({ now: () => now });
    model.requestMode('3d');
    now = 250;
    model.confirmMode('3d');
    expect(resolveMapModePresentation(model.getSnapshot()).transitionSpeed).toBe('fast');
  });

  it('classifies 500-1499ms transitions as noticeable', () => {
    let now = 0;
    const model = new MapModeExperienceModel({ now: () => now });
    model.requestMode('3d');
    now = 900;
    model.confirmMode('3d');
    expect(resolveMapModePresentation(model.getSnapshot()).transitionSpeed).toBe('noticeable');
  });

  it('classifies 1500ms and slower transitions as slow', () => {
    let now = 0;
    const model = new MapModeExperienceModel({ now: () => now });
    model.requestMode('3d');
    now = 2_300;
    model.confirmMode('3d');
    expect(resolveMapModePresentation(model.getSnapshot()).transitionSpeed).toBe('slow');
  });

  it('preserves the last transition speed through environment-only updates', () => {
    let now = 0;
    const model = new MapModeExperienceModel({ now: () => now });
    model.requestMode('3d');
    now = 700;
    model.confirmMode('3d');
    model.setEnvironment({ forcedColors: true, coarsePointer: true });

    expect(resolveMapModePresentation(model.getSnapshot())).toMatchObject({
      transitionSpeed: 'noticeable',
      contrast: 'forced',
      targetSizePx: 48,
    });
  });

  it('keeps late success events in ready interaction state', () => {
    const model = new MapModeExperienceModel();
    const requestId = model.requestMode('3d');
    model.markTimeout(requestId!);
    model.confirmMode('3d', 'late-success');

    expect(resolveMapModePresentation(model.getSnapshot())).toMatchObject({
      interactionState: 'ready',
      recoveryActionVisible: false,
      activeModeLabel: '3B',
      requestedModeLabel: null,
    });
  });
});
