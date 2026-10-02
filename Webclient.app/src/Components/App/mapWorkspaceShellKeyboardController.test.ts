import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MapWorkspaceShellModel, type MapWorkspaceLandmarkId } from './mapWorkspaceShellModel';
import {
  MapWorkspaceShellKeyboardController,
  resolveMapWorkspaceShellKeyboardIntent,
  resolveNextWorkspaceLandmark,
} from './mapWorkspaceShellKeyboardController';

const enable = (model: MapWorkspaceShellModel, ids: readonly MapWorkspaceLandmarkId[]) => {
  for (const id of ids) model.setLandmarkAvailability(id, true);
};

const successfulRuntime = () => ({
  focus: vi.fn((id: MapWorkspaceLandmarkId) => ({ ok: true, id, reason: 'focused' as const })),
});

describe('resolveMapWorkspaceShellKeyboardIntent', () => {
  it('maps F6 to forward focus cycling', () => {
    const event = new KeyboardEvent('keydown', { key: 'F6' });
    expect(resolveMapWorkspaceShellKeyboardIntent(event)).toEqual({ intent: 'focus-next', preventDefault: true });
  });

  it('maps Shift+F6 to reverse focus cycling', () => {
    const event = new KeyboardEvent('keydown', { key: 'F6', shiftKey: true });
    expect(resolveMapWorkspaceShellKeyboardIntent(event)).toEqual({ intent: 'focus-previous', preventDefault: true });
  });

  it.each([
    new KeyboardEvent('keydown', { key: 'F5' }),
    new KeyboardEvent('keydown', { key: 'F6', ctrlKey: true }),
    new KeyboardEvent('keydown', { key: 'F6', metaKey: true }),
    new KeyboardEvent('keydown', { key: 'F6', altKey: true }),
  ])('ignores unrelated or modified shortcuts', (event) => {
    expect(resolveMapWorkspaceShellKeyboardIntent(event).intent).toBe('none');
  });

  it('ignores already prevented events', () => {
    const event = new KeyboardEvent('keydown', { key: 'F6', cancelable: true });
    event.preventDefault();
    expect(resolveMapWorkspaceShellKeyboardIntent(event).intent).toBe('none');
  });
});

describe('resolveNextWorkspaceLandmark', () => {
  it('returns null when no landmark is available', () => {
    const model = new MapWorkspaceShellModel();
    expect(resolveNextWorkspaceLandmark(model.getSnapshot(), 'next')).toBeNull();
    expect(resolveNextWorkspaceLandmark(model.getSnapshot(), 'previous')).toBeNull();
  });

  it('starts forward cycling at the first available landmark', () => {
    const model = new MapWorkspaceShellModel();
    enable(model, ['search', 'sidebar']);
    expect(resolveNextWorkspaceLandmark(model.getSnapshot(), 'next')).toBe('search');
  });

  it('starts reverse cycling at the last available landmark', () => {
    const model = new MapWorkspaceShellModel();
    enable(model, ['search', 'sidebar']);
    expect(resolveNextWorkspaceLandmark(model.getSnapshot(), 'previous')).toBe('sidebar');
  });

  it('wraps forward at the end of the available set', () => {
    const model = new MapWorkspaceShellModel();
    enable(model, ['map', 'search', 'toolbar']);
    model.setActiveLandmark('toolbar');
    expect(resolveNextWorkspaceLandmark(model.getSnapshot(), 'next')).toBe('map');
  });

  it('wraps reverse at the beginning of the available set', () => {
    const model = new MapWorkspaceShellModel();
    enable(model, ['map', 'search', 'toolbar']);
    model.setActiveLandmark('map');
    expect(resolveNextWorkspaceLandmark(model.getSnapshot(), 'previous')).toBe('toolbar');
  });
});

