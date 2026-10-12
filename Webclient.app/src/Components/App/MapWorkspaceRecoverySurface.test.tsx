import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapWorkspaceRecoverySurface } from './MapWorkspaceRecoverySurface';
import { MapWorkspaceRecoveryModel } from './mapWorkspaceRecoveryModel';

afterEach(() => {
  vi.useRealTimers();
});

describe('MapWorkspaceRecoverySurface', () => {
  it('renders nothing while recovery is idle', () => {
    const model = new MapWorkspaceRecoveryModel();
    render(<MapWorkspaceRecoverySurface model={model} onRetry={vi.fn()} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps initial fast boot visually quiet', () => {
    vi.useFakeTimers();
    const model = new MapWorkspaceRecoveryModel();
    const attemptId = model.beginAttempt();
    render(<MapWorkspaceRecoverySurface model={model} onRetry={vi.fn()} delayedAfterMs={2_000} />);

    act(() => {
      vi.advanceTimersByTime(1_999);
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(model.getSnapshot().phase).toBe('booting');

    model.succeed(attemptId!);
  });

  it('shows a polite delayed-loading surface after the bounded delay', () => {
    vi.useFakeTimers();
    const model = new MapWorkspaceRecoveryModel();
    model.beginAttempt();
    render(<MapWorkspaceRecoverySurface model={model} onRetry={vi.fn()} delayedAfterMs={2_000} />);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(screen.getByRole('status', { name: 'Harita hazırlanıyor' })).toHaveTextContent(
      'Hazırlık beklenenden uzun sürüyor',
    );
    expect(screen.getByText('Deneme 1/3')).toBeInTheDocument();
  });

  it('clears the delayed surface when bootstrap succeeds', () => {
    vi.useFakeTimers();
    const model = new MapWorkspaceRecoveryModel();
    const attemptId = model.beginAttempt();
    render(<MapWorkspaceRecoverySurface model={model} onRetry={vi.fn()} delayedAfterMs={2_000} />);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByRole('status')).toBeInTheDocument();

    act(() => model.succeed(attemptId!));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders a safe assertive error surface after bootstrap failure', () => {
    const model = new MapWorkspaceRecoveryModel();
    const attemptId = model.beginAttempt();
    model.fail(attemptId!, new Error('private /srv/app/path'));

    render(<MapWorkspaceRecoverySurface model={model} onRetry={vi.fn()} />);

    const alert = screen.getByRole('alert', { name: 'Harita başlatma sorunu' });
    expect(alert).toHaveTextContent('Harita henüz kullanıma hazır değil');
    expect(alert).toHaveTextContent('Harita çalışma alanı güvenli biçimde başlatılamadı.');
    expect(alert).not.toHaveTextContent('/srv/app/path');
  });

  it('invokes retry only when the model still admits another attempt', () => {
    const model = new MapWorkspaceRecoveryModel({ maxAttempts: 2 });
    const attemptId = model.beginAttempt();
    model.fail(attemptId!, new Error('failed'));
    const onRetry = vi.fn();

    render(<MapWorkspaceRecoverySurface model={model} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden başlat' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows a terminal explanation instead of a retry button after budget exhaustion', () => {
    const model = new MapWorkspaceRecoveryModel({ maxAttempts: 1 });
    const attemptId = model.beginAttempt();
    model.fail(attemptId!, new Error('failed'));

    render(<MapWorkspaceRecoverySurface model={model} onRetry={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Haritayı yeniden başlat' })).not.toBeInTheDocument();
    expect(screen.getByText(/Yeniden deneme sınırına ulaşıldı/)).toBeInTheDocument();
  });

  it('uses the minimum supported delayed threshold for unsafe small values', () => {
    vi.useFakeTimers();
    const model = new MapWorkspaceRecoveryModel();
    model.beginAttempt();
    render(<MapWorkspaceRecoverySurface model={model} onRetry={vi.fn()} delayedAfterMs={10} />);

    act(() => {
      vi.advanceTimersByTime(1_999);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('cancels its delayed timer when the attempt succeeds early', () => {
    vi.useFakeTimers();
    const model = new MapWorkspaceRecoveryModel();
    const attemptId = model.beginAttempt();
    render(<MapWorkspaceRecoverySurface model={model} onRetry={vi.fn()} delayedAfterMs={2_000} />);

    act(() => model.succeed(attemptId!));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(model.getSnapshot().phase).toBe('ready');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('cancels its delayed timer when the surface unmounts', () => {
    vi.useFakeTimers();
    const model = new MapWorkspaceRecoveryModel();
    model.beginAttempt();
    const view = render(<MapWorkspaceRecoverySurface model={model} onRetry={vi.fn()} delayedAfterMs={2_000} />);

    view.unmount();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(model.getSnapshot().phase).toBe('booting');
  });

  it('includes elapsed time metadata after a failed attempt lasting at least one second', () => {
    let now = 0;
    const model = new MapWorkspaceRecoveryModel({ now: () => now });
    const attemptId = model.beginAttempt();
    now = 2_400;
    model.fail(attemptId!, new Error('failed'));

    render(<MapWorkspaceRecoverySurface model={model} onRetry={vi.fn()} />);

    expect(screen.getByText('Son süre 2 sn')).toBeInTheDocument();
  });

  it('keeps the retry action as a native button with explicit type', () => {
    const model = new MapWorkspaceRecoveryModel();
    const attemptId = model.beginAttempt();
    model.fail(attemptId!, new Error('failed'));

    render(<MapWorkspaceRecoverySurface model={model} onRetry={vi.fn()} />);
    const retry = screen.getByRole('button', { name: 'Haritayı yeniden başlat' });

    expect(retry.tagName).toBe('BUTTON');
    expect(retry).toHaveAttribute('type', 'button');
  });
});
