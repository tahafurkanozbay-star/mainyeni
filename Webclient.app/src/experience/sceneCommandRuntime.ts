import type { SceneNavigateOptions, SceneNavigationRuntime } from '../gis-engine/sceneNavigationRuntime';
import type { ExperienceCommandDetail } from './experienceRuntime';

export interface SceneCommandRuntimeContext {
  navigation: SceneNavigationRuntime;
  focusMap: () => boolean;
  reducedMotion?: () => boolean;
  durationMs?: number;
}

const navigationOptions = (
  context: SceneCommandRuntimeContext,
  reason: string,
): SceneNavigateOptions => {
  const reduceMotion = context.reducedMotion?.() === true;
  return {
    animate: !reduceMotion,
    durationMs: reduceMotion ? 0 : Math.max(0, Number(context.durationMs) || 220),
    reason,
  };
};

/**
 * Executes commands that are owned by an active 3D SceneView.
 *
 * Keeping command translation outside the React bridge makes the navigation
 * contract independently testable and guarantees that home/zoom operations go
 * through the bounded SceneNavigationRuntime instead of calling SceneView.goTo
 * directly.
 */
export const executeSceneCommand = async (
  detail: ExperienceCommandDetail,
  context: SceneCommandRuntimeContext,
): Promise<boolean> => {
  if (detail.name === 'map-home') {
    return context.navigation.goHome(navigationOptions(context, 'command-home'));
  }

  if (detail.name === 'map-zoom-in') {
    return context.navigation.zoomBy(0.5, navigationOptions(context, 'command-zoom-in'));
  }

  if (detail.name === 'map-zoom-out') {
    return context.navigation.zoomBy(2, navigationOptions(context, 'command-zoom-out'));
  }

  if (detail.name === 'focus-map') return context.focusMap();
  return false;
};
