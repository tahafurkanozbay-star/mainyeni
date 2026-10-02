import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MapWorkspaceShellChrome } from './MapWorkspaceShellChrome';
import { createMapWorkspaceShellController } from './mapWorkspaceShellController';
import { createMapWorkspaceShellModel } from './mapWorkspaceShellModel';

vi.mock('../../platform/runtime/runtimeDiagnostics', () => ({
  runtimeDiagnostics: {
    captureError: vi.fn(),
    record: vi.fn(),
  },
}));

const visibleRect = (width = 220, height = 64): DOMRect => ({
  x: 0,
  y: 0,
  width,
  height,
  top: 0,
  left: 0,
  right: width,
  bottom: height,
  toJSON: () => ({}),
} as DOMRect);

const show = (element: HTMLElement): void => {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(visibleRect());
};

const mountPageRegions = (): HTMLElement => {
  const page = document.createElement('main');
  page.dataset.shellContract = 'true';
  page.innerHTML = `
    <header class="mainbar-container">
      <button type="button">Ana navigasyon</button>
    </header>
    <section id="esri-map-container" aria-label="Ana harita"></section>
    <aside id="sidebar">
      <button type="button">Katman menüsü</button>
    </aside>
    <section id="toolbar-widget" aria-label="Harita araçları">
      <button type="button">Ölçüm</button>
    </section>
    <aside id="experience-workspace-controls" tabindex="-1">
      <button type="button">2 boyutlu harita</button>
    </aside>
    <button type="button" class="map-shortcut-help__launcher">Kısayollar</button>
  `;
  document.body.append(page);
  show(page);
  page.querySelectorAll<HTMLElement>('*').forEach(show);
  return page;
};

const cleanupPageRegions = (): void => {
  document.querySelectorAll('[data-shell-contract="true"]').forEach((element) => element.remove());
};

const openRegionMenu = (): void => {
  fireEvent.click(screen.getByText('Bölgeler'));
};

