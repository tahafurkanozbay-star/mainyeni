import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceAccessibilityCenter } from './WorkspaceAccessibilityCenter';
import { WorkspaceAccessibilityProvider } from './WorkspaceAccessibilityProvider';

vi.mock('../../platform/runtime/runtimeDiagnostics', () => ({
  runtimeDiagnostics: {
    captureError: vi.fn(),
    record: vi.fn(),
  },
}));

const createMediaQuery = (matches = false): MediaQueryList => ({
  matches,
  media: '',
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
});

const renderCenter = () => render(
  <WorkspaceAccessibilityProvider>
    <div id="app-shell">
      <main id="experience-workspace-controls" tabIndex={-1}>Workspace</main>
      <aside id="sidebar" tabIndex={-1}>Tools</aside>
      <div id="esri-map-container" tabIndex={0} data-workspace-phase="ready">Map</div>
      <div className="experience-map-interaction-guide" data-visible="true">Keyboard guide</div>
    </div>
    <WorkspaceAccessibilityCenter />
  </WorkspaceAccessibilityProvider>,
);

const launcher = (): HTMLButtonElement => screen.getByRole('button', { name: /Erişilebilirlik Hazır/i });

beforeEach(() => {
  sessionStorage.clear();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => createMediaQuery(query.includes('forced-colors') ? false : false)),
  });
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
});

