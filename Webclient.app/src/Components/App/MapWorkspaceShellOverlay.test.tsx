import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MapWorkspaceShellOverlay } from './MapWorkspaceShellOverlay';

const mediaState = new Map<string, boolean>();

const installMatchMedia = (): void => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: mediaState.get(query) === true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  });
};

const addLandmark = (id: string, tagName = 'div'): HTMLElement => {
  const element = document.createElement(tagName);
  element.id = id;
  document.body.appendChild(element);
  return element;
};

const installDefaultLandmarks = (): Record<string, HTMLElement> => ({
  map: addLandmark('esri-map-container'),
  navigation: addLandmark('mainbar', 'header'),
  search: addLandmark('kentrehberi-global-search', 'input'),
  sidebar: addLandmark('sidebar'),
  toolbar: addLandmark('toolbar-widget'),
});

const flushFrame = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
};

describe('MapWorkspaceShellOverlay', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
    mediaState.clear();
    installMatchMedia();
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 720 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  it('renders a labelled workspace region', () => {
    render(<MapWorkspaceShellOverlay phase="ready" />);
    expect(screen.getByRole('complementary', { name: 'Çalışma alanı durumu ve hızlı gezinme' })).toBeInTheDocument();
  });

  it('renders ready phase as a visible success state', () => {
    render(<MapWorkspaceShellOverlay phase="ready" />);
    expect(screen.getByText('Hazır')).toBeInTheDocument();
    expect(screen.getByText(/Harita ve çalışma alanı kontrolleri kullanıma hazır/)).toBeInTheDocument();
    expect(screen.getByRole('complementary')).toHaveAttribute('data-health', 'success');
  });

  it('renders updating phase without disabling the utility surface', () => {
    installDefaultLandmarks();
    render(<MapWorkspaceShellOverlay phase="updating" />);
    expect(screen.getByText('Güncelleniyor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Harita yüzeyine odaklan' })).toBeEnabled();
  });

  it('renders an error state while keeping navigation available', () => {
    installDefaultLandmarks();
    render(<MapWorkspaceShellOverlay phase="error" />);
    expect(screen.getByText('Dikkat gerekiyor')).toBeInTheDocument();
    expect(screen.getByText(/Sayfa gezinmesi ve yardım seçenekleri kullanılabilir/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adres, yer veya katman aramasına git' })).toBeEnabled();
  });

  it('discovers mounted page landmarks on initial runtime refresh', async () => {
    installDefaultLandmarks();
    render(<MapWorkspaceShellOverlay phase="ready" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Harita yüzeyine odaklan' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Üst gezinmeye git' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adres, yer veya katman aramasına git' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Katman ve hizmet menüsüne git' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Harita araçlarına git' })).toBeInTheDocument();
  });

  it('shows the number of available landmarks', async () => {
    installDefaultLandmarks();
    render(<MapWorkspaceShellOverlay phase="ready" />);
    await waitFor(() => expect(screen.getByLabelText('5 hızlı gezinme hedefi')).toHaveTextContent('5'));
  });

  it('focuses the map through the quick navigation button', async () => {
    const landmarks = installDefaultLandmarks();
    render(<MapWorkspaceShellOverlay phase="ready" />);
    const button = await screen.findByRole('button', { name: 'Harita yüzeyine odaklan' });
    fireEvent.click(button);
    expect(document.activeElement).toBe(landmarks.map);
  });

  it('focuses the native search input without changing its tabindex', async () => {
    const landmarks = installDefaultLandmarks();
    render(<MapWorkspaceShellOverlay phase="ready" />);
    const search = landmarks.search;
    expect(search.hasAttribute('tabindex')).toBe(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Adres, yer veya katman aramasına git' }));
    expect(document.activeElement).toBe(search);
    expect(search.hasAttribute('tabindex')).toBe(false);
  });

  it('marks the focused landmark as the current location', async () => {
    const landmarks = installDefaultLandmarks();
    render(<MapWorkspaceShellOverlay phase="ready" />);
    const button = await screen.findByRole('button', { name: 'Harita araçlarına git' });
    fireEvent.focusIn(landmarks.toolbar);
    await waitFor(() => expect(button).toHaveAttribute('aria-current', 'location'));
  });

  it('collapses and expands utility actions', async () => {
    installDefaultLandmarks();
    render(<MapWorkspaceShellOverlay phase="ready" />);
    const collapse = screen.getByRole('button', { name: 'Daralt' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(collapse);
    expect(screen.getByRole('button', { name: 'Hızlı gezinmeyi aç' })).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('map-workspace-shell-actions')).toHaveAttribute('hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Hızlı gezinmeyi aç' }));
    expect(screen.getByRole('button', { name: 'Daralt' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('persists collapsed preference only in session storage', async () => {
    installDefaultLandmarks();
    render(<MapWorkspaceShellOverlay phase="ready" />);
    fireEvent.click(screen.getByRole('button', { name: 'Daralt' }));
    await waitFor(() => expect(sessionStorage.getItem('kentrehberi.workspace-shell.v1')).toContain('"collapsed":true'));
  });

  it('restores collapsed preference from session storage', async () => {
    sessionStorage.setItem('kentrehberi.workspace-shell.v1', JSON.stringify({ version: 1, collapsed: true }));
    installDefaultLandmarks();
    render(<MapWorkspaceShellOverlay phase="ready" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Hızlı gezinmeyi aç' })).toBeInTheDocument());
  });

  it('does not persist query, location or other user content', async () => {
    installDefaultLandmarks();
    render(<MapWorkspaceShellOverlay phase="ready" />);
    fireEvent.click(screen.getByRole('button', { name: 'Daralt' }));
    await waitFor(() => {
      const raw = sessionStorage.getItem('kentrehberi.workspace-shell.v1') ?? '';
      expect(raw).toBe(JSON.stringify({ version: 1, collapsed: true }));
    });
  });

  it('cycles forward through landmarks with F6', async () => {
    const landmarks = installDefaultLandmarks();
    render(<MapWorkspaceShellOverlay phase="ready" />);
    await screen.findByRole('button', { name: 'Harita yüzeyine odaklan' });
    const first = new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true });
    act(() => window.dispatchEvent(first));
    expect(first.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(landmarks.map);
    const second = new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true });
    act(() => window.dispatchEvent(second));
    expect(document.activeElement).toBe(landmarks.navigation);
  });

  it('cycles backward through landmarks with Shift+F6', async () => {
    const landmarks = installDefaultLandmarks();
    render(<MapWorkspaceShellOverlay phase="ready" />);
    await screen.findByRole('button', { name: 'Harita yüzeyine odaklan' });
    const event = new KeyboardEvent('keydown', { key: 'F6', shiftKey: true, bubbles: true, cancelable: true });
    act(() => window.dispatchEvent(event));
    expect(document.activeElement).toBe(landmarks.toolbar);
  });

  it('does not steal F6 from the global search input', async () => {
    const landmarks = installDefaultLandmarks();
    render(<MapWorkspaceShellOverlay phase="ready" />);
    const search = landmarks.search as HTMLInputElement;
    search.focus();
    const event = new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true });
    search.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(search);
  });

  it('discovers landmarks mounted after the overlay', async () => {
    render(<MapWorkspaceShellOverlay phase="ready" />);
    const region = screen.getByRole('complementary');
    expect(region).toHaveAttribute('data-density', 'status-only');
    expect(region).toHaveAttribute('data-density-reason', 'no-landmarks');
    expect(screen.getByLabelText('0 hızlı gezinme hedefi')).toHaveTextContent('0');

    addLandmark('sidebar');
    await flushFrame();

    expect(await screen.findByRole('button', { name: 'Katman ve hizmet menüsüne git' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('1 hızlı gezinme hedefi')).toHaveTextContent('1'));
    expect(region).not.toHaveAttribute('data-density-reason', 'no-landmarks');
  });

  it('removes controls for landmarks that leave the DOM', async () => {
    const sidebar = addLandmark('sidebar');
    render(<MapWorkspaceShellOverlay phase="ready" />);
    expect(await screen.findByRole('button', { name: 'Katman ve hizmet menüsüne git' })).toBeInTheDocument();
    sidebar.remove();
    await flushFrame();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Katman ve hizmet menüsüne git' })).not.toBeInTheDocument());
  });

  it('derives lifecycle phase from the map root when no phase prop is supplied', async () => {
    const map = addLandmark('esri-map-container');
    map.dataset.workspacePhase = 'ready';
    render(<MapWorkspaceShellOverlay />);
    await waitFor(() => expect(screen.getByText('Hazır')).toBeInTheDocument());
  });

  it('reacts to map lifecycle attribute changes', async () => {
    const map = addLandmark('esri-map-container');
    map.dataset.workspacePhase = 'ready';
    render(<MapWorkspaceShellOverlay />);
    await waitFor(() => expect(screen.getByText('Hazır')).toBeInTheDocument());
    act(() => { map.dataset.workspacePhase = 'updating'; });
    await waitFor(() => expect(screen.getByText('Güncelleniyor')).toBeInTheDocument());
    act(() => { map.dataset.workspacePhase = 'error'; });
    await waitFor(() => expect(screen.getByText('Dikkat gerekiyor')).toBeInTheDocument());
  });

  it('ignores unknown map lifecycle attribute values', async () => {
    const map = addLandmark('esri-map-container');
    map.dataset.workspacePhase = 'ready';
    render(<MapWorkspaceShellOverlay />);
    await waitFor(() => expect(screen.getByText('Hazır')).toBeInTheDocument());
    act(() => { map.dataset.workspacePhase = 'mystery'; });
    expect(screen.getByText('Hazır')).toBeInTheDocument();
  });

  it('updates responsive viewport metadata after resize', async () => {
    render(<MapWorkspaceShellOverlay phase="ready" />);
    expect(screen.getByRole('complementary')).toHaveAttribute('data-viewport', 'wide');
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 480 });
    act(() => window.dispatchEvent(new Event('resize')));
    await flushFrame();
    await waitFor(() => expect(screen.getByRole('complementary')).toHaveAttribute('data-viewport', 'compact'));
  });

  it('exposes keyboard cycling guidance visually without duplicating it to screen readers', async () => {
    installDefaultLandmarks();
    render(<MapWorkspaceShellOverlay phase="ready" />);
    await screen.findByRole('button', { name: 'Harita yüzeyine odaklan' });
    const hint = screen.getByText(/ileri/);
    expect(hint).toHaveAttribute('aria-hidden', 'true');
    expect(hint).toHaveTextContent('F6');
  });
});
