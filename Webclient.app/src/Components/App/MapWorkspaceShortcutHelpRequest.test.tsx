import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAP_WORKSPACE_HELP_OPEN_EVENT,
  MapWorkspaceShortcutHelpLauncher,
  requestMapWorkspaceHelp,
} from './MapWorkspaceShortcutHelp';
import { createMapWorkspaceDialogSession } from './mapWorkspaceDialogRuntime';

vi.mock('./mapWorkspaceDialogRuntime', () => ({
  createMapWorkspaceDialogSession: vi.fn(() => ({
    focusInitial: vi.fn(),
    handleKeyDown: vi.fn(),
    dispose: vi.fn(),
  })),
}));

const dialogSessionMock = vi.mocked(createMapWorkspaceDialogSession);

describe('workspace help request bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the canonical help center from the exported request helper', () => {
    render(<MapWorkspaceShortcutHelpLauncher />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => { requestMapWorkspaceHelp(); });
    expect(screen.getByRole('dialog', { name: 'Harita çalışma alanı yardımı' })).toBeInTheDocument();
    expect(dialogSessionMock).toHaveBeenCalledTimes(1);
  });

  it('accepts the documented custom event without creating a second launcher authority', () => {
    render(<MapWorkspaceShortcutHelpLauncher />);
    act(() => { window.dispatchEvent(new Event(MAP_WORKSPACE_HELP_OPEN_EVENT)); });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Kısayollar' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the normal launcher button behavior after a programmatic open/close cycle', () => {
    render(<MapWorkspaceShortcutHelpLauncher />);
    act(() => { requestMapWorkspaceHelp(); });
    fireEvent.click(screen.getByRole('button', { name: 'Tamam' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Kısayollar' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not prevent the governed Shift+? shortcut after request bridge registration', () => {
    render(<MapWorkspaceShortcutHelpLauncher />);
    fireEvent.keyDown(window, { key: '?', code: 'Slash', shiftKey: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('removes the programmatic event listener on unmount', () => {
    const { unmount } = render(<MapWorkspaceShortcutHelpLauncher />);
    unmount();
    expect(() => window.dispatchEvent(new Event(MAP_WORKSPACE_HELP_OPEN_EVENT))).not.toThrow();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
