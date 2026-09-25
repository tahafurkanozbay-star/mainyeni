import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPresentationPreferenceModel } from '../../experience/presentationPreferenceModel';
import { ExperiencePresentationBridge } from './ExperiencePresentationBridge';

vi.mock('../../platform/runtime/runtimeDiagnostics', () => ({
  runtimeDiagnostics: {
    captureError: vi.fn(),
    record: vi.fn(),
  },
}));

interface MutableMediaQuery {
  matches: boolean;
  readonly listeners: Set<() => void>;
  readonly addEventListener: (type: 'change', listener: () => void) => void;
  readonly removeEventListener: (type: 'change', listener: () => void) => void;
  readonly emit: () => void;
}

const mediaQuery = (matches = false): MutableMediaQuery => {
  const listeners = new Set<() => void>();
  return {
    matches,
    listeners,
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
  };
};

const installMedia = () => {
  const queries = {
    reducedMotion: mediaQuery(false),
    highContrast: mediaQuery(false),
    forcedColors: mediaQuery(false),
    coarsePointer: mediaQuery(false),
  };
  const byQuery = new Map([
    ['(prefers-reduced-motion: reduce)', queries.reducedMotion],
    ['(prefers-contrast: more)', queries.highContrast],
    ['(forced-colors: active)', queries.forcedColors],
    ['(pointer: coarse)', queries.coarsePointer],
  ]);

  vi.stubGlobal('matchMedia', vi.fn((query: string) => byQuery.get(query)));
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => byQuery.get(query)),
  });

  return queries;
};

const setViewport = (width: number, height: number): void => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
};

describe('ExperiencePresentationBridge', () => {
  beforeEach(() => {
    setViewport(1366, 768);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const attribute of [
      'data-exp-motion',
      'data-exp-contrast',
      'data-exp-color-mode',
      'data-exp-pointer',
      'data-exp-viewport',
      'data-exp-density',
    ]) {
      document.documentElement.removeAttribute(attribute);
    }
    document.documentElement.style.removeProperty('--exp-adaptive-target');
    document.documentElement.style.removeProperty('--exp-viewport-inline');
    document.documentElement.style.removeProperty('--exp-viewport-block');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('mirrors browser presentation preferences into deterministic root attributes', () => {
    const media = installMedia();
    media.reducedMotion.matches = true;
    media.highContrast.matches = true;
    media.forcedColors.matches = true;
    media.coarsePointer.matches = true;
    setViewport(390, 844);

    render(<ExperiencePresentationBridge />);

    const root = document.documentElement;
    expect(root).toHaveAttribute('data-exp-motion', 'reduced');
    expect(root).toHaveAttribute('data-exp-contrast', 'more');
    expect(root).toHaveAttribute('data-exp-color-mode', 'forced');
    expect(root).toHaveAttribute('data-exp-pointer', 'coarse');
    expect(root).toHaveAttribute('data-exp-viewport', 'compact');
    expect(root).toHaveAttribute('data-exp-density', 'comfortable');
    expect(root.style.getPropertyValue('--exp-adaptive-target')).toBe('48px');
    expect(root.style.getPropertyValue('--exp-viewport-inline')).toBe('390px');
    expect(root.style.getPropertyValue('--exp-viewport-block')).toBe('844px');
  });

  test('reacts to motion and contrast media-query changes', () => {
    const media = installMedia();
    render(<ExperiencePresentationBridge />);

    expect(document.documentElement).toHaveAttribute('data-exp-motion', 'full');
    expect(document.documentElement).toHaveAttribute('data-exp-contrast', 'standard');

    media.reducedMotion.matches = true;
    media.highContrast.matches = true;
    act(() => {
      media.reducedMotion.emit();
      media.highContrast.emit();
    });

    expect(document.documentElement).toHaveAttribute('data-exp-motion', 'reduced');
    expect(document.documentElement).toHaveAttribute('data-exp-contrast', 'more');
  });

  test('reacts to pointer and forced-color changes without remounting', () => {
    const media = installMedia();
    render(<ExperiencePresentationBridge />);

    media.coarsePointer.matches = true;
    media.forcedColors.matches = true;
    act(() => media.coarsePointer.emit());
    act(() => media.forcedColors.emit());

    expect(document.documentElement).toHaveAttribute('data-exp-pointer', 'coarse');
    expect(document.documentElement).toHaveAttribute('data-exp-color-mode', 'forced');
    expect(document.documentElement.style.getPropertyValue('--exp-adaptive-target')).toBe('48px');
  });

  test('reclassifies the viewport after a browser resize', () => {
    installMedia();
    render(<ExperiencePresentationBridge />);
    expect(document.documentElement).toHaveAttribute('data-exp-viewport', 'wide');

    setViewport(700, 900);
    act(() => window.dispatchEvent(new Event('resize')));

    expect(document.documentElement).toHaveAttribute('data-exp-viewport', 'compact');
    expect(document.documentElement.style.getPropertyValue('--exp-viewport-inline')).toBe('700px');
  });

  test('uses the supplied model as the single presentation authority', () => {
    installMedia();
    const model = createPresentationPreferenceModel();
    render(<ExperiencePresentationBridge model={model} />);

    act(() => model.update({ highContrast: true }));
    expect(document.documentElement).toHaveAttribute('data-exp-contrast', 'more');
  });

  test('restores pre-existing root presentation state on unmount', () => {
    installMedia();
    const root = document.documentElement;
    root.setAttribute('data-exp-motion', 'legacy-value');
    root.style.setProperty('--exp-adaptive-target', '52px');

    const { unmount } = render(<ExperiencePresentationBridge />);
    expect(root).toHaveAttribute('data-exp-motion', 'full');
    expect(root.style.getPropertyValue('--exp-adaptive-target')).toBe('44px');

    unmount();
    expect(root).toHaveAttribute('data-exp-motion', 'legacy-value');
    expect(root.style.getPropertyValue('--exp-adaptive-target')).toBe('52px');
    expect(root).not.toHaveAttribute('data-exp-contrast');
  });

  test('detaches media and resize subscriptions on unmount', () => {
    const media = installMedia();
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<ExperiencePresentationBridge />);

    expect(media.reducedMotion.listeners.size).toBe(1);
    expect(media.highContrast.listeners.size).toBe(1);
    expect(media.forcedColors.listeners.size).toBe(1);
    expect(media.coarsePointer.listeners.size).toBe(1);

    unmount();

    expect(media.reducedMotion.listeners.size).toBe(0);
    expect(media.highContrast.listeners.size).toBe(0);
    expect(media.forcedColors.listeners.size).toBe(0);
    expect(media.coarsePointer.listeners.size).toBe(0);
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('orientationchange', expect.any(Function));
  });

  test('does not throw when matchMedia is unavailable', () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
    expect(() => render(<ExperiencePresentationBridge />)).not.toThrow();
  });
});
