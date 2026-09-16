import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  classifyViewport,
  type ExperiencePreferences,
  type ExperienceViewport,
} from '../experienceRuntime';
import {
  activateSkipTarget,
  createLiveRegion,
  getMediaPreferenceSnapshot,
  installMediaPreferenceObserver,
  shouldHandleGlobalShortcut,
  type LivePoliteness,
  type MediaPreferenceSnapshot,
} from '../accessibilityRuntime';
import {
  experienceBus,
  getExperiencePreferences,
  subscribeExperiencePreferences,
} from '../experienceSession';
import {
  createExperienceRootContract,
  type WorkspacePresentation,
} from './experienceWorkspaceModel';

const DEFAULT_VIEWPORT_WIDTH = 1200;

export const useExperiencePreferences = (): ExperiencePreferences =>
  useSyncExternalStore(
    subscribeExperiencePreferences,
    getExperiencePreferences,
    getExperiencePreferences,
  );

export const useExperienceViewport = (): ExperienceViewport => {
  const [viewport, setViewport] = useState<ExperienceViewport>(() => classifyViewport(
    typeof window === 'undefined' ? DEFAULT_VIEWPORT_WIDTH : window.innerWidth,
  ));

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    let animationFrame = 0;
    const publish = (): void => {
      animationFrame = 0;
      setViewport(classifyViewport(window.innerWidth));
    };
    const onResize = (): void => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(publish);
    };

    window.addEventListener('resize', onResize, { passive: true });
    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return viewport;
};

export const useExperienceConnectivity = (): boolean => {
  const [online, setOnline] = useState<boolean>(() => (
    typeof navigator === 'undefined' ? true : navigator.onLine !== false
  ));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return undefined;
    const publish = (): void => setOnline(navigator.onLine !== false);
    window.addEventListener('online', publish);
    window.addEventListener('offline', publish);
    return () => {
      window.removeEventListener('online', publish);
      window.removeEventListener('offline', publish);
    };
  }, []);

  return online;
};

const DEFAULT_MEDIA: MediaPreferenceSnapshot = Object.freeze({
  reducedMotion: false,
  forcedColors: false,
  prefersDark: false,
  coarsePointer: false,
  hoverCapable: true,
});

export const useExperienceMediaPreferences = (): MediaPreferenceSnapshot => {
  const [media, setMedia] = useState<MediaPreferenceSnapshot>(() => (
    typeof window === 'undefined' ? DEFAULT_MEDIA : getMediaPreferenceSnapshot()
  ));

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    return installMediaPreferenceObserver(setMedia);
  }, []);

  return media;
};

export interface ExperienceAnnouncer {
  (message: string, politeness?: LivePoliteness): void;
}

export const useExperienceAnnouncements = (): ExperienceAnnouncer => {
  const regionRef = useRef<ReturnType<typeof createLiveRegion> | null>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    const liveRegion = createLiveRegion(document.body, {
      id: 'experience-global-live-region',
      politeness: 'polite',
    });
    regionRef.current = liveRegion;

    const release = experienceBus.on('kentrehberi:announcement', (detail) => {
      const message = String(detail?.message ?? '').trim();
      if (!message) return;
      liveRegion.announce(message, detail.politeness ?? 'polite');
    });

    return () => {
      release();
      if (regionRef.current === liveRegion) regionRef.current = null;
      liveRegion.destroy();
    };
  }, []);

  return useCallback((message: string, politeness: LivePoliteness = 'polite') => {
    const normalized = String(message ?? '').trim();
    if (normalized) regionRef.current?.announce(normalized, politeness);
  }, []);
};

export const focusExperienceTarget = (selector: string): boolean => {
  if (typeof document === 'undefined') return false;
  const target = document.querySelector(selector);
  return target instanceof HTMLElement ? activateSkipTarget(target) : false;
};

export const useExperienceGlobalShortcuts = (): void => {
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!shouldHandleGlobalShortcut(event)) return;
      const key = event.key.toLowerCase();

      if (event.altKey && key === 'm') {
        event.preventDefault();
        focusExperienceTarget('#esri-map-container');
        return;
      }
      if (event.altKey && key === 's') {
        event.preventDefault();
        focusExperienceTarget('#sidebar');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
};

const setDataset = (root: HTMLElement, key: string, value: string): void => {
  root.dataset[key] = value;
};

const updateThemeColorMeta = (color: string): void => {
  if (typeof document === 'undefined') return;
  const node = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (node) node.content = color;
};

export const useExperienceDocumentContract = (
  presentation: WorkspacePresentation,
): void => {
  const contract = useMemo(
    () => createExperienceRootContract(presentation),
    [presentation],
  );

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    const root = document.documentElement;
    setDataset(root, 'experienceTheme', contract.theme);
    setDataset(root, 'experienceDensity', contract.density);
    setDataset(root, 'experiencePanel', contract.panel);
    setDataset(root, 'experienceMotion', contract.motion);
    setDataset(root, 'experienceContrast', contract.contrast);
    setDataset(root, 'experiencePointer', contract.pointer);
    setDataset(root, 'experienceForcedColors', contract.forcedColors);
    root.style.colorScheme = contract.theme;
    updateThemeColorMeta(presentation.themeColor);

    return undefined;
  }, [contract, presentation.themeColor]);
};

export const useExperienceRuntimeSnapshot = (input: {
  preferences: ExperiencePreferences;
  viewport: ExperienceViewport;
  media: MediaPreferenceSnapshot;
  online: boolean;
}): void => {
  const { preferences, viewport, media, online } = input;

  useEffect(() => {
    const reducedMotion = preferences.motion === 'reduced'
      || (preferences.motion === 'system' && media.reducedMotion);

    experienceBus.emit('kentrehberi:runtime', {
      preferences,
      connectivity: online ? 'online' : 'offline',
      viewport,
      reducedMotion,
      forcedColors: media.forcedColors,
      coarsePointer: media.coarsePointer,
      standalone: typeof window !== 'undefined'
        ? Boolean(window.matchMedia?.('(display-mode: standalone)').matches)
        : false,
    });
  }, [media.coarsePointer, media.forcedColors, media.reducedMotion, online, preferences, viewport]);
};
