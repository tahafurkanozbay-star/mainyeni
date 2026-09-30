import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MapWorkspaceAccessibilityModel } from './mapWorkspaceAccessibility';
import { MapWorkspaceHealthSurface } from './MapWorkspaceHealthSurface';

const renderSurface = (
  model: MapWorkspaceAccessibilityModel,
  overrides: Partial<React.ComponentProps<typeof MapWorkspaceHealthSurface>> = {},
) => {
  const onRetry = vi.fn();
  const onOpenHelp = vi.fn();
  const onReloadPage = vi.fn();
  const result = render(
    <MapWorkspaceHealthSurface
      model={model}
      onRetry={onRetry}
      onOpenHelp={onOpenHelp}
      onReloadPage={onReloadPage}
      {...overrides}
    />,
  );
  return { ...result, onRetry, onOpenHelp, onReloadPage };
};

const begin = (model: MapWorkspaceAccessibilityModel): void => {
  act(() => { model.beginAttempt(); });
};

const ready = (model: MapWorkspaceAccessibilityModel): void => {
  act(() => { model.markReady(); });
};

describe('MapWorkspaceHealthSurface', () => {
  it('renders a canonical live status and visible boot card', () => {
    const model = new MapWorkspaceAccessibilityModel();
    begin(model);
    renderSurface(model);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Harita çalışma alanı hazırlanıyor.');
    expect(screen.getByRole('heading', { name: 'Harita çalışma alanı hazırlanıyor' })).toBeInTheDocument();
    expect(screen.getByText('Başlatılıyor')).toBeInTheDocument();
    expect(screen.getByText('Deneme 1 / 3')).toBeInTheDocument();
    expect(screen.getByLabelText('Başlatma denemesi 1 / 3')).toBeInTheDocument();
  });

  it('removes the visual surface after ready while preserving the live status node', () => {
    const model = new MapWorkspaceAccessibilityModel();
    begin(model);
    const { container } = renderSurface(model);
    ready(model);
    expect(screen.queryByRole('heading', { name: 'Harita çalışma alanı hazırlanıyor' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Harita çalışma alanı kullanıma hazır.');
    expect(container.querySelector('.map-workspace-health')).toBeNull();
  });

  it('keeps short view updates visually quiet', () => {
    const model = new MapWorkspaceAccessibilityModel();
    begin(model);
    ready(model);
    renderSurface(model);
    act(() => { model.markUpdating(true); });
    expect(screen.getByRole('status')).toHaveTextContent('Harita görünümü güncelleniyor.');
    expect(screen.queryByText('Harita güncelleniyor')).not.toBeInTheDocument();
  });

  it('shows a delayed update card without changing the recovery budget', () => {
    let delayed: (() => void) | undefined;
    const model = new MapWorkspaceAccessibilityModel({
      scheduleTimeout(callback) {
        delayed = callback;
        return 1 as ReturnType<typeof setTimeout>;
      },
      clearScheduledTimeout() {},
    });
    begin(model);
    ready(model);
    renderSurface(model);
    act(() => { model.markUpdating(true); });
    act(() => { delayed?.(); });
    expect(screen.getByRole('heading', { name: 'Harita güncellemesi sürüyor' })).toBeInTheDocument();
    expect(screen.getByText('Uzun sürüyor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Çalışma rehberini aç' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Haritayı yeniden başlat' })).not.toBeInTheDocument();
  });

  it('invokes the help action from delayed state', () => {
    let delayed: (() => void) | undefined;
    const model = new MapWorkspaceAccessibilityModel({
      scheduleTimeout(callback) {
        delayed = callback;
        return 1 as ReturnType<typeof setTimeout>;
      },
      clearScheduledTimeout() {},
    });
    begin(model);
    renderSurface(model);
    act(() => { delayed?.(); });
    fireEvent.click(screen.getByRole('button', { name: 'Çalışma rehberini aç' }));
    const surface = screen.getByRole('button', { name: 'Çalışma rehberini aç' });
    expect(surface).toBeInTheDocument();
  });

  it('renders optional data failure as a non-blocking degraded surface', () => {
    const model = new MapWorkspaceAccessibilityModel();
    begin(model);
    ready(model);
    renderSurface(model);
    act(() => { model.markResourceFailed('kent-rehberi-data', 'Veri katmanı geçici olarak yok'); });
    expect(screen.getByRole('heading', { name: 'Harita sınırlı özelliklerle çalışıyor' })).toBeInTheDocument();
    expect(screen.getByText('Sınırlı')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Harita kullanılabilir');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('exposes resource diagnostics inside a native details disclosure', () => {
    const model = new MapWorkspaceAccessibilityModel();
    begin(model);
    ready(model);
    act(() => { model.markResourceFailed('kent-rehberi-data', 'Veri katmanı sınırlı'); });
    const { container } = renderSurface(model);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    const summary = within(details as HTMLElement).getByText('Çalışma alanı durumu');
    expect(summary).toBeInTheDocument();
    fireEvent.click(summary.closest('summary') as HTMLElement);
    expect(within(details as HTMLElement).getByText('Kaynaklar')).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText('Harita görünümü')).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText('Kent Rehberi veri katmanı')).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText('Veri katmanı sınırlı')).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText('1 sınırlama')).toBeInTheDocument();
  });

  it('shows bounded recent operational events in diagnostics', () => {
    const model = new MapWorkspaceAccessibilityModel({ maxEvents: 4 });
    begin(model);
    ready(model);
    act(() => {
      model.markResourceLoading('kent-rehberi-data');
      model.markResourceFailed('kent-rehberi-data', 'temporary');
    });
    renderSurface(model);
    expect(screen.getByText('Son durum değişiklikleri')).toBeInTheDocument();
    const events = screen.getByText('Son durum değişiklikleri').closest('section');
    expect(events).not.toBeNull();
    expect(within(events as HTMLElement).getAllByRole('listitem').length).toBeLessThanOrEqual(6);
    expect(within(events as HTMLElement).getByText(/sınırlı/i)).toBeInTheDocument();
  });

  it('renders first fatal failure as assertive alert with bounded retry', () => {
    const model = new MapWorkspaceAccessibilityModel();
    begin(model);
    const { onRetry } = renderSurface(model);
    act(() => { model.markError(new Error('MapView kurulamadı')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Harita çalışma alanı hazırlanamadı. MapView kurulamadı');
    expect(screen.getByRole('heading', { name: 'Harita çalışma alanı başlatılamadı' })).toBeInTheDocument();
    expect(screen.getByText('Deneme 1 / 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden başlat' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not invoke retry when model no longer allows it', () => {
    const model = new MapWorkspaceAccessibilityModel({ maxAttempts: 1 });
    begin(model);
    act(() => { model.markError('failed'); });
    const { onRetry } = renderSurface(model);
    expect(screen.queryByRole('button', { name: 'Haritayı yeniden başlat' })).not.toBeInTheDocument();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('switches to page reload fallback after retry exhaustion', () => {
    const model = new MapWorkspaceAccessibilityModel({ maxAttempts: 2 });
    begin(model);
    act(() => { model.markError('first'); });
    begin(model);
    act(() => { model.markError('second'); });
    const { onReloadPage } = renderSurface(model);
    expect(screen.getByText('Deneme 2 / 2')).toBeInTheDocument();
    expect(screen.getByText(/Güvenli yeniden başlatma denemeleri tamamlandı/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sayfayı yenile' }));
    expect(onReloadPage).toHaveBeenCalledTimes(1);
  });

  it('omits page reload fallback callback safely when host does not supply it', () => {
    const model = new MapWorkspaceAccessibilityModel({ maxAttempts: 1 });
    begin(model);
    act(() => { model.markError('failed'); });
    render(
      <MapWorkspaceHealthSurface
        model={model}
        onRetry={vi.fn()}
      />,
    );
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Sayfayı yenile' }))).not.toThrow();
  });

  it('invokes help callback only from the explicit help action', () => {
    const model = new MapWorkspaceAccessibilityModel();
    begin(model);
    act(() => { model.markError('failed'); });
    const { onOpenHelp } = renderSurface(model);
    fireEvent.click(screen.getByRole('button', { name: 'Çalışma rehberini aç' }));
    expect(onOpenHelp).toHaveBeenCalledTimes(1);
  });

  it('does not render raw object failures in visible diagnostics', () => {
    const model = new MapWorkspaceAccessibilityModel();
    begin(model);
    act(() => { model.markError({ accessToken: 'super-secret' }); });
    renderSurface(model);
    expect(screen.getByRole('alert')).toHaveTextContent('Harita çalışma alanı hazırlanamadı.');
    expect(document.body.textContent).not.toContain('super-secret');
  });

  it('updates from error to boot state after host begins a retry attempt', () => {
    const model = new MapWorkspaceAccessibilityModel();
    begin(model);
    act(() => { model.markError('first failure'); });
    renderSurface(model);
    expect(screen.getByRole('heading', { name: 'Harita çalışma alanı başlatılamadı' })).toBeInTheDocument();
    begin(model);
    expect(screen.getByRole('heading', { name: 'Harita çalışma alanı hazırlanıyor' })).toBeInTheDocument();
    expect(screen.getByText('Deneme 2 / 3')).toBeInTheDocument();
  });

  it('returns to a visually quiet state after successful retry', () => {
    const model = new MapWorkspaceAccessibilityModel();
    begin(model);
    act(() => { model.markError('first failure'); });
    renderSurface(model);
    begin(model);
    ready(model);
    expect(screen.queryByRole('heading', { name: 'Harita çalışma alanı hazırlanıyor' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Harita çalışma alanı kullanıma hazır.');
  });

  it('marks visible card busy only while the workspace is actually busy', () => {
    const model = new MapWorkspaceAccessibilityModel();
    begin(model);
    const { container } = renderSurface(model);
    expect(container.querySelector('.map-workspace-health')).toHaveAttribute('aria-busy', 'true');
    act(() => { model.markError('failed'); });
    expect(container.querySelector('.map-workspace-health')).toHaveAttribute('aria-busy', 'false');
  });

  it('exposes deterministic tone and phase data attributes for CSS/forced-colors rules', () => {
    const model = new MapWorkspaceAccessibilityModel();
    begin(model);
    const { container } = renderSurface(model);
    let card = container.querySelector('.map-workspace-health');
    expect(card).toHaveAttribute('data-tone', 'neutral');
    expect(card).toHaveAttribute('data-phase', 'booting');
    act(() => { model.markError('failed'); });
    card = container.querySelector('.map-workspace-health');
    expect(card).toHaveAttribute('data-tone', 'danger');
    expect(card).toHaveAttribute('data-phase', 'error');
  });
});