describe('Map workspace page-shell experience contract', () => {
  beforeEach(() => {
    mountPageRegions();
  });

  afterEach(() => {
    cleanupPageRegions();
    vi.restoreAllMocks();
  });

  it('exposes one labelled shell landmark without replacing the map landmark', () => {
    const { container } = render(<MapWorkspaceShellChrome phase="ready" />);

    expect(container.querySelectorAll('aside.map-workspace-shell')).toHaveLength(1);
    expect(container.querySelector('aside.map-workspace-shell')).toHaveAttribute(
      'aria-label',
      'Harita çalışma alanı durumu ve bölge navigasyonu',
    );
    expect(document.getElementById('esri-map-container')).toHaveAttribute('aria-label', 'Ana harita');
  });

  it('keeps the ready shell informational rather than modal', () => {
    const { container } = render(<MapWorkspaceShellChrome phase="ready" />);
    const shell = container.querySelector('aside.map-workspace-shell');

    expect(shell).not.toHaveAttribute('aria-modal');
    expect(shell).not.toHaveAttribute('role', 'dialog');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('uses an assertive alert only for actual map errors', () => {
    const { rerender } = render(<MapWorkspaceShellChrome phase="ready" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    rerender(<MapWorkspaceShellChrome phase="error" errorMessage="Harita başlatılamadı" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Hata');
  });

  it('keeps recovery actions typed as buttons', () => {
    render(<MapWorkspaceShellChrome phase="error" onRetry={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Haritayı yeniden hazırla' })).toHaveAttribute('type', 'button');
  });

  it('distinguishes missing retry callback from an exhausted retry budget', () => {
    render(<MapWorkspaceShellChrome phase="error" />);
    const note = screen.getByRole('note');

    expect(note).toHaveTextContent('Bu ekranda yeniden başlatma eylemi kullanılamıyor');
    expect(note).not.toHaveTextContent('güvenlik sınırına ulaşıldı');
  });

  it('moves to the exhausted retry note only after the retry budget is used', () => {
    const model = createMapWorkspaceShellModel({ maxRetries: 1 });
    render(<MapWorkspaceShellChrome phase="error" onRetry={vi.fn()} model={model} />);

    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden hazırla' }));
    act(() => model.markRetryFailed());

    expect(screen.getByRole('note')).toHaveTextContent('Yeniden deneme güvenlik sınırına ulaşıldı');
  });

  it('exposes region navigation as a native details/summary disclosure', () => {
    const { container } = render(<MapWorkspaceShellChrome phase="ready" />);
    const details = container.querySelector<HTMLDetailsElement>('details.map-workspace-shell__regions');
    const summary = container.querySelector('summary.map-workspace-shell__regions-summary');

    expect(details).toBeInTheDocument();
    expect(summary).toHaveAttribute('aria-label', 'Çalışma alanı bölgeleri');
    expect(details?.open).toBe(false);
    fireEvent.click(summary!);
    expect(details?.open).toBe(true);
  });

  it('exposes all six canonical regions in the real page shell', () => {
    render(<MapWorkspaceShellChrome phase="ready" />);
    openRegionMenu();

    const regionButtons = document.querySelectorAll<HTMLButtonElement>('.map-workspace-shell__region-button');
    expect(regionButtons).toHaveLength(6);
    expect(Array.from(regionButtons).map((button) => button.dataset.region)).toEqual([
      'navigation',
      'map',
      'sidebar',
      'toolbar',
      'workspace',
      'help',
    ]);
  });

  it('gives every region button an explicit accessible purpose', () => {
    render(<MapWorkspaceShellChrome phase="ready" />);
    openRegionMenu();

    for (const button of document.querySelectorAll<HTMLButtonElement>('.map-workspace-shell__region-button')) {
      expect(button.getAttribute('aria-label')?.length).toBeGreaterThan(35);
      expect(button.getAttribute('aria-label')).toMatch(/kullanılabilir/i);
    }
  });

  it('keeps all region actions as type=button controls', () => {
    render(<MapWorkspaceShellChrome phase="ready" />);
    openRegionMenu();

    for (const button of document.querySelectorAll<HTMLButtonElement>('.map-workspace-shell__region-button')) {
      expect(button.type).toBe('button');
    }
  });

  it('provides visible keyboard guidance for every region', () => {
    render(<MapWorkspaceShellChrome phase="ready" />);
    openRegionMenu();

    const hints = document.querySelectorAll('.map-workspace-shell__region-keyboard');
    expect(hints).toHaveLength(6);
    for (const hint of hints) expect(hint.textContent).toMatch(/F6/);
  });

  it('provides user-facing purpose text for every region', () => {
    render(<MapWorkspaceShellChrome phase="ready" />);
    openRegionMenu();

    const purposes = document.querySelectorAll('.map-workspace-shell__region-purpose');
    expect(purposes).toHaveLength(6);
    for (const purpose of purposes) expect(purpose.textContent?.trim().length).toBeGreaterThan(18);
  });

  it('renders the available region count outside assistive duplication', () => {
    render(<MapWorkspaceShellChrome phase="ready" />);
    const count = document.querySelector('.map-workspace-shell__region-count');

    expect(count).toHaveTextContent('6');
    expect(count).toHaveAttribute('aria-hidden', 'true');
  });

  it('disables a hidden sidebar region instead of silently dropping the semantic option', () => {
    const sidebar = document.getElementById('sidebar')!;
    sidebar.hidden = true;
    render(<MapWorkspaceShellChrome phase="ready" />);
    openRegionMenu();

    const panel = screen.getByRole('button', { name: /Panel\. Katman paneli şu anda kapalı/i });
    expect(panel).toBeDisabled();
    expect(panel).toHaveTextContent('Katman paneli şu anda kapalı');
  });

  it('updates the visible count when a region is unavailable', () => {
    document.getElementById('toolbar-widget')!.hidden = true;
    render(<MapWorkspaceShellChrome phase="ready" />);

    expect(document.querySelector('.map-workspace-shell__region-count')).toHaveTextContent('5');
  });

  it('moves keyboard focus from navigation to map with F6', () => {
    const navigationButton = document.querySelector<HTMLButtonElement>('.mainbar-container button')!;
    navigationButton.focus();
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    render(<MapWorkspaceShellChrome phase="ready" model={model} controller={controller} />);

    fireEvent.keyDown(window, { key: 'F6' });

    expect(model.getSnapshot().activeRegion).toBe('map');
    expect(document.activeElement?.id).toBe('esri-map-container');
  });

  it('moves backward from map to navigation with Shift+F6', () => {
    const map = document.getElementById('esri-map-container')!;
    map.setAttribute('tabindex', '-1');
    map.focus();
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    render(<MapWorkspaceShellChrome phase="ready" model={model} controller={controller} />);

    fireEvent.keyDown(window, { key: 'F6', shiftKey: true });

    expect(model.getSnapshot().activeRegion).toBe('navigation');
    expect(document.activeElement?.textContent).toContain('Ana navigasyon');
  });

  it('announces the focused region after F6 movement', () => {
    const navigationButton = document.querySelector<HTMLButtonElement>('.mainbar-container button')!;
    navigationButton.focus();
    render(<MapWorkspaceShellChrome phase="ready" />);

    fireEvent.keyDown(window, { key: 'F6' });

    expect(document.querySelector('.map-workspace-shell__announcement')).toHaveTextContent('Ana harita bölgesi etkin.');
  });

  it('marks the active region button when the menu opens after F6', () => {
    const navigationButton = document.querySelector<HTMLButtonElement>('.mainbar-container button')!;
    navigationButton.focus();
    render(<MapWorkspaceShellChrome phase="ready" />);
    fireEvent.keyDown(window, { key: 'F6' });
    openRegionMenu();

    expect(document.querySelector<HTMLButtonElement>('[data-region="map"]')).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not steal F6 from an active modal', () => {
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const input = document.createElement('input');
    input.setAttribute('aria-label', 'Modal alan');
    modal.append(input);
    document.body.append(modal);
    show(modal);
    show(input);
    input.focus();
    render(<MapWorkspaceShellChrome phase="ready" />);

    fireEvent.keyDown(window, { key: 'F6' });

    expect(document.activeElement).toBe(input);
    modal.remove();
  });

  it('does not trap ordinary Tab navigation in the page shell', () => {
    const navigationButton = document.querySelector<HTMLButtonElement>('.mainbar-container button')!;
    navigationButton.focus();
    render(<MapWorkspaceShellChrome phase="ready" />);
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('keeps the region menu usable after map lifecycle changes', () => {
    const { rerender } = render(<MapWorkspaceShellChrome phase="booting" />);
    rerender(<MapWorkspaceShellChrome phase="updating" />);
    rerender(<MapWorkspaceShellChrome phase="ready" />);
    openRegionMenu();

    expect(document.querySelectorAll('.map-workspace-shell__region-button')).toHaveLength(6);
  });

  it('keeps recovery separate from the region navigator', () => {
    render(<MapWorkspaceShellChrome phase="error" onRetry={vi.fn()} />);
    openRegionMenu();

    expect(screen.getByRole('heading', { name: 'Harita hazırlanamadı' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Odaklanılabilir çalışma alanı bölgeleri' })).toBeInTheDocument();
  });

  it('keeps controls reachable while the map itself is in error', () => {
    render(<MapWorkspaceShellChrome phase="error" onRetry={vi.fn()} />);
    openRegionMenu();

    expect(screen.getByRole('button', { name: /Navigasyon\. Navigasyon kullanılabilir/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Yardım\. Yardım kullanılabilir/i })).toBeEnabled();
  });

  it('exposes recovery attempt progress without raw exception metadata', () => {
    const model = createMapWorkspaceShellModel({ maxRetries: 3 });
    render(<MapWorkspaceShellChrome phase="error" errorMessage="Sensitive stack should not be shown" onRetry={vi.fn()} model={model} />);
    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden hazırla' }));
    act(() => model.markRetryFailed());

    expect(screen.getByText('Deneme 1/3')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/stack trace|at .*\.tsx:\d+/i);
  });

  it('keeps retry telemetry bounded to numeric attempt facts in the model', () => {
    const model = createMapWorkspaceShellModel({ maxRetries: 3 });
    render(<MapWorkspaceShellChrome phase="error" onRetry={vi.fn()} model={model} />);
    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden hazırla' }));

    expect(model.getSnapshot().retryAttempt).toBe(1);
    expect(model.getSnapshot().maxRetries).toBe(3);
  });

  it('keeps shell live announcements atomic', () => {
    render(<MapWorkspaceShellChrome phase="ready" />);
    const announcement = document.querySelector('.map-workspace-shell__announcement');

    expect(announcement).toHaveAttribute('aria-live', 'polite');
    expect(announcement).toHaveAttribute('aria-atomic', 'true');
  });

  it('keeps phase status live announcements atomic', () => {
    render(<MapWorkspaceShellChrome phase="ready" />);
    const status = screen.getByRole('status');

    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
  });

  it('uses real semantic text instead of icon-only region buttons', () => {
    render(<MapWorkspaceShellChrome phase="ready" />);
    openRegionMenu();

    const button = document.querySelector<HTMLButtonElement>('[data-region="toolbar"]')!;
    expect(button).toHaveTextContent('Araçlar');
    expect(button).toHaveTextContent('Ölçüm');
    expect(button.textContent?.trim().length).toBeGreaterThan(30);
  });

  it('preserves canonical region ordering for predictable keyboard traversal', () => {
    render(<MapWorkspaceShellChrome phase="ready" />);
    openRegionMenu();

    expect(Array.from(document.querySelectorAll<HTMLElement>('[data-region]')).map((element) => element.dataset.region)).toEqual([
      'navigation',
      'map',
      'sidebar',
      'toolbar',
      'workspace',
      'help',
    ]);
  });

  it('does not expose unavailable regions as pressed', () => {
    document.getElementById('sidebar')!.hidden = true;
    render(<MapWorkspaceShellChrome phase="ready" />);
    openRegionMenu();

    const sidebar = document.querySelector<HTMLButtonElement>('[data-region="sidebar"]')!;
    expect(sidebar).toBeDisabled();
    expect(sidebar).not.toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps focus on the destination after a region menu action', () => {
    render(<MapWorkspaceShellChrome phase="ready" />);
    openRegionMenu();
    const helpRegion = document.querySelector<HTMLButtonElement>('[data-region="help"]')!;

    fireEvent.click(helpRegion);

    expect(document.activeElement).toHaveClass('map-shortcut-help__launcher');
  });

  it('allows the user to reopen region navigation after a completed focus jump', () => {
    render(<MapWorkspaceShellChrome phase="ready" />);
    openRegionMenu();
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-region="help"]')!);

    fireEvent.click(screen.getByText('Bölgeler'));

    expect(screen.getByRole('group', { name: 'Odaklanılabilir çalışma alanı bölgeleri' })).toBeInTheDocument();
  });
});
