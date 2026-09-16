import {
  resolveEffectiveTheme,
  resolvePanelPlacement,
  type ExperienceMapMode,
  type ExperiencePanelPlacement,
  type ExperiencePreferences,
  type ExperienceTheme,
  type ExperienceViewport,
} from '../experienceRuntime';
import type { MediaPreferenceSnapshot } from '../accessibilityRuntime';

export type WorkspaceTone = 'neutral' | 'success' | 'warning' | 'accent';
export type WorkspaceTheme = Exclude<ExperienceTheme, 'system'>;
export type ResolvedPanelPlacement = Exclude<ExperiencePanelPlacement, 'auto'>;
export type LivePoliteness = 'polite' | 'assertive';

export interface WorkspacePresentation {
  readonly theme: WorkspaceTheme;
  readonly panelPlacement: ResolvedPanelPlacement;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
  readonly coarsePointer: boolean;
  readonly density: ExperiencePreferences['density'];
  readonly contrast: 'high' | 'normal';
  readonly mapMode: ExperienceMapMode;
  readonly mapModeLabel: string;
  readonly pendingMode: ExperienceMapMode | null;
  readonly online: boolean;
  readonly connectionLabel: string;
  readonly connectionTone: WorkspaceTone;
  readonly themeColor: string;
}

export interface MapModeTransitionState {
  readonly committed: ExperienceMapMode;
  readonly pending: ExperienceMapMode | null;
  readonly requestId: number;
  readonly requestedAt: number | null;
}

export interface MapModeTransitionResult {
  readonly state: MapModeTransitionState;
  readonly accepted: boolean;
  readonly announcement: string | null;
  readonly politeness: LivePoliteness;
}

export interface ExperienceRootContract {
  readonly theme: WorkspaceTheme;
  readonly density: ExperiencePreferences['density'];
  readonly panel: ResolvedPanelPlacement;
  readonly motion: 'reduced' | 'full';
  readonly contrast: 'high' | 'normal';
  readonly pointer: 'coarse' | 'fine';
  readonly forcedColors: 'active' | 'none';
}

export interface WorkspaceStatusDescriptor {
  readonly key: 'connectivity' | 'view' | 'accessibility' | 'pointer';
  readonly label: string;
  readonly value: string;
  readonly tone: WorkspaceTone;
}

const LIGHT_THEME_COLOR = '#f7f9fc';
const DARK_THEME_COLOR = '#121820';

export const mapModeLabel = (mode: ExperienceMapMode): string =>
  mode === '3d' ? '3B sahne' : '2B harita';

export const deriveWorkspacePresentation = (input: {
  preferences: ExperiencePreferences;
  media: MediaPreferenceSnapshot;
  viewport: ExperienceViewport;
  online: boolean;
  mapMode: ExperienceMapMode;
  pendingMode: ExperienceMapMode | null;
}): WorkspacePresentation => {
  const theme = resolveEffectiveTheme(
    input.preferences.theme,
    input.media.prefersDark,
  ) as WorkspaceTheme;
  const panelPlacement = resolvePanelPlacement(
    input.preferences.panelPlacement,
    input.viewport,
  ) as ResolvedPanelPlacement;
  const reducedMotion = input.preferences.motion === 'reduced'
    || (input.preferences.motion === 'system' && input.media.reducedMotion);
  const contrast = input.preferences.highContrastMapControls || input.media.forcedColors
    ? 'high'
    : 'normal';

  return Object.freeze({
    theme,
    panelPlacement,
    reducedMotion,
    forcedColors: input.media.forcedColors,
    coarsePointer: input.media.coarsePointer,
    density: input.preferences.density,
    contrast,
    mapMode: input.mapMode,
    mapModeLabel: mapModeLabel(input.mapMode),
    pendingMode: input.pendingMode,
    online: input.online,
    connectionLabel: input.online ? 'Çevrimiçi' : 'Çevrimdışı',
    connectionTone: input.online ? 'success' : 'warning',
    themeColor: theme === 'dark' ? DARK_THEME_COLOR : LIGHT_THEME_COLOR,
  });
};

