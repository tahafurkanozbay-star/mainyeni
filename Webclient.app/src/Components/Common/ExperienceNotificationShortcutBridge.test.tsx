import { fireEvent, render } from '@testing-library/react';
import { ExperienceNotificationShortcutBridge } from './ExperienceNotificationShortcutBridge';

const mocks = vi.hoisted(() => ({ captureError: vi.fn() }));

vi.mock('../../platform/runtime/runtimeDiagnostics', () => ({
  runtimeDiagnostics: { captureError: mocks.captureError },
}));

describe('ExperienceNotificationShortcutBridge', () => {
  beforeEach(() => mocks.captureError.mockReset());

  test('dispatches the canonical notification command for Alt+N', () => {
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command', listener);
    render(<ExperienceNotificationShortcutBridge />);
    fireEvent.keyDown(window, { key: 'n', altKey: true });
    expect(listener).toHaveBeenCalledTimes(1);
    const firstEvent = listener.mock.calls[0]?.[0];
    expect(firstEvent).toBeInstanceOf(CustomEvent);
    expect((firstEvent as CustomEvent).detail).toEqual({
      name: 'notifications',
      source: 'keyboard',
    });
    window.removeEventListener('kentrehberi:command', listener);
  });

  test('allows discovery while focus is in an input', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command', listener);
    render(<ExperienceNotificationShortcutBridge />);
    fireEvent.keyDown(input, { key: 'N', altKey: true });
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('kentrehberi:command', listener);
    input.remove();
  });

  test('does not dispatch for conflicting modifiers', () => {
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command', listener);
    render(<ExperienceNotificationShortcutBridge />);
    fireEvent.keyDown(window, { key: 'n', altKey: true, ctrlKey: true });
    fireEvent.keyDown(window, { key: 'n', altKey: true, shiftKey: true });
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('kentrehberi:command', listener);
  });

  test('does not dispatch repeated or composing shortcuts', () => {
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command', listener);
    render(<ExperienceNotificationShortcutBridge />);
    fireEvent.keyDown(window, { key: 'n', altKey: true, repeat: true });
    fireEvent.keyDown(window, { key: 'n', altKey: true, isComposing: true });
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('kentrehberi:command', listener);
  });

  test('uses a supplied callback instead of dispatching', () => {
    const onOpen = vi.fn();
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command', listener);
    render(<ExperienceNotificationShortcutBridge onOpen={onOpen} />);
    fireEvent.keyDown(window, { key: 'n', altKey: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('kentrehberi:command', listener);
  });

  test('removes the listener on unmount', () => {
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command', listener);
    const { unmount } = render(<ExperienceNotificationShortcutBridge />);
    unmount();
    fireEvent.keyDown(window, { key: 'n', altKey: true });
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('kentrehberi:command', listener);
  });
});