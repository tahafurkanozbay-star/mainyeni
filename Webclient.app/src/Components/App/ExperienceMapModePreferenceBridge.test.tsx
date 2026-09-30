import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXPERIENCE_COMMAND_EVENT,
  EXPERIENCE_MAP_MODE_EVENT,
  EXPERIENCE_PREFERENCE_EVENT,
  EXPERIENCE_STORAGE_KEY,
} from '../../experience/experienceRuntime';
import { ExperienceMapModePreferenceBridge } from './ExperienceMapModePreferenceBridge';

const dispatchMode = (mode: '2d' | '3d', source: string): void => {
  window.dispatchEvent(new CustomEvent(EXPERIENCE_MAP_MODE_EVENT, { detail: { mode, source } }));
};

const dispatchPreferences = (lastMapMode: '2d' | '3d'): void => {
  window.dispatchEvent(new CustomEvent(EXPERIENCE_PREFERENCE_EVENT, { detail: { lastMapMode } }));
};

describe('ExperienceMapModePreferenceBridge', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns no visual surface', () => {
    const { container } = render(<ExperienceMapModePreferenceBridge />);
    expect(container).toBeEmptyDOMElement();
  });

  it('restores persisted 3B after the runtime-ready 2B event', async () => {
    window.localStorage.setItem(EXPERIENCE_STORAGE_KEY, JSON.stringify({ lastMapMode: '3d' }));
    const commands: unknown[] = [];
    const listener = (event: Event): void => { commands.push((event as CustomEvent).detail); };
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, listener);
    render(<ExperienceMapModePreferenceBridge />);
    act(() => dispatchMode('2d', 'map-runtime-ready'));
    await waitFor(() => expect(commands).toHaveLength(1));
    expect(commands[0]).toMatchObject({ name: 'map-mode', mode: '3d', source: 'experience-preference-restore' });
    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, listener);
  });

  it('does not restore when persisted mode already matches runtime', async () => {
    window.localStorage.setItem(EXPERIENCE_STORAGE_KEY, JSON.stringify({ lastMapMode: '2d' }));
    const command = vi.fn();
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, command);
    render(<ExperienceMapModePreferenceBridge />);
    act(() => dispatchMode('2d', 'map-runtime-ready'));
    await Promise.resolve();
    expect(command).not.toHaveBeenCalled();
    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, command);
  });

  it('persists a successful 3B runtime event', () => {
    render(<ExperienceMapModePreferenceBridge />);
    act(() => dispatchMode('3d', 'map-runtime'));
    const serialized = window.localStorage.getItem(EXPERIENCE_STORAGE_KEY);
    expect(serialized).not.toBeNull();
    expect(JSON.parse(serialized ?? '{}').lastMapMode).toBe('3d');
  });

  it('persists a later 2B runtime event', () => {
    window.localStorage.setItem(EXPERIENCE_STORAGE_KEY, JSON.stringify({ lastMapMode: '3d' }));
    render(<ExperienceMapModePreferenceBridge />);
    act(() => dispatchMode('2d', 'map-runtime'));
    expect(JSON.parse(window.localStorage.getItem(EXPERIENCE_STORAGE_KEY) ?? '{}').lastMapMode).toBe('2d');
  });

  it('does not loop restore on repeated runtime-ready events', async () => {
    window.localStorage.setItem(EXPERIENCE_STORAGE_KEY, JSON.stringify({ lastMapMode: '3d' }));
    const commands: unknown[] = [];
    const listener = (event: Event): void => { commands.push((event as CustomEvent).detail); };
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, listener);
    render(<ExperienceMapModePreferenceBridge />);
    act(() => {
      dispatchMode('2d', 'map-runtime-ready');
      dispatchMode('2d', 'map-runtime-ready');
    });
    await waitFor(() => expect(commands).toHaveLength(1));
    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, listener);
  });

  it('applies an explicit preference event after runtime mode is known', async () => {
    const commands: unknown[] = [];
    const listener = (event: Event): void => { commands.push((event as CustomEvent).detail); };
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, listener);
    render(<ExperienceMapModePreferenceBridge />);
    act(() => dispatchMode('2d', 'map-runtime-ready'));
    act(() => dispatchPreferences('3d'));
    await waitFor(() => expect(commands).toHaveLength(1));
    expect(commands[0]).toMatchObject({ mode: '3d', source: 'experience-preference-change' });
    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, listener);
  });

  it('ignores preference events before runtime mode is known', () => {
    const command = vi.fn();
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, command);
    render(<ExperienceMapModePreferenceBridge />);
    act(() => dispatchPreferences('3d'));
    expect(command).not.toHaveBeenCalled();
    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, command);
  });

  it('ignores preference events that match the current runtime mode', () => {
    const command = vi.fn();
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, command);
    render(<ExperienceMapModePreferenceBridge />);
    act(() => dispatchMode('2d', 'map-runtime-ready'));
    act(() => dispatchPreferences('2d'));
    expect(command).not.toHaveBeenCalled();
    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, command);
  });

  it('normalizes partial preference event payloads', () => {
    const command = vi.fn();
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, command);
    render(<ExperienceMapModePreferenceBridge />);
    act(() => dispatchMode('3d', 'map-runtime'));
    act(() => {
      window.dispatchEvent(new CustomEvent(EXPERIENCE_PREFERENCE_EVENT, { detail: { lastMapMode: 'invalid' } }));
    });
    expect(command).toHaveBeenCalledTimes(1);
    expect((command.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({ mode: '2d' });
    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, command);
  });

  it('removes global listeners on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<ExperienceMapModePreferenceBridge />);
    unmount();
    expect(removeSpy).toHaveBeenCalledWith(EXPERIENCE_MAP_MODE_EVENT, expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith(EXPERIENCE_PREFERENCE_EVENT, expect.any(Function));
    removeSpy.mockRestore();
  });
});
