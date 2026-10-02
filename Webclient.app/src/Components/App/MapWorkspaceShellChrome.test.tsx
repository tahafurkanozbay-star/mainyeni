import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MapWorkspaceShellChrome } from './MapWorkspaceShellChrome';
import { createMapWorkspaceShellModel } from './mapWorkspaceShellModel';

const captureError = vi.fn();
const record = vi.fn();

vi.mock('../../platform/runtime/runtimeDiagnostics', () => ({
  runtimeDiagnostics: {
    captureError: (...args: unknown[]) => captureError(...args),
    record: (...args: unknown[]) => record(...args),
  },
}));

const visibleRect = (): DOMRect => ({
  x: 0,
  y: 0,
  width: 200,
  height: 60,
  top: 0,
  right: 200,
  bottom: 60,
  left: 0,
  toJSON: () => ({}),
} as DOMRect);

const makeVisible = (element: HTMLElement): void => {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(visibleRect());
};

const addWorkspaceRegions = (): void => {
  const host = document.createElement('div');
  host.dataset.testRegions = 'true';
  host.innerHTML = `
    <div class="mainbar-container"><button>Ana menü</button></div>
    <div id="esri-map-container"></div>
    <aside id="sidebar"><button>Katmanlar</button></aside>
    <div id="toolbar-widget"><button>Araçlar</button></div>
    <aside id="experience-workspace-controls" tabindex="-1"></aside>
    <button class="map-shortcut-help__launcher">Kısayollar</button>
  `;
  document.body.append(host);
  host.querySelectorAll<HTMLElement>('*').forEach((element) => makeVisible(element));
};

const cleanupWorkspaceRegions = (): void => {
  document.querySelectorAll('[data-test-regions="true"]').forEach((element) => element.remove());
};

