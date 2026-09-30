import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MapWorkspaceShortcutHelp, MapWorkspaceShortcutHelpLauncher } from './MapWorkspaceShortcutHelp';
import { createMapWorkspaceDialogSession } from './mapWorkspaceDialogRuntime';

vi.mock('./mapWorkspaceDialogRuntime', () => ({
  createMapWorkspaceDialogSession: vi.fn(() => ({
    focusInitial: vi.fn(),
    handleKeyDown: vi.fn(),
    dispose: vi.fn(),
  })),
}));

const dialogSessionMock = vi.mocked(createMapWorkspaceDialogSession);

const renderOpenHelp = (onClose = vi.fn()) => {
  const result = render(<MapWorkspaceShortcutHelp open onClose={onClose} />);
  return { ...result, onClose };
};

const getSearch = (): HTMLInputElement => screen.getByRole('combobox', { name: /kısayol ara/i });
const getOptions = (): HTMLElement[] => screen.queryAllByRole('option');

describe('MapWorkspaceShortcutHelp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing while closed', () => {
    render(<MapWorkspaceShortcutHelp open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(dialogSessionMock).not.toHaveBeenCalled();
  });

  it('opens as a labelled modal dialog and creates one governed dialog session', () => {
    renderOpenHelp();
    const dialog = screen.getByRole('dialog', { name: 'Harita kısayolları' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-describedby');
    expect(dialogSessionMock).toHaveBeenCalledTimes(1);
    expect(dialogSessionMock.mock.calls[0]?.[0]).toBe(dialog);
  });

  it('starts with all seven shortcuts and a deterministic active descendant', () => {
    renderOpenHelp();
    expect(getOptions()).toHaveLength(7);
    expect(screen.getByRole('status')).toHaveTextContent('7 harita kısayolu gösteriliyor.');
    expect(getSearch()).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-focus-map');
    expect(getOptions()[0]).toHaveAttribute('aria-selected', 'true');
    expect(getOptions()[0]).toHaveAttribute('aria-posinset', '1');
    expect(getOptions()[0]).toHaveAttribute('aria-setsize', '7');
  });

  it('exposes category filters as pressed-state buttons', () => {
    renderOpenHelp();
    expect(screen.getByRole('button', { name: 'Tümü' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Odak ve gezinme' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Çalışma alanı' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Harita araçları' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('filters by Turkish-insensitive query and updates result metadata', () => {
    renderOpenHelp();
    fireEvent.change(getSearch(), { target: { value: 'OLCUM' } });
    expect(getOptions()).toHaveLength(1);
    expect(getOptions()[0]).toHaveTextContent('Ölçüm araçlarını aç');
    expect(getOptions()[0]).toHaveTextContent('Alt+R');
    expect(getSearch()).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-measurement');
    expect(screen.getByRole('status')).toHaveTextContent('1 harita kısayolu bulundu.');
  });

  it('finds key labels through the same search input', () => {
    renderOpenHelp();
    fireEvent.change(getSearch(), { target: { value: 'Ctrl+K' } });
    expect(getOptions()).toHaveLength(1);
    expect(getOptions()[0]).toHaveTextContent('Komut merkezini aç');
  });

  it('filters to the tools category and preserves accessible collection positions', () => {
    renderOpenHelp();
    fireEvent.click(screen.getByRole('button', { name: 'Harita araçları' }));
    const options = getOptions();
    expect(options).toHaveLength(3);
    expect(options.map((option) => option.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('Altlık harita'),
      expect.stringContaining('Ölçüm'),
      expect.stringContaining('Geri bildirim'),
    ]));
    expect(options[0]).toHaveAttribute('aria-posinset', '1');
    expect(options[2]).toHaveAttribute('aria-posinset', '3');
    expect(options[2]).toHaveAttribute('aria-setsize', '3');
    expect(screen.getByRole('button', { name: 'Harita araçları' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('composes category and query filtering', () => {
    renderOpenHelp();
    fireEvent.click(screen.getByRole('button', { name: 'Çalışma alanı' }));
    fireEvent.change(getSearch(), { target: { value: 'komut' } });
    expect(getOptions()).toHaveLength(1);
    expect(getOptions()[0]).toHaveTextContent('Komut merkezini aç');
  });

  it('shows a useful empty state for unmatched text', () => {
    renderOpenHelp();
    fireEvent.change(getSearch(), { target: { value: 'uydu yörünge' } });
    expect(getOptions()).toHaveLength(0);
    expect(screen.getByText('Eşleşme bulunamadı')).toBeInTheDocument();
    expect(screen.getByText(/Arama ifadesini kısaltın/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Filtrelerle eşleşen harita kısayolu bulunamadı.');
    expect(getSearch()).not.toHaveAttribute('aria-activedescendant');
  });

  it('clears the query without resetting the selected category', () => {
    renderOpenHelp();
    fireEvent.click(screen.getByRole('button', { name: 'Harita araçları' }));
    fireEvent.change(getSearch(), { target: { value: 'ölçüm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kısayol aramasını temizle' }));
    expect(getSearch()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Harita araçları' })).toHaveAttribute('aria-pressed', 'true');
    expect(getOptions()).toHaveLength(3);
  });

  it('resets query and category from the empty-state recovery action', () => {
    renderOpenHelp();
    fireEvent.click(screen.getByRole('button', { name: 'Harita araçları' }));
    fireEvent.change(getSearch(), { target: { value: 'yok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tüm kısayolları göster' }));
    expect(getSearch()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Tümü' })).toHaveAttribute('aria-pressed', 'true');
    expect(getOptions()).toHaveLength(7);
  });

  it('moves the active descendant with ArrowDown and ArrowUp without moving DOM focus', () => {
    renderOpenHelp();
    const search = getSearch();
    search.focus();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-focus-navigation');
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-focus-map');
    expect(document.activeElement).toBe(search);
  });

  it('supports Home and End active-descendant movement', () => {
    renderOpenHelp();
    const search = getSearch();
    fireEvent.keyDown(search, { key: 'End' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-feedback');
    fireEvent.keyDown(search, { key: 'Home' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-focus-map');
  });

  it('supports PageDown and PageUp bounded movement', () => {
    renderOpenHelp();
    const search = getSearch();
    fireEvent.keyDown(search, { key: 'PageDown' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-measurement');
    fireEvent.keyDown(search, { key: 'PageUp' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-focus-map');
  });

  it('prevents the browser default for active-descendant navigation keys', () => {
    renderOpenHelp();
    const search = getSearch();
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    search.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('allows pointer exploration to update the active descendant without stealing input focus', () => {
    renderOpenHelp();
    const search = getSearch();
    search.focus();
    const feedback = screen.getByRole('option', { name: /Geri bildirim penceresini aç/i });
    fireEvent.mouseMove(feedback);
    expect(search).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-feedback');
    fireEvent.mouseDown(feedback);
    expect(document.activeElement).toBe(search);
  });

  it('shows category labels in each option to improve scanability', () => {
    renderOpenHelp();
    expect(screen.getAllByText('Odak ve gezinme')).toHaveLength(3);
    expect(screen.getAllByText('Çalışma alanı')).toHaveLength(3);
    expect(screen.getAllByText('Harita araçları')).toHaveLength(4);
  });

  it('shows a visual result count that stays hidden from assistive technology duplication', () => {
    renderOpenHelp();
    expect(screen.getByText('7/7')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Harita araçları' }));
    expect(screen.getByText('3/7')).toHaveAttribute('aria-hidden', 'true');
  });

  it('closes from the explicit close and done controls', () => {
    const { onClose } = renderOpenHelp();
    fireEvent.click(screen.getByRole('button', { name: 'Kısayol yardımını kapat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tamam' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes when the backdrop itself receives a mouse down', () => {
    const { onClose } = renderOpenHelp();
    const backdrop = screen.getByRole('dialog').parentElement;
    expect(backdrop).not.toBeNull();
    fireEvent.mouseDown(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when content receives a mouse down', () => {
    const { onClose } = renderOpenHelp();
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('resets discovery state after close and reopen', () => {
    const onClose = vi.fn();
    const { rerender } = render(<MapWorkspaceShortcutHelp open onClose={onClose} />);
    fireEvent.change(getSearch(), { target: { value: 'ölçüm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Harita araçları' }));
    rerender(<MapWorkspaceShortcutHelp open={false} onClose={onClose} />);
    rerender(<MapWorkspaceShortcutHelp open onClose={onClose} />);
    expect(getSearch()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Tümü' })).toHaveAttribute('aria-pressed', 'true');
    expect(getOptions()).toHaveLength(7);
  });

  it('disposes the governed dialog session on close', () => {
    const dispose = vi.fn();
    dialogSessionMock.mockReturnValueOnce({ focusInitial: vi.fn(), handleKeyDown: vi.fn(), dispose });
    const { rerender } = render(<MapWorkspaceShortcutHelp open onClose={vi.fn()} />);
    rerender(<MapWorkspaceShortcutHelp open={false} onClose={vi.fn()} />);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('MapWorkspaceShortcutHelpLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens and closes the help dialog from the launcher button', () => {
    render(<MapWorkspaceShortcutHelpLauncher />);
    const launcher = screen.getByRole('button', { name: 'Kısayollar' });
    expect(launcher).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(launcher);
    expect(launcher).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tamam' }));
    expect(launcher).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens on the governed Shift+? shortcut', () => {
    render(<MapWorkspaceShortcutHelpLauncher />);
    const event = new KeyboardEvent('keydown', { key: '?', code: 'Slash', shiftKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not open from a plain question-mark key event that fails the chord policy', () => {
    render(<MapWorkspaceShortcutHelpLauncher />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', code: 'Slash', bubbles: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not open while a text input owns the shortcut event', () => {
    render(<><input aria-label="Metin" /><MapWorkspaceShortcutHelpLauncher /></>);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Metin' }), { key: '?', code: 'Slash', shiftKey: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