export const createExperienceRootContract = (
  presentation: WorkspacePresentation,
): ExperienceRootContract => Object.freeze({
  theme: presentation.theme,
  density: presentation.density,
  panel: presentation.panelPlacement,
  motion: presentation.reducedMotion ? 'reduced' : 'full',
  contrast: presentation.contrast,
  pointer: presentation.coarsePointer ? 'coarse' : 'fine',
  forcedColors: presentation.forcedColors ? 'active' : 'none',
});

export const workspaceStatusDescriptors = (
  presentation: WorkspacePresentation,
): readonly WorkspaceStatusDescriptor[] => {
  const statuses: WorkspaceStatusDescriptor[] = [
    {
      key: 'connectivity',
      label: 'Bağlantı',
      value: presentation.connectionLabel,
      tone: presentation.connectionTone,
    },
    {
      key: 'view',
      label: 'Görünüm',
      value: presentation.mapModeLabel,
      tone: 'accent',
    },
  ];

  if (presentation.forcedColors) {
    statuses.push({
      key: 'accessibility',
      label: 'Erişilebilirlik',
      value: 'Yüksek kontrast',
      tone: 'accent',
    });
  }

  if (presentation.coarsePointer) {
    statuses.push({
      key: 'pointer',
      label: 'Etkileşim',
      value: 'Dokunmatik',
      tone: 'neutral',
    });
  }

  return Object.freeze(statuses);
};

export const createInitialMapModeTransition = (
  mode: ExperienceMapMode,
): MapModeTransitionState => Object.freeze({
  committed: mode,
  pending: null,
  requestId: 0,
  requestedAt: null,
});

export const requestMapModeTransition = (
  current: MapModeTransitionState,
  nextMode: ExperienceMapMode,
  now = Date.now(),
): MapModeTransitionResult => {
  if (nextMode === current.committed || current.pending !== null) {
    return Object.freeze({
      state: current,
      accepted: false,
      announcement: null,
      politeness: 'polite' as const,
    });
  }

  const state = Object.freeze({
    committed: current.committed,
    pending: nextMode,
    requestId: current.requestId + 1,
    requestedAt: now,
  });

  return Object.freeze({
    state,
    accepted: true,
    announcement: `${mapModeLabel(nextMode)} hazırlanıyor.`,
    politeness: 'polite' as const,
  });
};

export const completeMapModeTransition = (
  current: MapModeTransitionState,
  mode: ExperienceMapMode,
): MapModeTransitionResult => Object.freeze({
  state: Object.freeze({
    committed: mode,
    pending: null,
    requestId: current.requestId,
    requestedAt: null,
  }),
  accepted: true,
  announcement: `${mapModeLabel(mode)} etkin.`,
  politeness: 'polite' as const,
});

export const failMapModeTransition = (
  current: MapModeTransitionState,
): MapModeTransitionResult => {
  if (current.pending === null) {
    return Object.freeze({
      state: current,
      accepted: false,
      announcement: null,
      politeness: 'polite' as const,
    });
  }

  return Object.freeze({
    state: Object.freeze({
      committed: current.committed,
      pending: null,
      requestId: current.requestId,
      requestedAt: null,
    }),
    accepted: true,
    announcement: 'Görünüm değişikliği tamamlanamadı. Mevcut harita görünümü korunuyor.',
    politeness: 'assertive' as const,
  });
};

export const isMapModeTransitionExpired = (
  state: MapModeTransitionState,
  now = Date.now(),
  timeoutMs = 12_000,
): boolean => state.pending !== null
  && state.requestedAt !== null
  && now - state.requestedAt >= Math.max(1_000, timeoutMs);

export const nextExplicitTheme = (theme: WorkspaceTheme): WorkspaceTheme =>
  theme === 'dark' ? 'light' : 'dark';

export const describePanelPlacement = (placement: ResolvedPanelPlacement): string => {
  if (placement === 'bottom') return 'Alt';
  if (placement === 'left') return 'Sol';
  return 'Sağ';
};

export const describeMotion = (reduced: boolean): string =>
  reduced ? 'Azaltılmış' : 'Standart';