afterEach(() => {
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('WorkspaceAccessibilityCenter integration', () => {
  it('renders a compact launcher while the center is closed', async () => {
    renderCenter();
    await waitFor(() => expect(launcher()).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByRole('region', { name: 'Erişilebilirlik merkezi' })).not.toBeInTheDocument();
  });

  it('opens a labelled region with status, focus actions, preferences and usage notes', async () => {
    renderCenter();
    fireEvent.click(launcher());
    const region = await screen.findByRole('region', { name: 'Erişilebilirlik merkezi' });
    expect(region).toBeInTheDocument();
    expect(screen.getByText('Hızlı odak geçişleri')).toBeInTheDocument();
    expect(screen.getByText('Görsel rehber tercihleri')).toBeInTheDocument();
    expect(screen.getByText('Kullanım notları')).toBeInTheDocument();
    expect(screen.getByText(/WCAG uygunluk puanı değildir/i)).toBeInTheDocument();
  });

  it('moves initial focus to the close button when opened', async () => {
    renderCenter();
    fireEvent.click(launcher());
    const close = await screen.findByRole('button', { name: 'Erişilebilirlik merkezini kapat' });
    await waitFor(() => expect(document.activeElement).toBe(close));
  });

  it('closes with Escape and restores focus to the launcher', async () => {
    renderCenter();
    fireEvent.click(launcher());
    await screen.findByRole('region', { name: 'Erişilebilirlik merkezi' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Erişilebilirlik merkezi' })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(launcher()));
  });

  it('closes from the explicit done control', async () => {
    renderCenter();
    fireEvent.click(launcher());
    fireEvent.click(await screen.findByRole('button', { name: 'Tamam' }));
    await waitFor(() => expect(launcher()).toHaveAttribute('aria-expanded', 'false'));
  });

  it('moves focus to the map through the visible focus action', async () => {
    renderCenter();
    fireEvent.click(launcher());
    const mapAction = await screen.findByRole('button', { name: /Harita.*Harita çalışma yüzeyine geçin/i });
    fireEvent.click(mapAction);
    const map = document.getElementById('esri-map-container');
    await waitFor(() => expect(document.activeElement).toBe(map));
    expect(screen.queryByRole('region', { name: 'Erişilebilirlik merkezi' })).not.toBeInTheDocument();
  });

  it('moves focus to the tools landmark without changing GIS state', async () => {
    renderCenter();
    fireEvent.click(launcher());
    const toolsAction = await screen.findByRole('button', { name: /Araçlar.*Katman ve harita araçları paneline geçin/i });
    fireEvent.click(toolsAction);
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('sidebar')));
  });

  it('adds a keyboard focus-recovery marker when the last input modality is keyboard', async () => {
    renderCenter();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    fireEvent.click(launcher());
    const mapAction = await screen.findByRole('button', { name: /Harita.*Harita çalışma yüzeyine geçin/i });
    fireEvent.click(mapAction);
    const map = document.getElementById('esri-map-container')!;
    await waitFor(() => expect(map.dataset.workspaceFocusRecovery).toBe('true'));
    fireEvent.blur(map);
    expect(map.dataset.workspaceFocusRecovery).toBeUndefined();
  });

  it('reflects runtime facts as bounded data attributes on the app shell', async () => {
    renderCenter();
    const shell = document.getElementById('app-shell')!;
    await waitFor(() => expect(shell).toHaveAttribute('data-workspace-online', 'true'));
    expect(shell).toHaveAttribute('data-workspace-map-busy', 'false');
    expect(shell).toHaveAttribute('data-workspace-keyboard-guide', 'true');
  });

  it('binds the keyboard-guide visual preference to the app shell', async () => {
    renderCenter();
    fireEvent.click(launcher());
    const checkbox = await screen.findByRole('checkbox', { name: /Klavye rehberini göster/i });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    await waitFor(() => expect(document.getElementById('app-shell')).toHaveAttribute('data-workspace-keyboard-guide', 'false'));
  });

  it('persists visual preferences in bounded session storage', async () => {
    renderCenter();
    fireEvent.click(launcher());
    const checkbox = await screen.findByRole('checkbox', { name: /Bağlantı kesilince merkezi aç/i });
    fireEvent.click(checkbox);
    await waitFor(() => expect(sessionStorage.getItem('kentrehberi:workspace-accessibility:v1')).not.toBeNull());
    expect(sessionStorage.getItem('kentrehberi:workspace-accessibility:v1')!.length).toBeLessThan(256);
  });

  it('resets visual preferences without removing live-region infrastructure', async () => {
    renderCenter();
    fireEvent.click(launcher());
    const keyboardGuide = await screen.findByRole('checkbox', { name: /Klavye rehberini göster/i });
    fireEvent.click(keyboardGuide);
    expect(keyboardGuide).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Görsel tercihleri sıfırla' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Klavye rehberini göster/i })).toBeChecked());
    expect(document.querySelectorAll('.workspace-accessibility-live')).toHaveLength(2);
  });

  it('opens automatically when the connection goes offline by default', async () => {
    renderCenter();
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(await screen.findByRole('region', { name: 'Erişilebilirlik merkezi' })).toBeInTheDocument();
    expect(screen.getByText('Çevrimdışı')).toBeInTheDocument();
  });

  it('keeps polite and assertive live regions independent', async () => {
    renderCenter();
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    const liveRegions = document.querySelectorAll('.workspace-accessibility-live');
    expect(liveRegions).toHaveLength(2);
    await waitFor(() => expect(liveRegions[1]).toHaveTextContent('Bağlantı kesildi'));
    expect(liveRegions[0]).not.toHaveTextContent('Bağlantı kesildi');
  });

  it('updates the map status after data-workspace-phase changes', async () => {
    renderCenter();
    const map = document.getElementById('esri-map-container')!;
    act(() => {
      map.dataset.workspacePhase = 'updating';
    });
    fireEvent.click(launcher());
    await waitFor(() => expect(screen.getByText('Güncelleniyor')).toBeInTheDocument());
  });

  it('binds to a map surface that mounts after the provider starts', async () => {
    const view = render(
      <WorkspaceAccessibilityProvider>
        <div id="app-shell"><div id="placeholder">Loading</div></div>
        <WorkspaceAccessibilityCenter />
      </WorkspaceAccessibilityProvider>,
    );
    expect(document.getElementById('esri-map-container')).toBeNull();
    view.rerender(
      <WorkspaceAccessibilityProvider>
        <div id="app-shell"><div id="esri-map-container" tabIndex={0} data-workspace-phase="updating">Map</div></div>
        <WorkspaceAccessibilityCenter />
      </WorkspaceAccessibilityProvider>,
    );
    fireEvent.click(launcher());
    await waitFor(() => expect(screen.getByText('Güncelleniyor')).toBeInTheDocument());
  });

  it('shows operating-system reduced-motion and forced-color adaptations', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => createMediaQuery(query.includes('reduced-motion') || query.includes('forced-colors'))),
    });
    renderCenter();
    fireEvent.click(launcher());
    await waitFor(() => expect(screen.getByText('Azaltılmış hareket etkin')).toBeInTheDocument());
    expect(screen.getByText('Zorunlu renkler etkin')).toBeInTheDocument();
  });

  it('does not trap focus when the center is closed', async () => {
    renderCenter();
    const map = document.getElementById('esri-map-container')!;
    map.focus();
    expect(document.activeElement).toBe(map);
    expect(launcher()).toHaveAttribute('aria-expanded', 'false');
  });
});
