import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createConnectivityExperienceModel } from '../../experience/connectivityExperienceModel';
import { ExperienceConnectivityNotice } from './ExperienceConnectivityNotice';

vi.mock('../../platform/runtime/runtimeDiagnostics', () => ({
  runtimeDiagnostics: {
    captureError: vi.fn(),
    record: vi.fn(),
  },
}));

describe('ExperienceConnectivityNotice', () => {
  let online = true;

  beforeEach(() => {
    online = true;
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('stays out of the DOM while connectivity is healthy', () => {
    const model = createConnectivityExperienceModel();
    render(<ExperienceConnectivityNotice model={model} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('shows an assertive offline notice on browser offline events', () => {
    const model = createConnectivityExperienceModel();
    render(<ExperienceConnectivityNotice model={model} />);

    online = false;
    act(() => window.dispatchEvent(new Event('offline')));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-connectivity-phase', 'offline');
    expect(screen.getByText('Bağlantı kesildi')).toBeInTheDocument();
    expect(screen.getByText(/Harita ve kent servisleri/)).toBeInTheDocument();
  });

  test('switches to polite restored feedback when the network returns', () => {
    let now = 0;
    const model = createConnectivityExperienceModel({ now: () => now });
    render(<ExperienceConnectivityNotice model={model} />);

    online = false;
    act(() => window.dispatchEvent(new Event('offline')));
    now = 5_000;
    online = true;
    act(() => window.dispatchEvent(new Event('online')));

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('data-connectivity-phase', 'restored');
    expect(screen.getByText('Bağlantı yeniden kuruldu')).toBeInTheDocument();
    expect(screen.getByText('Kesinti süresi: 5 sn')).toBeInTheDocument();
  });

  test('allows restored feedback to be dismissed without hiding offline alerts', () => {
    const model = createConnectivityExperienceModel();
    model.setOnline(false);
    model.setOnline(true);
    render(<ExperienceConnectivityNotice model={model} />);

    fireEvent.click(screen.getByRole('button', { name: 'Bağlantı geri geldi bildirimini kapat' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    act(() => model.setOnline(false));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('updates elapsed offline time through bounded one-shot refresh timers', () => {
    vi.useFakeTimers();
    let now = 0;
    online = false;
    const model = createConnectivityExperienceModel({
      initialOnline: false,
      now: () => now,
    });
    render(<ExperienceConnectivityNotice model={model} />);

    expect(screen.getByText('Kesinti: 0 sn')).toBeInTheDocument();
    now = 1_050;
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText('Kesinti: 1 sn')).toBeInTheDocument();

    now = 2_100;
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText('Kesinti: 2 sn')).toBeInTheDocument();
  });

  test('auto-hides restored feedback after its grace period', () => {
    vi.useFakeTimers();
    let now = 0;
    const model = createConnectivityExperienceModel({
      now: () => now,
      restoredVisibleMs: 1_500,
    });
    render(<ExperienceConnectivityNotice model={model} />);

    online = false;
    act(() => window.dispatchEvent(new Event('offline')));
    now = 100;
    online = true;
    act(() => window.dispatchEvent(new Event('online')));
    expect(screen.getByRole('status')).toBeInTheDocument();

    now = 1_100;
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole('status')).toBeInTheDocument();

    now = 1_700;
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('cleans its pending one-shot refresh timer on unmount', () => {
    vi.useFakeTimers();
    online = false;
    const model = createConnectivityExperienceModel({ initialOnline: false });
    const refresh = vi.spyOn(model, 'refresh');
    const { unmount } = render(<ExperienceConnectivityNotice model={model} />);

    act(() => vi.advanceTimersByTime(1_000));
    expect(refresh).toHaveBeenCalledTimes(1);

    unmount();
    act(() => vi.advanceTimersByTime(2_000));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('reflects externally supplied connectivity model transitions', () => {
    const model = createConnectivityExperienceModel();
    render(<ExperienceConnectivityNotice model={model} />);

    act(() => model.setOnline(false));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    act(() => model.setOnline(true));
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
