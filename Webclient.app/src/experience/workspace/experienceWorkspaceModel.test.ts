import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPERIENCE_PREFERENCES,
  type ExperiencePreferences,
} from '../experienceRuntime';
import type { MediaPreferenceSnapshot } from '../accessibilityRuntime';
import {
  completeMapModeTransition,
  createExperienceRootContract,
  createInitialMapModeTransition,
  deriveWorkspacePresentation,
  failMapModeTransition,
  isMapModeTransitionExpired,
  nextExplicitTheme,
  requestMapModeTransition,
  workspaceStatusDescriptors,
} from './experienceWorkspaceModel';

const preferences = (
  patch: Partial<ExperiencePreferences> = {},
): ExperiencePreferences => ({
  ...DEFAULT_EXPERIENCE_PREFERENCES,
  ...patch,
});

const media = (
  patch: Partial<MediaPreferenceSnapshot> = {},
): MediaPreferenceSnapshot => ({
  reducedMotion: false,
  forcedColors: false,
  prefersDark: false,
  coarsePointer: false,
  hoverCapable: true,
  ...patch,
});

describe('experienceWorkspaceModel', () => {
  it('resolves system theme and automatic compact panel placement', () => {
    const presentation = deriveWorkspacePresentation({
      preferences: preferences({ theme: 'system', panelPlacement: 'auto' }),
      media: media({ prefersDark: true }),
      viewport: 'compact',
      online: true,
      mapMode: '2d',
      pendingMode: null,
    });

    expect(presentation.theme).toBe('dark');
    expect(presentation.panelPlacement).toBe('bottom');
    expect(presentation.themeColor).toBe('#121820');
    expect(presentation.connectionTone).toBe('success');
  });

  it('combines explicit and operating-system accessibility preferences', () => {
    const systemReduced = deriveWorkspacePresentation({
      preferences: preferences({ motion: 'system' }),
      media: media({ reducedMotion: true, forcedColors: true, coarsePointer: true }),
      viewport: 'medium',
      online: false,
      mapMode: '3d',
      pendingMode: '2d',
    });

    expect(systemReduced.reducedMotion).toBe(true);
    expect(systemReduced.contrast).toBe('high');
    expect(systemReduced.connectionLabel).toBe('Çevrimdışı');
    expect(systemReduced.connectionTone).toBe('warning');
    expect(systemReduced.mapModeLabel).toBe('3B sahne');

    const statuses = workspaceStatusDescriptors(systemReduced);
    expect(statuses.map((item) => item.key)).toEqual([
      'connectivity',
      'view',
      'accessibility',
      'pointer',
    ]);
  });

  it('honors explicit full motion even when the OS asks to reduce motion', () => {
    const presentation = deriveWorkspacePresentation({
      preferences: preferences({ motion: 'full', highContrastMapControls: false }),
      media: media({ reducedMotion: true }),
      viewport: 'wide',
      online: true,
      mapMode: '2d',
      pendingMode: null,
    });

    expect(presentation.reducedMotion).toBe(false);
    expect(presentation.contrast).toBe('normal');
  });

  it('creates a deterministic document contract for CSS and browser chrome', () => {
    const presentation = deriveWorkspacePresentation({
      preferences: preferences({ density: 'compact', highContrastMapControls: true }),
      media: media({ coarsePointer: true }),
      viewport: 'wide',
      online: true,
      mapMode: '2d',
      pendingMode: null,
    });

    expect(createExperienceRootContract(presentation)).toEqual({
      theme: 'light',
      density: 'compact',
      panel: 'right',
      motion: 'full',
      contrast: 'high',
      pointer: 'coarse',
      forcedColors: 'none',
    });
  });

  it('accepts one map-mode transition and rejects duplicate requests while busy', () => {
    const initial = createInitialMapModeTransition('2d');
    const requested = requestMapModeTransition(initial, '3d', 1000);

    expect(requested.accepted).toBe(true);
    expect(requested.state).toEqual({
      committed: '2d',
      pending: '3d',
      requestId: 1,
      requestedAt: 1000,
    });
    expect(requested.announcement).toContain('3B sahne');

    const duplicate = requestMapModeTransition(requested.state, '3d', 1200);
    const competing = requestMapModeTransition(requested.state, '2d', 1200);
    expect(duplicate.accepted).toBe(false);
    expect(competing.accepted).toBe(false);
    expect(competing.state).toBe(requested.state);
  });

  it('commits the authoritative map-mode event and clears pending state', () => {
    const requested = requestMapModeTransition(
      createInitialMapModeTransition('2d'),
      '3d',
      500,
    );
    const completed = completeMapModeTransition(requested.state, '3d');

    expect(completed.state).toEqual({
      committed: '3d',
      pending: null,
      requestId: 1,
      requestedAt: null,
    });
    expect(completed.announcement).toBe('3B sahne etkin.');
  });

  it('fails closed on transition timeout and preserves the committed view', () => {
    const requested = requestMapModeTransition(
      createInitialMapModeTransition('3d'),
      '2d',
      10_000,
    );

    expect(isMapModeTransitionExpired(requested.state, 21_999, 12_000)).toBe(false);
    expect(isMapModeTransitionExpired(requested.state, 22_000, 12_000)).toBe(true);

    const failed = failMapModeTransition(requested.state);
    expect(failed.accepted).toBe(true);
    expect(failed.politeness).toBe('assertive');
    expect(failed.state.committed).toBe('3d');
    expect(failed.state.pending).toBeNull();
  });

  it('does not manufacture a failure when there is no pending transition', () => {
    const initial = createInitialMapModeTransition('2d');
    const failed = failMapModeTransition(initial);
    expect(failed.accepted).toBe(false);
    expect(failed.state).toBe(initial);
    expect(failed.announcement).toBeNull();
  });

  it('toggles explicit themes without introducing a second system preference state', () => {
    expect(nextExplicitTheme('light')).toBe('dark');
    expect(nextExplicitTheme('dark')).toBe('light');
  });
});
