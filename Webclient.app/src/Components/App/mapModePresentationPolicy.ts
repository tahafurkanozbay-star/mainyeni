import type { MapModeExperienceSnapshot } from './mapModeExperienceModel';

export type MapModeExperienceLayout = 'floating' | 'compact-dock';
export type MapModeExperienceMotion = 'full' | 'reduced';
export type MapModeExperienceContrast = 'normal' | 'forced';
export type MapModeTransitionSpeed = 'unknown' | 'instant' | 'fast' | 'noticeable' | 'slow';
export type MapModeInteractionState = 'ready' | 'locked' | 'recoverable' | 'terminal-error';

export interface MapModePresentationFacts {
  readonly layout: MapModeExperienceLayout;
  readonly targetSizePx: 44 | 48;
  readonly motion: MapModeExperienceMotion;
  readonly contrast: MapModeExperienceContrast;
  readonly statusRole: 'status' | 'alert';
  readonly livePoliteness: 'polite' | 'assertive';
  readonly interactionState: MapModeInteractionState;
  readonly transitionSpeed: MapModeTransitionSpeed;
  readonly recoveryActionVisible: boolean;
  readonly controlsDisabled: boolean;
  readonly activeModeLabel: '2B' | '3B';
  readonly requestedModeLabel: '2B' | '3B' | null;
}

const transitionSpeed = (durationMs: number | null): MapModeTransitionSpeed => {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return 'unknown';
  if (durationMs < 120) return 'instant';
  if (durationMs < 500) return 'fast';
  if (durationMs < 1_500) return 'noticeable';
  return 'slow';
};

const interactionState = (snapshot: MapModeExperienceSnapshot): MapModeInteractionState => {
  if (snapshot.phase === 'requesting') return 'locked';
  if (snapshot.phase !== 'error') return 'ready';
  return snapshot.canRetry ? 'recoverable' : 'terminal-error';
};

export const resolveMapModePresentation = (
  snapshot: MapModeExperienceSnapshot,
): MapModePresentationFacts => Object.freeze({
  layout: snapshot.environment.viewport === 'compact' ? 'compact-dock' : 'floating',
  targetSizePx: snapshot.environment.coarsePointer ? 48 : 44,
  motion: snapshot.environment.reducedMotion ? 'reduced' : 'full',
  contrast: snapshot.environment.forcedColors ? 'forced' : 'normal',
  statusRole: snapshot.phase === 'error' ? 'alert' : 'status',
  livePoliteness: snapshot.phase === 'error' ? 'assertive' : 'polite',
  interactionState: interactionState(snapshot),
  transitionSpeed: transitionSpeed(snapshot.lastTransitionMs),
  recoveryActionVisible: snapshot.phase === 'error' && snapshot.canRetry && snapshot.requestedMode !== null,
  controlsDisabled: snapshot.phase === 'requesting',
  activeModeLabel: snapshot.currentMode === '3d' ? '3B' : '2B',
  requestedModeLabel: snapshot.requestedMode === null ? null : snapshot.requestedMode === '3d' ? '3B' : '2B',
});
