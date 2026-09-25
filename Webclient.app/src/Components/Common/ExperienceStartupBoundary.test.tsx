import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createStartupExperienceModel } from '../../experience/startupExperienceModel';
import { ExperienceStartupBoundary } from './ExperienceStartupBoundary';

vi.mock('../../Core/AppConfig', () => ({
  AppConfig: {
    App: {
      Title1: 'Ankara',
      Title2: 'Kent Rehberi',
    },
  },
}));

describe('ExperienceStartupBoundary', () => {
  let online = true;

  beforeEach(() => {
    online = true;
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('renders an accessible startup status while bootstrap is active', () => {
    const model = createStartupExperienceModel();
    model.beginAttempt();

    render(
      <ExperienceStartupBoundary model={model} onRetry={vi.fn()}>
        <div>Uygulama hazır</div>
      </ExperienceStartupBoundary>,
    );

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('heading', { name: 'Kent Rehberi hazırlanıyor' })).toBeInTheDocument();
    expect(screen.getByText('1 / 4')).toBeInTheDocument();
    expect(screen.queryByText('Uygulama hazır')).not.toBeInTheDocument();
  });

  test('renders children only after the model becomes ready', () => {
    const model = createStartupExperienceModel();
    model.beginAttempt();
    const { rerender } = render(
      <ExperienceStartupBoundary model={model} onRetry={vi.fn()}>
        <main>Harita çalışma alanı</main>
      </ExperienceStartupBoundary>,
    );

    expect(screen.queryByText('Harita çalışma alanı')).not.toBeInTheDocument();

    act(() => model.succeed());
    rerender(
      <ExperienceStartupBoundary model={model} onRetry={vi.fn()}>
        <main>Harita çalışma alanı</main>
      </ExperienceStartupBoundary>,
    );

    expect(screen.getByText('Harita çalışma alanı')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('shows sanitized diagnostics and focuses retry after a failure', () => {
    const model = createStartupExperienceModel();
    const retry = vi.fn();
    model.beginAttempt();

    render(
      <ExperienceStartupBoundary model={model} onRetry={retry}>
        <div>ready</div>
      </ExperienceStartupBoundary>,
    );

    act(() => model.fail({
      message: 'Harita yapılandırması yüklenemedi.',
      code: 'BOOTSTRAP_TIMEOUT',
    }));

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('BOOTSTRAP_TIMEOUT')).toBeInTheDocument();
    const retryButton = screen.getByRole('button', { name: 'Tekrar dene' });
    expect(document.activeElement).toBe(retryButton);

    fireEvent.click(retryButton);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('offers page reload for a non-retryable failure', () => {
    const model = createStartupExperienceModel();
    const reload = vi.fn();
    model.beginAttempt();
    model.fail({ message: 'Yapılandırma geçersiz.', retryable: false });

    render(
      <ExperienceStartupBoundary model={model} onRetry={vi.fn()} onReload={reload}>
        <div>ready</div>
      </ExperienceStartupBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sayfayı yenile' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Tekrar dene' })).not.toBeInTheDocument();
  });

  test('offers reload when the retry budget is exhausted', () => {
    const model = createStartupExperienceModel({ maxAttempts: 1 });
    model.beginAttempt();
    model.fail({ message: 'Başlatma başarısız.' });

    render(
      <ExperienceStartupBoundary model={model} onRetry={vi.fn()} onReload={vi.fn()}>
        <div>ready</div>
      </ExperienceStartupBoundary>,
    );

    expect(screen.getByRole('heading', { name: 'Başlatma sınırına ulaşıldı' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sayfayı yenile' })).toBeInTheDocument();
  });

  test('disables retry while offline and restores it on the online event', () => {
    const model = createStartupExperienceModel({ maxAttempts: 3 });
    model.beginAttempt();
    model.fail({ message: 'Geçici hata.' });
    const retry = vi.fn();

    render(
      <ExperienceStartupBoundary model={model} onRetry={retry}>
        <div>ready</div>
      </ExperienceStartupBoundary>,
    );

    online = false;
    act(() => window.dispatchEvent(new Event('offline')));
    expect(screen.getByRole('button', { name: 'Bağlantı bekleniyor' })).toBeDisabled();

    online = true;
    act(() => window.dispatchEvent(new Event('online')));
    const retryButton = screen.getByRole('button', { name: 'Tekrar dene' });
    expect(retryButton).toBeEnabled();

    fireEvent.click(retryButton);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('surfaces long-running startup guidance with elapsed time', () => {
    let now = 1_000;
    const model = createStartupExperienceModel({
      now: () => now,
      delayedAfterMs: 1_500,
    });
    model.beginAttempt();

    render(
      <ExperienceStartupBoundary model={model} onRetry={vi.fn()}>
        <div>ready</div>
      </ExperienceStartupBoundary>,
    );

    now = 3_100;
    act(() => model.refresh());

    expect(screen.getByRole('heading', { name: 'Başlatma beklenenden uzun sürüyor' })).toBeInTheDocument();
    expect(screen.getByText('2 sn')).toBeInTheDocument();
    expect(screen.getByText('İşlem hâlâ devam ediyor.')).toBeInTheDocument();
  });

  test('reflects offline startup without consuming retry capacity', () => {
    online = false;
    const model = createStartupExperienceModel({ initialOnline: false });
    model.beginAttempt();

    render(
      <ExperienceStartupBoundary model={model} onRetry={vi.fn()}>
        <div>ready</div>
      </ExperienceStartupBoundary>,
    );

    expect(screen.getByRole('heading', { name: 'Bağlantı bekleniyor' })).toBeInTheDocument();
    expect(screen.getByText('0 / 4')).toBeInTheDocument();
    expect(screen.getByText('Ağ bağlantısı bulunamadı.')).toBeInTheDocument();
  });

  test('chains one-shot refresh timers and clears the pending timer on unmount', () => {
    vi.useFakeTimers();
    const model = createStartupExperienceModel();
    const refresh = vi.spyOn(model, 'refresh');
    model.beginAttempt();

    const { unmount } = render(
      <ExperienceStartupBoundary model={model} onRetry={vi.fn()}>
        <div>ready</div>
      </ExperienceStartupBoundary>,
    );

    act(() => vi.advanceTimersByTime(1_000));
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1_000));
    expect(refresh).toHaveBeenCalledTimes(2);

    unmount();
    act(() => vi.advanceTimersByTime(2_000));
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
