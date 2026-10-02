import { describe, expect, it } from 'vitest';
import { cycleWorkspaceLandmark, resolveWorkspaceEscapeTarget, resolveWorkspaceFocusRecovery, shouldRecoverWorkspaceFocus, workspaceFocusRecoveryLabel, workspaceFocusTargetForZone, workspaceLandmarkOrder } from './workspaceFocusRecoveryModel';

const base = { reason: 'dialog-close' as const, preferredZone: 'workspace' as const, originZone: 'tools' as const, modality: 'keyboard' as const, availableZones: ['workspace', 'tools', 'map'] as const, dialogDepth: 0, paletteOpen: false };

describe('workspaceFocusRecoveryModel', () => {
  it('prefers the requested available zone', () => {
    const decision = resolveWorkspaceFocusRecovery(base);
    expect(decision.target?.zone).toBe('workspace');
    expect(decision.shouldRestore).toBe(true);
    expect(decision.shouldShowFocusRing).toBe(true);
  });

  it('falls back to the origin when preferred zone is absent', () => {
    const decision = resolveWorkspaceFocusRecovery({ ...base, preferredZone: 'map', availableZones: ['tools'] });
    expect(decision.target?.zone).toBe('tools');
  });

  it('falls back through workspace, tools and map deterministically', () => {
    expect(resolveWorkspaceFocusRecovery({ ...base, preferredZone: 'dialog', originZone: 'unknown', availableZones: ['map'] }).target?.zone).toBe('map');
  });

  it('returns no target when no landmark is available', () => {
    const decision = resolveWorkspaceFocusRecovery({ ...base, availableZones: [] });
    expect(decision.target).toBeNull();
    expect(decision.shouldRestore).toBe(false);
    expect(decision.shouldShowFocusRing).toBe(false);
  });

  it('keeps focus inside an open dialog', () => {
    const decision = resolveWorkspaceFocusRecovery({ ...base, dialogDepth: 2, availableZones: ['workspace', 'dialog'] });
    expect(decision.target?.zone).toBe('dialog');
  });

  it('keeps focus inside an open command palette', () => {
    const decision = resolveWorkspaceFocusRecovery({ ...base, paletteOpen: true, availableZones: ['workspace', 'command-palette'] });
    expect(decision.target?.zone).toBe('command-palette');
  });

  it('prioritizes dialog over palette for nested modal safety', () => {
    const decision = resolveWorkspaceFocusRecovery({ ...base, dialogDepth: 1, paletteOpen: true, availableZones: ['dialog', 'command-palette'] });
    expect(decision.target?.zone).toBe('dialog');
  });

  it('shows focus ring only for keyboard modality', () => {
    expect(resolveWorkspaceFocusRecovery({ ...base, modality: 'pointer' }).shouldShowFocusRing).toBe(false);
    expect(resolveWorkspaceFocusRecovery({ ...base, modality: 'touch' }).shouldShowFocusRing).toBe(false);
  });

  it('deduplicates available zones before landmark cycling', () => {
    expect(workspaceLandmarkOrder(['map', 'workspace', 'map', 'tools', 'workspace'])).toEqual(['workspace', 'tools', 'map']);
  });

  it('cycles landmarks forward', () => {
    const zones = ['workspace', 'tools', 'map'] as const;
    expect(cycleWorkspaceLandmark('workspace', zones)).toBe('tools');
    expect(cycleWorkspaceLandmark('tools', zones)).toBe('map');
    expect(cycleWorkspaceLandmark('map', zones)).toBe('workspace');
  });

  it('cycles landmarks backward', () => {
    const zones = ['workspace', 'tools', 'map'] as const;
    expect(cycleWorkspaceLandmark('workspace', zones, true)).toBe('map');
    expect(cycleWorkspaceLandmark('map', zones, true)).toBe('tools');
  });

  it('enters first or last landmark from an unknown zone', () => {
    const zones = ['workspace', 'tools', 'map'] as const;
    expect(cycleWorkspaceLandmark('unknown', zones)).toBe('workspace');
    expect(cycleWorkspaceLandmark('unknown', zones, true)).toBe('map');
  });

  it('returns null when landmark set is empty', () => {
    expect(cycleWorkspaceLandmark('map', [])).toBeNull();
  });

  it('resolves escape to an active dialog first', () => {
    const decision = resolveWorkspaceEscapeTarget({ preferredZone: 'workspace', originZone: 'map', modality: 'keyboard', availableZones: ['dialog', 'map'], dialogDepth: 1, paletteOpen: false });
    expect(decision.target?.zone).toBe('dialog');
    expect(decision.reason).toBe('escape');
  });

  it('resolves escape to an active palette when no dialog exists', () => {
    const decision = resolveWorkspaceEscapeTarget({ preferredZone: 'workspace', originZone: 'map', modality: 'keyboard', availableZones: ['command-palette', 'map'], dialogDepth: 0, paletteOpen: true });
    expect(decision.target?.zone).toBe('command-palette');
  });

  it('requests recovery for disconnected focus', () => {
    expect(shouldRecoverWorkspaceFocus({ activeElementConnected: false, bodyHasFocus: false, modalOpen: false, paletteOpen: false })).toBe(true);
  });

  it('requests recovery when body owns focus', () => {
    expect(shouldRecoverWorkspaceFocus({ activeElementConnected: true, bodyHasFocus: true, modalOpen: false, paletteOpen: false })).toBe(true);
  });

  it('does not steal valid focus without an overlay', () => {
    expect(shouldRecoverWorkspaceFocus({ activeElementConnected: true, bodyHasFocus: false, modalOpen: false, paletteOpen: false })).toBe(false);
  });

  it('exposes deterministic selectors and fallbacks', () => {
    expect(workspaceFocusTargetForZone('map')).toEqual({ zone: 'map', selector: '#esri-map-container', fallbackSelector: 'main', preventScroll: true });
    expect(workspaceFocusTargetForZone('unknown')).toBeNull();
  });

  it('provides localized recovery labels', () => {
    const decision = resolveWorkspaceFocusRecovery(base);
    expect(workspaceFocusRecoveryLabel(decision)).toBe('Çalışma alanına dön');
    expect(workspaceFocusRecoveryLabel(resolveWorkspaceFocusRecovery({ ...base, availableZones: [] }))).toBe('Odak geri yüklenemedi');
  });
});
