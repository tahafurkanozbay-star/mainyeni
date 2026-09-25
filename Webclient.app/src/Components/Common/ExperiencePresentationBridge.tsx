import { useEffect, useMemo } from 'react';
import {
  createPresentationPreferenceModel,
  presentationDataAttributes,
  type PresentationEnvironmentInput,
  type PresentationPreferenceModel,
} from '../../experience/presentationPreferenceModel';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import './experience-presentation-bridge.css';

export interface ExperiencePresentationBridgeProps {
  readonly model?: PresentationPreferenceModel;
}

interface MediaSubscription {
  readonly matches: boolean;
  readonly addEventListener?: (type: 'change', listener: () => void) => void;
  readonly removeEventListener?: (type: 'change', listener: () => void) => void;
  readonly addListener?: (listener: () => void) => void;
  readonly removeListener?: (listener: () => void) => void;
}

const QUERIES = Object.freeze({
  reducedMotion: '(prefers-reduced-motion: reduce)',
  highContrast: '(prefers-contrast: more)',
  forcedColors: '(forced-colors: active)',
  coarsePointer: '(pointer: coarse)',
});

const ROOT_ATTRIBUTES = Object.freeze([
  'data-exp-motion',
  'data-exp-contrast',
  'data-exp-color-mode',
  'data-exp-pointer',
  'data-exp-viewport',
  'data-exp-density',
] as const);

const ROOT_CUSTOM_PROPERTIES = Object.freeze([
  '--exp-adaptive-target',
  '--exp-viewport-inline',
  '--exp-viewport-block',
] as const);

const browserEnvironment = (
  media: Readonly<Record<keyof typeof QUERIES, MediaSubscription>>,
): PresentationEnvironmentInput => ({
  reducedMotion: media.reducedMotion.matches,
  highContrast: media.highContrast.matches,
  forcedColors: media.forcedColors.matches,
  coarsePointer: media.coarsePointer.matches,
  viewportWidth: window.innerWidth,
  viewportHeight: window.innerHeight,
});

const subscribeMedia = (
  query: MediaSubscription,
  listener: () => void,
): (() => void) => {
  if (query.addEventListener && query.removeEventListener) {
    query.addEventListener('change', listener);
    return () => query.removeEventListener?.('change', listener);
  }
  if (query.addListener && query.removeListener) {
    query.addListener(listener);
    return () => query.removeListener?.(listener);
  }
  return () => undefined;
};

const rememberRootState = (root: HTMLElement) => {
  const attributes = new Map<string, string | null>();
  for (const name of ROOT_ATTRIBUTES) attributes.set(name, root.getAttribute(name));

  const properties = new Map<string, string>();
  for (const name of ROOT_CUSTOM_PROPERTIES) properties.set(name, root.style.getPropertyValue(name));

  return () => {
    for (const [name, value] of attributes) {
      if (value === null) root.removeAttribute(name);
      else root.setAttribute(name, value);
    }
    for (const [name, value] of properties) {
      if (value) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    }
  };
};

export const ExperiencePresentationBridge = ({
  model: suppliedModel,
}: ExperiencePresentationBridgeProps) => {
  const model = useMemo<PresentationPreferenceModel>(() => suppliedModel ?? createPresentationPreferenceModel({
    initial: {
      viewportWidth: typeof window === 'undefined' ? 1280 : window.innerWidth,
      viewportHeight: typeof window === 'undefined' ? 720 : window.innerHeight,
    },
    onObserverError(error) {
      runtimeDiagnostics.captureError(error, {
        source: 'experience.presentation-preference.observer',
      }, 'warn');
    },
  }), [suppliedModel]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    if (typeof window.matchMedia !== 'function') return undefined;

    const root = document.documentElement;
    const restoreRootState = rememberRootState(root);
    const media = {
      reducedMotion: window.matchMedia(QUERIES.reducedMotion),
      highContrast: window.matchMedia(QUERIES.highContrast),
      forcedColors: window.matchMedia(QUERIES.forcedColors),
      coarsePointer: window.matchMedia(QUERIES.coarsePointer),
    } satisfies Readonly<Record<keyof typeof QUERIES, MediaSubscription>>;

    let disposed = false;
    let resizeFrame: number | null = null;

    const synchronize = (): void => {
      if (disposed) return;
      model.replace(browserEnvironment(media));
    };

    const scheduleViewportSynchronize = (): void => {
      if (disposed || resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        synchronize();
      });
    };

    const unlistenMedia = Object.values(media).map((query) => subscribeMedia(query, synchronize));
    window.addEventListener('resize', scheduleViewportSynchronize, { passive: true });
    window.addEventListener('orientationchange', scheduleViewportSynchronize, { passive: true });

    const unsubscribe = model.subscribe((snapshot) => {
      const attributes = presentationDataAttributes(snapshot);
      for (const [name, value] of Object.entries(attributes)) root.setAttribute(name, value);
      root.style.setProperty('--exp-adaptive-target', `${snapshot.targetSizePx}px`);
      root.style.setProperty('--exp-viewport-inline', `${snapshot.viewportWidth}px`);
      root.style.setProperty('--exp-viewport-block', `${snapshot.viewportHeight}px`);

      runtimeDiagnostics.record('experience.presentation-preference.changed', {
        revision: snapshot.revision,
        motion: snapshot.motion,
        contrast: snapshot.contrast,
        colorMode: snapshot.colorMode,
        pointer: snapshot.pointer,
        viewport: snapshot.viewport,
        density: snapshot.density,
      });
    });

    synchronize();

    return () => {
      disposed = true;
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      window.removeEventListener('resize', scheduleViewportSynchronize);
      window.removeEventListener('orientationchange', scheduleViewportSynchronize);
      for (const unlisten of unlistenMedia) unlisten();
      unsubscribe();
      restoreRootState();
    };
  }, [model]);

  return null;
};

export default ExperiencePresentationBridge;
