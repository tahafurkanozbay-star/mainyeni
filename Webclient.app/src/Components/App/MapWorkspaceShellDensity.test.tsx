import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MapWorkspaceShellOverlay } from './MapWorkspaceShellOverlay';

const mountLandmarks = (): void => {
  for (const id of ['esri-map-container', 'mainbar', 'sidebar', 'toolbar-widget']) {
    const element = document.createElement('div');
    element.id = id;
    document.body.appendChild(element);
  }
  const search = document.createElement('input');
  search.id = 'kentrehberi-global-search';
  document.body.appendChild(search);
};

const installMatchMedia = (coarse = false): void => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === '(pointer: coarse)' ? coarse : false,
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

describe('MapWorkspaceShellOverlay adaptive density', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
    installMatchMedia(false);
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 });
  });

  it('uses full density on a spacious keyboard workspace', async () => {
    mountLandmarks();
    render(<MapWorkspaceShellOverlay phase="ready" />);
    const region = screen.getByRole('complementary');
    await waitFor(() => expect(region).toHaveAttribute('data-density', 'full'));
    expect(screen.getByText(/ileri/)).toBeInTheDocument();
  });

  it('switches to compact density on a narrow viewport', async () => {
    mountLandmarks();
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 480 });
    render(<MapWorkspaceShellOverlay phase="ready" />);
    const region = screen.getByRole('complementary');
    await waitFor(() => expect(region).toHaveAttribute('data-density', 'compact'));
    expect(region).toHaveAttribute('data-density-reason', 'compact-viewport');
    expect(screen.queryByText(/ileri/)).not.toBeInTheDocument();
  });

  it('switches to compact density on a short landscape viewport', async () => {
    mountLandmarks();
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 480 });
    render(<MapWorkspaceShellOverlay phase="ready" />);
    await waitFor(() => expect(screen.getByRole('complementary')).toHaveAttribute('data-density-reason', 'very-short-viewport'));
  });

  it('uses status-only density when user preference is collapsed', async () => {
    sessionStorage.setItem('kentrehberi.workspace-shell.v1', JSON.stringify({ version: 1, collapsed: true }));
    mountLandmarks();
    render(<MapWorkspaceShellOverlay phase="ready" />);
    const region = screen.getByRole('complementary');
    await waitFor(() => expect(region).toHaveAttribute('data-density', 'status-only'));
    expect(region).toHaveAttribute('data-density-reason', 'user-collapsed');
    expect(document.getElementById('map-workspace-shell-actions')).toHaveAttribute('hidden');
  });

  it('recomputes density after a responsive resize', async () => {
    mountLandmarks();
    render(<MapWorkspaceShellOverlay phase="ready" />);
    const region = screen.getByRole('complementary');
    await waitFor(() => expect(region).toHaveAttribute('data-density', 'full'));
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 600 });
    act(() => window.dispatchEvent(new Event('resize')));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await waitFor(() => expect(region).toHaveAttribute('data-density', 'compact'));
  });
});
