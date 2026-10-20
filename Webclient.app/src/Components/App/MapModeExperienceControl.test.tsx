import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXPERIENCE_COMMAND_EVENT,
  EXPERIENCE_MAP_MODE_EVENT,
  EXPERIENCE_RUNTIME_EVENT,
  type ExperienceCommandDetail,
} from '../../experience/experienceRuntime';
import { MapModeExperienceControl } from './MapModeExperienceControl';
import { MapModeExperienceModel } from './mapModeExperienceModel';

const dispatchModeChanged = (mode: '2d' | '3d', source = 'test-runtime'): void => {
  act(() => {
    window.dispatchEvent(new CustomEvent(EXPERIENCE_MAP_MODE_EVENT, {
      detail: { mode, source },
    }));
  });
};

const dispatchRuntime = (overrides: Partial<{
  viewport: 'compact' | 'medium' | 'wide';
  reducedMotion: boolean;
  forcedColors: boolean;
  coarsePointer: boolean;
}> = {}): void => {
  act(() => {
    window.dispatchEvent(new CustomEvent(EXPERIENCE_RUNTIME_EVENT, {
      detail: {
        preferences: {
          theme: 'system',
          density: 'comfortable',
          motion: 'system',
          panelPlacement: 'auto',
          lastMapMode: '2d',
          utilityCollapsed: false,
          showCoordinateReadout: true,
          highContrastMapControls: false,
        },
        connectivity: 'online',
        viewport: overrides.viewport ?? 'wide',
        reducedMotion: overrides.reducedMotion ?? false,
        forcedColors: overrides.forcedColors ?? false,
        coarsePointer: overrides.coarsePointer ?? false,
        standalone: false,
      },
    }));
  });
};

const get2D = (): HTMLElement => screen.getByRole('radio', { name: '2B harita görünümüne geç' });
const get3D = (): HTMLElement => screen.getByRole('radio', { name: '3B sahne görünümüne geç' });

afterEach(() => {
  vi.useRealTimers();
});

