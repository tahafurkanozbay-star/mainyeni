import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPERIENCE_COMMAND_EVENT, EXPERIENCE_MAP_MODE_EVENT } from '../../experience/experienceRuntime';
import { createViewState } from '../../gis-engine/viewState';
import { ExperienceMapModeGovernedOverlay } from './ExperienceMapModeGovernedOverlay';

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
}));

vi.mock('../../Store/Managers/MapManager', () => ({
  default: {
    GetViewStateBridge: vi.fn(() => ({ getState: mocks.getState })),
  },
}));

const sourceState = createViewState({
  mode: '2d',
  center: [32.85, 39.93],
  scale: 25000,
  basemapId: 'osm',
  selectedLayerId: 'parks',
  selectedObjectId: 42,
});

const targetState = createViewState({
  ...sourceState,
  mode: '3d',
  tilt: 48,
  scale: 30000,
});

const dispatchMode = (mode: '2d' | '3d', source = 'test-runtime'): void => {
  window.dispatchEvent(new CustomEvent(EXPERIENCE_MAP_MODE_EVENT, { detail: { mode, source } }));
};

const installMatchMedia = (matchesByQuery: Record<string, boolean> = {}): void => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: matchesByQuery[query] ?? false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
};

describe('ExperienceMapModeGovernedOverlay', () => {
  beforeEach(() => {
    mocks.getState.mockReset();
    mocks.getState.mockReturnValue(sourceState);
    installMatchMedia();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the governed 2B/3B control without creating another ArcGIS view', () => {
    render(<ExperienceMapModeGovernedOverlay />);
    expect(screen.getByRole('region', { name: 'Harita görünüm modu' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2B harita görünümüne geç' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('dispatches the canonical map-mode command from the 3B segment', async () => {
    const commands: unknown[] = [];
    const listener = (event: Event): void => {
      commands.push((event as CustomEvent).detail);
      dispatchMode('3d');
    };
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, listener);
    render(<ExperienceMapModeGovernedOverlay />);
    fireEvent.click(screen.getByRole('button', { name: '3B sahne görünümüne geç' }));
    await waitFor(() => expect(commands).toHaveLength(1));
    expect(commands[0]).toMatchObject({ name: 'map-mode', mode: '3d', source: 'governed-map-mode-control' });
    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, listener);
  });

  it('publishes the completed mode as pressed after runtime acknowledgement', async () => {
    const listener = (): void => dispatchMode('3d');
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, listener);
    render(<ExperienceMapModeGovernedOverlay />);
    fireEvent.click(screen.getByRole('button', { name: '3B sahne görünümüne geç' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '3B sahne görünümüne geç' })).toHaveAttribute('aria-pressed', 'true'));
    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, listener);
  });

  it('adopts external mode events when no governed transition is busy', async () => {
    render(<ExperienceMapModeGovernedOverlay />);
    act(() => dispatchMode('3d', 'command-center'));
    await waitFor(() => expect(screen.getByRole('button', { name: '3B sahne görünümüne geç' })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('assesses continuity after a successful transition', async () => {
    let reads = 0;
    mocks.getState.mockImplementation(() => {
      reads += 1;
      return reads === 1 ? sourceState : targetState;
    });
    const listener = (): void => dispatchMode('3d');
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, listener);
    render(<ExperienceMapModeGovernedOverlay />);
    fireEvent.click(screen.getByRole('button', { name: '3B sahne görünümüne geç' }));
    const continuity = await screen.findByLabelText('Harita görünüm sürekliliği');
    expect(continuity).toHaveAttribute('data-status', 'preserved');
    expect(continuity).toHaveTextContent('Konum korundu');
    expect(continuity).toHaveTextContent('100/100');
    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, listener);
  });

  it('shows degraded continuity when contextual state changes unexpectedly', async () => {
    let reads = 0;
    mocks.getState.mockImplementation(() => {
      reads += 1;
      return reads === 1 ? sourceState : createViewState({ ...targetState, center: null, basemapId: 'other' });
    });
    const listener = (): void => dispatchMode('3d');
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, listener);
    render(<ExperienceMapModeGovernedOverlay />);
    fireEvent.click(screen.getByRole('button', { name: '3B sahne görünümüne geç' }));
    const continuity = await screen.findByLabelText('Harita görünüm sürekliliği');
    expect(continuity).toHaveAttribute('data-status', 'degraded');
    expect(continuity).toHaveTextContent('Konum kontrol edildi');
    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, listener);
  });

  it('keeps continuity UI absent before the first completed transition', () => {
    render(<ExperienceMapModeGovernedOverlay />);
    expect(screen.queryByLabelText('Harita görünüm sürekliliği')).not.toBeInTheDocument();
  });

  it('exposes reduced-motion, forced-colors and coarse-pointer facts from matchMedia', () => {
    installMatchMedia({
      '(prefers-reduced-motion: reduce)': true,
      '(forced-colors: active)': true,
      '(pointer: coarse)': true,
    });
    render(<ExperienceMapModeGovernedOverlay />);
    const region = screen.getByRole('region', { name: 'Harita görünüm modu' });
    expect(region).toHaveAttribute('data-reduced-motion', 'true');
    expect(region).toHaveAttribute('data-forced-colors', 'true');
    expect(region).toHaveAttribute('data-coarse-pointer', 'true');
  });

  it('times out a transition and exposes a bounded recovery action', async () => {
    vi.useFakeTimers();
    render(<ExperienceMapModeGovernedOverlay transitionTimeoutMs={2000} />);
    fireEvent.click(screen.getByRole('button', { name: '3B sahne görünümüne geç' }));
    await act(async () => { vi.advanceTimersByTime(2000); await Promise.resolve(); });
    expect(screen.getByRole('alert')).toHaveTextContent('3B geçişi tamamlanamadı');
    expect(screen.getByRole('button', { name: '3B geçişini yeniden dene' })).toBeInTheDocument();
  });

  it('clamps tiny timeout requests to the safe minimum', async () => {
    vi.useFakeTimers();
    render(<ExperienceMapModeGovernedOverlay transitionTimeoutMs={1} />);
    fireEvent.click(screen.getByRole('button', { name: '3B sahne görünümüne geç' }));
    await act(async () => { vi.advanceTimersByTime(1999); await Promise.resolve(); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('does not complete on an unrelated mode event', async () => {
    vi.useFakeTimers();
    render(<ExperienceMapModeGovernedOverlay transitionTimeoutMs={2000} />);
    fireEvent.click(screen.getByRole('button', { name: '3B sahne görünümüne geç' }));
    act(() => dispatchMode('2d'));
    expect(screen.getByRole('region', { name: 'Harita görünüm modu' })).toHaveAttribute('aria-busy', 'true');
    await act(async () => { vi.advanceTimersByTime(2000); await Promise.resolve(); });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('cleans global mode listeners on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<ExperienceMapModeGovernedOverlay />);
    unmount();
    expect(removeSpy).toHaveBeenCalledWith(EXPERIENCE_MAP_MODE_EVENT, expect.any(Function));
    removeSpy.mockRestore();
  });
});