describe('MapWorkspaceShellKeyboardController', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('focuses the first available landmark on F6', () => {
    const model = new MapWorkspaceShellModel();
    enable(model, ['map', 'search']);
    const runtime = successfulRuntime();
    const controller = new MapWorkspaceShellKeyboardController(model, runtime);
    controller.attach();
    const event = new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(runtime.focus).toHaveBeenCalledWith('map');
    expect(controller.getDiagnostics()).toMatchObject({ handledCount: 1, successfulFocusCount: 1, failedFocusCount: 0, lastTargetId: 'map' });
    controller.dispose();
  });

  it('cycles from current active landmark to the next available target', () => {
    const model = new MapWorkspaceShellModel();
    enable(model, ['map', 'search', 'sidebar']);
    model.setActiveLandmark('search');
    const runtime = successfulRuntime();
    const controller = new MapWorkspaceShellKeyboardController(model, runtime);
    controller.attach();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true }));
    expect(runtime.focus).toHaveBeenLastCalledWith('sidebar');
    controller.dispose();
  });

  it('cycles backward with Shift+F6', () => {
    const model = new MapWorkspaceShellModel();
    enable(model, ['map', 'search', 'sidebar']);
    model.setActiveLandmark('search');
    const runtime = successfulRuntime();
    const controller = new MapWorkspaceShellKeyboardController(model, runtime);
    controller.attach();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', shiftKey: true, bubbles: true, cancelable: true }));
    expect(runtime.focus).toHaveBeenLastCalledWith('map');
    controller.dispose();
  });

  it('does not consume F6 while an editable control owns the event', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const model = new MapWorkspaceShellModel();
    enable(model, ['map']);
    const runtime = successfulRuntime();
    const controller = new MapWorkspaceShellKeyboardController(model, runtime);
    controller.attach();
    const event = new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(runtime.focus).not.toHaveBeenCalled();
    expect(controller.getDiagnostics().skippedEditableCount).toBe(1);
    controller.dispose();
  });

  it('does not consume F6 while a textarea owns the event', () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    const model = new MapWorkspaceShellModel();
    enable(model, ['map']);
    const runtime = successfulRuntime();
    const controller = new MapWorkspaceShellKeyboardController(model, runtime);
    controller.attach();
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true }));
    expect(runtime.focus).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('tries the next available landmark when one focus attempt fails', () => {
    const model = new MapWorkspaceShellModel();
    enable(model, ['map', 'search', 'sidebar']);
    const runtime = {
      focus: vi.fn((id: MapWorkspaceLandmarkId) => id === 'map'
        ? ({ ok: false, id, reason: 'focus-failed' as const })
        : ({ ok: true, id, reason: 'focused' as const })),
    };
    const controller = new MapWorkspaceShellKeyboardController(model, runtime);
    const result = controller.focusNext();
    expect(runtime.focus.mock.calls.map(([id]) => id)).toEqual(['map', 'search']);
    expect(result).toEqual({ ok: true, id: 'search', reason: 'focused' });
    expect(controller.getDiagnostics()).toMatchObject({ successfulFocusCount: 1, failedFocusCount: 1, lastTargetId: 'search' });
  });

  it('bounds failed focus attempts to the available landmark count', () => {
    const model = new MapWorkspaceShellModel();
    enable(model, ['map', 'search', 'sidebar']);
    const runtime = {
      focus: vi.fn((id: MapWorkspaceLandmarkId) => ({ ok: false, id, reason: 'focus-failed' as const })),
    };
    const controller = new MapWorkspaceShellKeyboardController(model, runtime);
    const result = controller.focusNext();
    expect(runtime.focus).toHaveBeenCalledTimes(3);
    expect(result?.ok).toBe(false);
    expect(controller.getDiagnostics().failedFocusCount).toBe(3);
  });

  it('returns null without touching runtime when nothing is available', () => {
    const model = new MapWorkspaceShellModel();
    const runtime = successfulRuntime();
    const controller = new MapWorkspaceShellKeyboardController(model, runtime);
    expect(controller.focusNext()).toBeNull();
    expect(runtime.focus).not.toHaveBeenCalled();
  });

  it('attach is idempotent', () => {
    const model = new MapWorkspaceShellModel();
    enable(model, ['map']);
    const runtime = successfulRuntime();
    const controller = new MapWorkspaceShellKeyboardController(model, runtime);
    controller.attach();
    controller.attach();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true }));
    expect(runtime.focus).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('dispose removes the global key listener', () => {
    const model = new MapWorkspaceShellModel();
    enable(model, ['map']);
    const runtime = successfulRuntime();
    const controller = new MapWorkspaceShellKeyboardController(model, runtime);
    controller.attach();
    controller.dispose();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true }));
    expect(runtime.focus).not.toHaveBeenCalled();
    expect(controller.getDiagnostics().attached).toBe(false);
  });

  it('dispose is idempotent', () => {
    const model = new MapWorkspaceShellModel();
    const runtime = successfulRuntime();
    const controller = new MapWorkspaceShellKeyboardController(model, runtime);
    controller.attach();
    controller.dispose();
    controller.dispose();
    expect(controller.getDiagnostics().attached).toBe(false);
  });
});