describe('MapModeExperienceControl', () => {
  it('renders a labelled two-option radiogroup with 2B selected initially', () => {
    render(<MapModeExperienceControl />);

    expect(screen.getByRole('region', { name: 'Harita görünüm modu' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: '2B veya 3B görünüm seç' })).toBeInTheDocument();
    expect(get2D()).toHaveAttribute('aria-checked', 'true');
    expect(get3D()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('2B harita')).toBeInTheDocument();
  });

  it('renders one compact embedded button whose only visible label is the destination mode', () => {
    render(<MapModeExperienceControl embedded />);

    const group = screen.getByRole('group', { name: 'Harita görünüm modu' });
    const toggle = screen.getByRole('button', { name: '2B görünümüne geç' });
    expect(group).toHaveClass('map-mode-experience--embedded');
    expect(screen.queryByRole('region', { name: 'Harita görünüm modu' })).not.toBeInTheDocument();
    expect(toggle).toHaveTextContent(/^2B$/u);
    expect(toggle.querySelector('small')).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('toggles the embedded destination label after runtime confirmation and blocks duplicate requests', () => {
    const modes: string[] = [];
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<ExperienceCommandDetail>).detail;
      if (detail.mode) modes.push(detail.mode);
    };
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, listener as EventListener);

    render(<MapModeExperienceControl embedded />);
    const twoD = screen.getByRole('button', { name: '2B görünümüne geç' });
    fireEvent.click(twoD);

    expect(modes).toEqual(['2d']);
    expect(twoD).toHaveTextContent(/^2B$/u);
    expect(twoD).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(twoD);
    expect(modes).toEqual(['2d']);

    dispatchModeChanged('2d');
    const threeD = screen.getByRole('button', { name: '3B görünümüne geç' });
    expect(threeD).toHaveTextContent(/^3B$/u);
    expect(threeD).toHaveAttribute('data-target-mode', '3d');

    fireEvent.click(threeD);
    expect(modes).toEqual(['2d', '3d']);
    dispatchModeChanged('3d');
    expect(screen.getByRole('button', { name: '2B görünümüne geç' })).toHaveTextContent(/^2B$/u);

    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, listener as EventListener);
  });

  it('keeps navigation keys from leaking out of the single embedded toggle', () => {
    const parentKeyDown = vi.fn();
    render(
      <div onKeyDown={parentKeyDown}>
        <MapModeExperienceControl embedded />
      </div>,
    );

    const toggle = screen.getByRole('button', { name: '2B görünümüne geç' });
    toggle.focus();
    fireEvent.keyDown(toggle, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(toggle);
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it('dispatches the canonical map-mode command when 3B is requested', () => {
    const commands: ExperienceCommandDetail[] = [];
    const onCommand = (event: Event): void => {
      commands.push((event as CustomEvent<ExperienceCommandDetail>).detail);
    };
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, onCommand as EventListener);

    render(<MapModeExperienceControl />);
    fireEvent.click(get3D());

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      name: 'map-mode',
      mode: '3d',
      source: 'map-mode-experience-control',
    });
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-busy', 'true');
    expect(get2D()).toHaveAttribute('aria-disabled', 'true');
    expect(get3D()).toHaveAttribute('aria-disabled', 'true');
    expect(get2D()).not.toBeDisabled();
    expect(get3D()).not.toBeDisabled();
    expect(document.querySelector('.map-mode-experience__status-sr')).toHaveTextContent(/3B görünüm hazırlanıyor/);
    expect(document.querySelector('.map-mode-experience__status')).not.toBeInTheDocument();

    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, onCommand as EventListener);
  });

  it('preserves keyboard focus and blocks duplicate mode requests while a transition is pending', () => {
    const onCommand = vi.fn();
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, onCommand);

    render(<MapModeExperienceControl />);
    get2D().focus();
    fireEvent.keyDown(get2D(), { key: 'ArrowRight' });

    expect(document.activeElement).toBe(get3D());
    expect(get3D()).toHaveAttribute('aria-disabled', 'true');
    expect(get3D()).not.toBeDisabled();
    expect(onCommand).toHaveBeenCalledTimes(1);

    fireEvent.click(get2D());
    fireEvent.click(get3D());
    fireEvent.keyDown(get3D(), { key: 'ArrowLeft' });

    expect(document.activeElement).toBe(get3D());
    expect(onCommand).toHaveBeenCalledTimes(1);

    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, onCommand);
  });

  it('does not dispatch when the already-active 2B option is clicked', () => {
    const onCommand = vi.fn();
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, onCommand);

    render(<MapModeExperienceControl />);
    fireEvent.click(get2D());

    expect(onCommand).not.toHaveBeenCalled();
    expect(get2D()).toHaveAttribute('aria-checked', 'true');

    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, onCommand);
  });

  it('confirms 3B only after the runtime emits the canonical mode-changed event', () => {
    render(<MapModeExperienceControl />);
    fireEvent.click(get3D());

    expect(get3D()).toHaveAttribute('aria-checked', 'false');
    dispatchModeChanged('3d');

    expect(get3D()).toHaveAttribute('aria-checked', 'true');
    expect(get2D()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('3B sahne')).toBeInTheDocument();
    expect(document.querySelector('.map-mode-experience__status-sr')).toHaveTextContent(/3B kamera ve sahne araçları etkin/);
    expect(document.querySelector('.map-mode-experience__status')).not.toBeInTheDocument();
  });

  it('returns from 3B to 2B through the same command contract', () => {
    const modes: string[] = [];
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<ExperienceCommandDetail>).detail;
      if (detail.mode) modes.push(detail.mode);
    };
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, listener as EventListener);

    render(<MapModeExperienceControl />);
    dispatchModeChanged('3d');
    fireEvent.click(get2D());
    dispatchModeChanged('2d');

    expect(modes).toEqual(['2d']);
    expect(get2D()).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('2B harita')).toBeInTheDocument();

    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, listener as EventListener);
  });

  it('shows a retryable alert when a transition times out', () => {
    vi.useFakeTimers();
    render(<MapModeExperienceControl requestTimeoutMs={2_000} />);

    fireEvent.click(get3D());
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Geçiş zaman aşımına uğradı');
    expect(screen.getByRole('button', { name: '3B görünümü yeniden dene' })).toBeEnabled();
  });

  it('dispatches a second bounded request from the retry action', () => {
    vi.useFakeTimers();
    const modes: string[] = [];
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<ExperienceCommandDetail>).detail;
      if (detail.mode) modes.push(detail.mode);
    };
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, listener as EventListener);

    render(<MapModeExperienceControl requestTimeoutMs={2_000} />);
    fireEvent.click(get3D());
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    fireEvent.click(screen.getByRole('button', { name: '3B görünümü yeniden dene' }));

    expect(modes).toEqual(['3d', '3d']);
    expect(screen.getByText(/Deneme 2/)).toBeInTheDocument();

    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, listener as EventListener);
  });

  it('hides retry after the supplied model exhausts its attempt budget', () => {
    vi.useFakeTimers();
    const model = new MapModeExperienceModel({ maxAttempts: 1 });
    render(<MapModeExperienceControl model={model} requestTimeoutMs={2_000} />);

    fireEvent.click(get3D());
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(screen.queryByRole('button', { name: /yeniden dene/i })).not.toBeInTheDocument();
    expect(screen.getByText('Görünüm geçişi için yeniden deneme sınırına ulaşıldı.', { selector: '.map-mode-experience__limit' })).toBeInTheDocument();
  });

  it('marks a runtime recovery event as an assertive error state', () => {
    render(<MapModeExperienceControl />);
    fireEvent.click(get3D());

    dispatchModeChanged('2d', 'map-runtime-recovery');

    expect(screen.getByRole('alert')).toHaveTextContent('Güvenli görünüm korundu');
    expect(screen.getByRole('button', { name: '3B görünümü yeniden dene' })).toBeInTheDocument();
    expect(get2D()).toHaveAttribute('aria-checked', 'true');
  });

  it('accepts a late success event after the timeout alert was shown', () => {
    vi.useFakeTimers();
    render(<MapModeExperienceControl requestTimeoutMs={2_000} />);
    fireEvent.click(get3D());
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    dispatchModeChanged('3d', 'late-confirmation');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(get3D()).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('button', { name: /yeniden dene/i })).not.toBeInTheDocument();
  });

  it('ignores invalid map-mode change payloads', () => {
    render(<MapModeExperienceControl />);

    act(() => {
      window.dispatchEvent(new CustomEvent(EXPERIENCE_MAP_MODE_EVENT, {
        detail: { mode: '4d', source: 'bad-test-event' },
      }));
    });

    expect(get2D()).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('2B harita')).toBeInTheDocument();
  });

  it('mirrors runtime presentation facts as deterministic data attributes', () => {
    render(<MapModeExperienceControl />);
    dispatchRuntime({
      viewport: 'compact',
      reducedMotion: true,
      forcedColors: true,
      coarsePointer: true,
    });

    const region = screen.getByRole('region', { name: 'Harita görünüm modu' });
    expect(region).toHaveAttribute('data-viewport', 'compact');
    expect(region).toHaveAttribute('data-reduced-motion', 'true');
    expect(region).toHaveAttribute('data-forced-colors', 'true');
    expect(region).toHaveAttribute('data-coarse-pointer', 'true');
  });

  it('uses the minimum timeout bound for unsafe small values', () => {
    vi.useFakeTimers();
    render(<MapModeExperienceControl requestTimeoutMs={10} />);
    fireEvent.click(get3D());

    act(() => {
      vi.advanceTimersByTime(1_999);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('clears the pending timeout after a successful transition', () => {
    vi.useFakeTimers();
    render(<MapModeExperienceControl requestTimeoutMs={2_000} />);
    fireEvent.click(get3D());
    dispatchModeChanged('3d');

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(get3D()).toHaveAttribute('aria-checked', 'true');
  });

  it('does not dispose an externally supplied model on unmount', () => {
    const model = new MapModeExperienceModel();
    const view = render(<MapModeExperienceControl model={model} />);

    view.unmount();

    expect(model.disposed()).toBe(false);
    expect(model.requestMode('3d')).toBe(1);
    model.dispose();
  });


  it('exposes a single roving tab stop across the mode radiogroup', () => {
    render(<MapModeExperienceControl />);

    expect(get2D()).toHaveAttribute('tabindex', '0');
    expect(get3D()).toHaveAttribute('tabindex', '-1');
  });

  it('moves focus and selection intent to 3B with ArrowRight', () => {
    const modes: string[] = [];
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<ExperienceCommandDetail>).detail;
      if (detail.mode) modes.push(detail.mode);
    };
    window.addEventListener(EXPERIENCE_COMMAND_EVENT, listener as EventListener);

    render(<MapModeExperienceControl />);
    get2D().focus();
    fireEvent.keyDown(get2D(), { key: 'ArrowRight' });

    expect(document.activeElement).toBe(get3D());
    expect(modes).toEqual(['3d']);
    expect(get2D()).toHaveAttribute('aria-checked', 'true');

    window.removeEventListener(EXPERIENCE_COMMAND_EVENT, listener as EventListener);
  });

  it('syncs the roving tab stop to the runtime-confirmed active mode', () => {
    render(<MapModeExperienceControl />);
    fireEvent.click(get3D());
    dispatchModeChanged('3d');

    expect(get3D()).toHaveAttribute('tabindex', '0');
    expect(get2D()).toHaveAttribute('tabindex', '-1');
  });

  it('uses Home and End for deterministic mode focus movement', () => {
    render(<MapModeExperienceControl />);
    get2D().focus();
    fireEvent.keyDown(get2D(), { key: 'End' });
    expect(document.activeElement).toBe(get3D());

    dispatchModeChanged('3d');
    fireEvent.keyDown(get3D(), { key: 'Home' });
    expect(document.activeElement).toBe(get2D());
  });

  it('keeps retry controls at button semantics instead of links or custom click targets', () => {
    vi.useFakeTimers();
    render(<MapModeExperienceControl requestTimeoutMs={2_000} />);
    fireEvent.click(get3D());
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    const retry = screen.getByRole('button', { name: '3B görünümü yeniden dene' });
    expect(retry.tagName).toBe('BUTTON');
    expect(retry).toHaveAttribute('type', 'button');
  });

  it('keeps the active mode stable while a different mode is pending', () => {
    render(<MapModeExperienceControl />);
    fireEvent.click(get3D());

    expect(screen.getByText('2B harita')).toBeInTheDocument();
    expect(get2D()).toHaveAttribute('aria-checked', 'true');
    expect(get3D()).toHaveAttribute('aria-checked', 'false');
  });
});