describe('MapWorkspaceShellChrome', () => {
  beforeEach(() => {
    captureError.mockReset();
    record.mockReset();
    addWorkspaceRegions();
  });

  afterEach(() => {
    cleanupWorkspaceRegions();
    vi.restoreAllMocks();
  });

  it('renders a polite booting status', () => {
    render(<MapWorkspaceShellChrome phase="booting" />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Hazırlanıyor');
    expect(status).toHaveTextContent('Harita hazırlanıyor');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('renders ready status with a success phase contract', () => {
    const { container } = render(<MapWorkspaceShellChrome phase="ready" />);

    expect(screen.getByRole('status')).toHaveTextContent('Harita hazır');
    expect(container.querySelector('.map-workspace-shell')).toHaveAttribute('data-phase', 'ready');
    expect(container.querySelector('.map-workspace-shell')).toHaveAttribute('data-tone', 'success');
  });

  it('renders updating status as busy', () => {
    const { container } = render(<MapWorkspaceShellChrome phase="updating" />);

    expect(screen.getByRole('status')).toHaveTextContent('Güncelleniyor');
    expect(container.querySelector('.map-workspace-shell__busy')).toBeInTheDocument();
  });

  it('renders errors through an assertive alert', () => {
    render(<MapWorkspaceShellChrome phase="error" errorMessage="Map failed" />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(screen.getByRole('heading', { name: 'Harita hazırlanamadı' })).toBeInTheDocument();
    expect(screen.getByText('Map failed')).toBeInTheDocument();
  });

  it('sanitizes control characters in visible error messages', () => {
    render(<MapWorkspaceShellChrome phase="error" errorMessage={'Map\u0000\u0007 failed\nagain'} />);

    expect(screen.getByText('Map failed again')).toBeInTheDocument();
  });

  it('bounds visible error messages', () => {
    const oversized = `ERR ${'x'.repeat(500)}`;
    render(<MapWorkspaceShellChrome phase="error" errorMessage={oversized} />);

    const paragraph = screen.getByText((content) => content.startsWith('ERR '));
    expect(paragraph.textContent?.length).toBeLessThanOrEqual(180);
  });

  it('uses a safe fallback error message for blank errors', () => {
    render(<MapWorkspaceShellChrome phase="error" errorMessage="   " />);

    expect(screen.getByText(/Harita motoru başlatılırken bir sorun oluştu/i)).toBeInTheDocument();
  });

  it('offers retry in error phase when callback exists', () => {
    const onRetry = vi.fn();
    render(<MapWorkspaceShellChrome phase="error" onRetry={onRetry} />);

    expect(screen.getByRole('button', { name: 'Haritayı yeniden hazırla' })).toBeEnabled();
  });

  it('does not render retry control in ready state', () => {
    render(<MapWorkspaceShellChrome phase="ready" onRetry={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Haritayı yeniden hazırla' })).not.toBeInTheDocument();
  });

  it('requests one governed retry and records aggregate diagnostics', () => {
    const onRetry = vi.fn();
    const model = createMapWorkspaceShellModel();
    render(<MapWorkspaceShellChrome phase="error" onRetry={onRetry} model={model} />);

    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden hazırla' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(model.getSnapshot()).toMatchObject({ phase: 'booting', retryAttempt: 1 });
    expect(record).toHaveBeenCalledWith('experience.map-workspace-shell.retry', {
      attempt: 1,
      maxRetries: 3,
    });
  });

  it('blocks retry after the bounded attempt limit', () => {
    const onRetry = vi.fn();
    const model = createMapWorkspaceShellModel({ maxRetries: 2 });
    render(<MapWorkspaceShellChrome phase="error" onRetry={onRetry} model={model} />);

    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden hazırla' }));
    model.markRetryFailed();
    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden hazırla' }));
    model.markRetryFailed();

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Haritayı yeniden hazırla' })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('güvenlik sınırına ulaşıldı');
  });

  it('resets retry budget after ready phase synchronizes', () => {
    const model = createMapWorkspaceShellModel();
    const onRetry = vi.fn();
    const { rerender } = render(<MapWorkspaceShellChrome phase="error" onRetry={onRetry} model={model} />);
    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden hazırla' }));
    expect(model.getSnapshot().retryAttempt).toBe(1);

    rerender(<MapWorkspaceShellChrome phase="ready" onRetry={onRetry} model={model} />);

    expect(model.getSnapshot().retryAttempt).toBe(0);
    expect(model.getSnapshot().phase).toBe('ready');
  });

  it('discovers and displays all available workspace regions', () => {
    render(<MapWorkspaceShellChrome phase="ready" />);

    fireEvent.click(screen.getByText('Bölgeler'));
    expect(screen.getByRole('button', { name: /Navigasyon Kullanılabilir/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Harita Kullanılabilir/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Panel Kullanılabilir/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Araçlar Kullanılabilir/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Görünüm Kullanılabilir/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Yardım Kullanılabilir/i })).toBeEnabled();
  });

  it('shows the region count in the summary', () => {
    render(<MapWorkspaceShellChrome phase="ready" />);

    expect(screen.getByText('6')).toHaveClass('map-workspace-shell__region-count');
  });

  it('moves focus when a region menu action is selected', () => {
    render(<MapWorkspaceShellChrome phase="ready" />);
    fireEvent.click(screen.getByText('Bölgeler'));

    fireEvent.click(screen.getByRole('button', { name: /Araçlar Kullanılabilir/i }));

    expect(document.activeElement?.textContent).toContain('Araçlar');
  });

  it('closes region details after moving focus', () => {
    const { container } = render(<MapWorkspaceShellChrome phase="ready" />);
    fireEvent.click(screen.getByText('Bölgeler'));
    const details = container.querySelector<HTMLDetailsElement>('.map-workspace-shell__regions')!;
    expect(details.open).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Harita Kullanılabilir/i }));

    expect(details.open).toBe(false);
  });

  it('exposes F6 guidance in the region menu', () => {
    render(<MapWorkspaceShellChrome phase="ready" />);
    fireEvent.click(screen.getByText('Bölgeler'));

    expect(screen.getAllByText('F6').length).toBeGreaterThan(0);
    expect(screen.getByText(/ileri,.*geri dolaşabilirsiniz/i)).toBeInTheDocument();
  });

  it('updates active region data when focus enters a known region', () => {
    const { container } = render(<MapWorkspaceShellChrome phase="ready" />);
    const toolbarButton = document.querySelector<HTMLButtonElement>('#toolbar-widget button')!;

    toolbarButton.focus();

    expect(container.querySelector('.map-workspace-shell')).toHaveAttribute('data-active-region', 'toolbar');
  });

  it('updates modality after keyboard interaction', () => {
    const { container } = render(<MapWorkspaceShellChrome phase="ready" />);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

    expect(container.querySelector('.map-workspace-shell')).toHaveAttribute('data-modality', 'keyboard');
  });

  it('uses a polite hidden announcement for region focus changes', () => {
    render(<MapWorkspaceShellChrome phase="ready" />);
    document.querySelector<HTMLButtonElement>('#sidebar button')!.focus();

    const announcement = document.querySelector('.map-workspace-shell__announcement');
    expect(announcement).toHaveAttribute('aria-live', 'polite');
    expect(announcement).toHaveTextContent('Katman ve hizmet paneli bölgesi etkin.');
  });

  it('syncs phase changes after rerender', () => {
    const { rerender } = render(<MapWorkspaceShellChrome phase="booting" />);
    expect(screen.getByRole('status')).toHaveTextContent('Hazırlanıyor');

    rerender(<MapWorkspaceShellChrome phase="ready" />);
    expect(screen.getByRole('status')).toHaveTextContent('Hazır');

    rerender(<MapWorkspaceShellChrome phase="updating" />);
    expect(screen.getByRole('status')).toHaveTextContent('Güncelleniyor');
  });

  it('reports observer failures through runtime diagnostics', () => {
    const model = createMapWorkspaceShellModel({
      onObserverError(error) {
        captureError(error, { source: 'test' }, 'warn');
      },
    });
    model.subscribe(() => { throw new Error('observer failure'); });
    render(<MapWorkspaceShellChrome phase="ready" model={model} />);

    model.setPhase('updating');

    expect(captureError).toHaveBeenCalled();
  });

  it('does not dispose a caller-owned model on unmount', () => {
    const model = createMapWorkspaceShellModel();
    const { unmount } = render(<MapWorkspaceShellChrome phase="ready" model={model} />);
    unmount();

    expect(model.disposed()).toBe(false);
  });

  it('keeps page shell pointer-safe by rendering one top-level aside', () => {
    const { container } = render(<MapWorkspaceShellChrome phase="ready" />);
    const shell = container.querySelector('aside.map-workspace-shell');
    expect(shell).toHaveAttribute('aria-label', 'Harita çalışma alanı durumu ve bölge navigasyonu');
  });
});
