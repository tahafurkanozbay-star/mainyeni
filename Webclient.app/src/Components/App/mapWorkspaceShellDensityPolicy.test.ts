import { describe, expect, it } from 'vitest';
import { resolveMapWorkspaceShellDensity } from './mapWorkspaceShellDensityPolicy';

const base = {
  viewport: 'wide' as const,
  width: 1440,
  height: 900,
  coarsePointer: false,
  phase: 'ready' as const,
  utilityCollapsed: false,
  availableLandmarkCount: 6,
};

describe('resolveMapWorkspaceShellDensity', () => {
  it('uses full density on a normal desktop workspace', () => {
    expect(resolveMapWorkspaceShellDensity(base)).toEqual({
      density: 'full',
      reason: 'normal',
      showStatusDetail: true,
      showKeyboardHint: true,
      showActions: true,
      actionColumns: 6,
      minimumTargetSize: 44,
      preferHorizontalScroll: false,
    });
  });

  it('uses 48px minimum targets for coarse pointers', () => {
    expect(resolveMapWorkspaceShellDensity({ ...base, coarsePointer: true, width: 1200 }).minimumTargetSize).toBe(48);
  });

  it('honors explicit user collapse before viewport rules', () => {
    const decision = resolveMapWorkspaceShellDensity({ ...base, utilityCollapsed: true });
    expect(decision).toMatchObject({ density: 'status-only', reason: 'user-collapsed', showActions: false, actionColumns: 0 });
  });

  it('keeps useful status detail when a wide workspace is collapsed', () => {
    expect(resolveMapWorkspaceShellDensity({ ...base, utilityCollapsed: true }).showStatusDetail).toBe(true);
  });

  it('removes verbose status detail on very narrow collapsed screens', () => {
    expect(resolveMapWorkspaceShellDensity({ ...base, viewport: 'compact', width: 390, utilityCollapsed: true }).showStatusDetail).toBe(false);
  });

  it('uses status-only density while booting without available landmarks', () => {
    expect(resolveMapWorkspaceShellDensity({ ...base, phase: 'booting', availableLandmarkCount: 0 })).toMatchObject({
      density: 'status-only',
      reason: 'booting',
      showActions: false,
    });
  });

  it('uses status-only density when controls disappear after startup', () => {
    expect(resolveMapWorkspaceShellDensity({ ...base, availableLandmarkCount: 0 })).toMatchObject({
      density: 'status-only',
      reason: 'no-landmarks',
    });
  });

  it('uses compact density on compact viewport classification', () => {
    expect(resolveMapWorkspaceShellDensity({ ...base, viewport: 'compact', width: 640 })).toMatchObject({
      density: 'compact',
      reason: 'compact-viewport',
      actionColumns: 3,
      preferHorizontalScroll: true,
      showKeyboardHint: false,
    });
  });

  it('uses compact density for very short landscape screens', () => {
    expect(resolveMapWorkspaceShellDensity({ ...base, height: 480 })).toMatchObject({
      density: 'compact',
      reason: 'very-short-viewport',
      showStatusDetail: false,
    });
  });

  it('uses compact density on medium coarse-pointer devices', () => {
    expect(resolveMapWorkspaceShellDensity({ ...base, viewport: 'medium', width: 900, coarsePointer: true })).toMatchObject({
      density: 'compact',
      reason: 'coarse-medium-viewport',
      minimumTargetSize: 48,
      showKeyboardHint: false,
    });
  });

  it('keeps a large coarse-pointer desktop in full density', () => {
    expect(resolveMapWorkspaceShellDensity({ ...base, width: 1280, coarsePointer: true })).toMatchObject({
      density: 'full',
      showKeyboardHint: false,
      minimumTargetSize: 48,
    });
  });

  it('prioritizes short height over compact-width reason', () => {
    expect(resolveMapWorkspaceShellDensity({ ...base, viewport: 'compact', width: 390, height: 400 }).reason).toBe('very-short-viewport');
  });

  it('contains non-finite dimensions without changing desktop behavior', () => {
    expect(resolveMapWorkspaceShellDensity({ ...base, width: Number.NaN, height: Number.POSITIVE_INFINITY })).toMatchObject({
      density: 'full',
      reason: 'normal',
    });
  });

  it('never exposes keyboard hints on touch-oriented compact density', () => {
    const decision = resolveMapWorkspaceShellDensity({ ...base, viewport: 'compact', width: 412, coarsePointer: true });
    expect(decision.showKeyboardHint).toBe(false);
    expect(decision.minimumTargetSize).toBe(48);
  });

  it('keeps recovery controls available during error phase on normal desktop', () => {
    const decision = resolveMapWorkspaceShellDensity({ ...base, phase: 'error' });
    expect(decision).toMatchObject({ density: 'full', showActions: true, actionColumns: 6 });
  });

  it('keeps recovery controls available during error phase on compact screens', () => {
    const decision = resolveMapWorkspaceShellDensity({ ...base, phase: 'error', viewport: 'compact', width: 390 });
    expect(decision).toMatchObject({ density: 'compact', showActions: true, actionColumns: 3 });
  });

  it('returns immutable decisions', () => {
    expect(Object.isFrozen(resolveMapWorkspaceShellDensity(base))).toBe(true);
  });
});
