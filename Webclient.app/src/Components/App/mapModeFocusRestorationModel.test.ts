import { describe, expect, it, vi } from 'vitest';
import { createMapModeFocusRestorationModel, type MapModeFocusableTarget } from './mapModeFocusRestorationModel';

const target = (options: { connected?: boolean; disabled?: boolean; throws?: boolean } = {}): MapModeFocusableTarget & { focus: ReturnType<typeof vi.fn> } => {
  const focus = options.throws ? vi.fn(() => { throw new Error('focus failed'); }) : vi.fn();
  return {
    isConnected: options.connected !== false,
    disabled: options.disabled === true,
    focus,
  };
};

describe('MapModeFocusRestorationModel', () => {
  it('restores the captured control with preventScroll', () => {
    const model = createMapModeFocusRestorationModel();
    const button = target();
    expect(model.capture(button)).toBe(true);
    expect(model.restore()).toBe('captured');
    expect(button.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(model.getDiagnostics()).toMatchObject({ captureCount: 1, restoreCount: 1 });
  });

  it('uses a fallback when the captured node left the document', () => {
    const model = createMapModeFocusRestorationModel();
    const captured = target();
    const fallback = target();
    model.capture(captured);
    Object.defineProperty(captured, 'isConnected', { value: false });
    expect(model.restore(fallback)).toBe('fallback');
    expect(captured.focus).not.toHaveBeenCalled();
    expect(fallback.focus).toHaveBeenCalledTimes(1);
    expect(model.getDiagnostics().fallbackRestoreCount).toBe(1);
  });

  it('rejects disconnected and disabled capture targets', () => {
    const model = createMapModeFocusRestorationModel();
    expect(model.capture(target({ connected: false }))).toBe(false);
    expect(model.capture(target({ disabled: true }))).toBe(false);
    expect(model.getDiagnostics().captureCount).toBe(0);
  });

  it('clears a capture without focusing it', () => {
    const model = createMapModeFocusRestorationModel();
    const button = target();
    model.capture(button);
    model.clear();
    expect(model.restore()).toBe('skipped');
    expect(button.focus).not.toHaveBeenCalled();
  });

  it('falls back when focusing the captured control throws', () => {
    const model = createMapModeFocusRestorationModel();
    const broken = target({ throws: true });
    const fallback = target();
    model.capture(broken);
    expect(model.restore(fallback)).toBe('fallback');
    expect(model.getDiagnostics()).toMatchObject({ focusFailureCount: 1, fallbackRestoreCount: 1 });
  });

  it('records a skipped restore when no safe target exists', () => {
    const model = createMapModeFocusRestorationModel();
    expect(model.restore()).toBe('skipped');
    expect(model.getDiagnostics().skippedRestoreCount).toBe(1);
  });

  it('keeps diagnostics immutable', () => {
    const model = createMapModeFocusRestorationModel();
    model.capture(target());
    expect(Object.isFrozen(model.getDiagnostics())).toBe(true);
  });

  it('does not retain focus targets after dispose', () => {
    const model = createMapModeFocusRestorationModel();
    const button = target();
    model.capture(button);
    model.dispose();
    expect(model.restore()).toBe('skipped');
    expect(button.focus).not.toHaveBeenCalled();
    expect(model.getDiagnostics()).toMatchObject({ disposed: true, skippedRestoreCount: 1 });
  });

  it('rejects captures after dispose', () => {
    const model = createMapModeFocusRestorationModel();
    model.dispose();
    expect(model.capture(target())).toBe(false);
    expect(model.getDiagnostics().captureCount).toBe(0);
  });
});
