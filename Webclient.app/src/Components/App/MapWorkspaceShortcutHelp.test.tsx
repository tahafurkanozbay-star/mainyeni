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

const getShortcutSearch = (): HTMLInputElement => screen.getByRole('combobox', { name: /kısayol ara/i });
const getShortcutTab = (): HTMLButtonElement => screen.getByRole('tab', { name: /Kısayollar/i });
const getGuideTab = (): HTMLButtonElement => screen.getByRole('tab', { name: /Çalışma rehberi/i });

describe('MapWorkspaceShortcutHelp help center', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing while closed', () => {
    render(<MapWorkspaceShortcutHelp open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(dialogSessionMock).not.toHaveBeenCalled();
  });

  it('opens as one governed labelled modal dialog', () => {
    renderOpenHelp();
    const dialog = screen.getByRole('dialog', { name: 'Harita çalışma alanı yardımı' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-describedby');
    expect(dialogSessionMock).toHaveBeenCalledTimes(1);
    expect(dialogSessionMock.mock.calls[0]?.[0]).toBe(dialog);
  });

  it('starts on the shortcuts tab with correct roving tab semantics', () => {
    renderOpenHelp();
    expect(getShortcutTab()).toHaveAttribute('aria-selected', 'true');
    expect(getShortcutTab()).toHaveAttribute('tabindex', '0');
    expect(getGuideTab()).toHaveAttribute('aria-selected', 'false');
    expect(getGuideTab()).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel', { name: /Kısayollar/i })).toBeVisible();
  });

  it('switches to the workspace guide by pointer and exposes sixteen guide topics', () => {
    renderOpenHelp();
    fireEvent.click(getGuideTab());
    expect(getGuideTab()).toHaveAttribute('aria-selected', 'true');
    expect(getShortcutTab()).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel', { name: /Çalışma rehberi/i })).toBeVisible();
    expect(screen.getByRole('combobox', { name: /çalışma alanı rehberinde ara/i })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(16);
  });

  it('switches tabs with ArrowRight and ArrowLeft', () => {
    renderOpenHelp();
    getShortcutTab().focus();
    fireEvent.keyDown(getShortcutTab(), { key: 'ArrowRight' });
    expect(getGuideTab()).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(getGuideTab(), { key: 'ArrowLeft' });
    expect(getShortcutTab()).toHaveAttribute('aria-selected', 'true');
  });

  it('switches tabs with Home and End', () => {
    renderOpenHelp();
    fireEvent.keyDown(getShortcutTab(), { key: 'End' });
    expect(getGuideTab()).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(getGuideTab(), { key: 'Home' });
    expect(getShortcutTab()).toHaveAttribute('aria-selected', 'true');
  });

  it('starts shortcut discovery with all seven shortcuts', () => {
    renderOpenHelp();
    expect(screen.getAllByRole('option')).toHaveLength(7);
    expect(screen.getByRole('status')).toHaveTextContent('7 harita kısayolu gösteriliyor.');
    expect(getShortcutSearch()).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-focus-map');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-posinset', '1');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-setsize', '7');
  });

  it('exposes shortcut category filters as pressed-state buttons', () => {
    renderOpenHelp();
    expect(screen.getByRole('button', { name: 'Tümü' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Odak ve gezinme' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Çalışma alanı' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Harita araçları' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('filters shortcuts with Turkish-insensitive query', () => {
    renderOpenHelp();
    fireEvent.change(getShortcutSearch(), { target: { value: 'OLCUM' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Ölçüm araçlarını aç');
    expect(options[0]).toHaveTextContent('Alt+R');
    expect(getShortcutSearch()).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-measurement');
    expect(screen.getByRole('status')).toHaveTextContent('1 harita kısayolu bulundu.');
  });

  it('finds key labels through the shortcut search', () => {
    renderOpenHelp();
    fireEvent.change(getShortcutSearch(), { target: { value: 'Ctrl+K' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option')).toHaveTextContent('Komut merkezini aç');
  });

  it('filters to the tools category with accessible collection metadata', () => {
    renderOpenHelp();
    fireEvent.click(screen.getByRole('button', { name: 'Harita araçları' }));
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute('aria-posinset', '1');
    expect(options[2]).toHaveAttribute('aria-posinset', '3');
    expect(options[2]).toHaveAttribute('aria-setsize', '3');
    expect(screen.getByRole('button', { name: 'Harita araçları' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('composes shortcut category and query filtering', () => {
    renderOpenHelp();
    fireEvent.click(screen.getByRole('button', { name: 'Çalışma alanı' }));
    fireEvent.change(getShortcutSearch(), { target: { value: 'komut' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option')).toHaveTextContent('Komut merkezini aç');
  });

  it('shows a useful shortcut empty state', () => {
    renderOpenHelp();
    fireEvent.change(getShortcutSearch(), { target: { value: 'uydu yörünge' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('Eşleşme bulunamadı')).toBeInTheDocument();
    expect(screen.getByText(/Arama ifadesini kısaltın/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Filtrelerle eşleşen harita kısayolu bulunamadı.');
    expect(getShortcutSearch()).not.toHaveAttribute('aria-activedescendant');
  });

  it('clears shortcut query without resetting category', () => {
    renderOpenHelp();
    fireEvent.click(screen.getByRole('button', { name: 'Harita araçları' }));
    fireEvent.change(getShortcutSearch(), { target: { value: 'ölçüm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kısayol aramasını temizle' }));
    expect(getShortcutSearch()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Harita araçları' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('resets shortcut query and category from empty-state recovery', () => {
    renderOpenHelp();
    fireEvent.click(screen.getByRole('button', { name: 'Harita araçları' }));
    fireEvent.change(getShortcutSearch(), { target: { value: 'yok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tüm kısayolları göster' }));
    expect(getShortcutSearch()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Tümü' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('option')).toHaveLength(7);
  });

  it('moves shortcut active descendant without moving input focus', () => {
    renderOpenHelp();
    const search = getShortcutSearch();
    search.focus();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-focus-navigation');
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-focus-map');
  });

  it('supports Home End PageDown and PageUp on shortcut search', () => {
    renderOpenHelp();
    const search = getShortcutSearch();
    fireEvent.keyDown(search, { key: 'End' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-feedback');
    fireEvent.keyDown(search, { key: 'Home' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-focus-map');
    fireEvent.keyDown(search, { key: 'PageDown' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-measurement');
    fireEvent.keyDown(search, { key: 'PageUp' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-focus-map');
  });

  it('prevents browser default for active-descendant navigation keys', () => {
    renderOpenHelp();
    const search = getShortcutSearch();
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    fireEvent(search, event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('allows pointer exploration without stealing shortcut search focus', () => {
    renderOpenHelp();
    const search = getShortcutSearch();
    search.focus();
    const feedback = screen.getByRole('option', { name: /Geri bildirim penceresini aç/i });
    fireEvent.mouseMove(feedback);
    expect(search).toHaveAttribute('aria-activedescendant', 'map-shortcut-help-option-feedback');
    fireEvent.mouseDown(feedback);
    expect(document.activeElement).toBe(search);
  });

  it('keeps shortcut and guide state isolated when switching tabs', () => {
    renderOpenHelp();
    fireEvent.change(getShortcutSearch(), { target: { value: 'ölçüm' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(getGuideTab());
    const guideSearch = screen.getByRole('combobox', { name: /çalışma alanı rehberinde ara/i });
    fireEvent.change(guideSearch, { target: { value: 'offline' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(getShortcutTab());
    expect(getShortcutSearch()).toHaveValue('ölçüm');
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('resets shortcut discovery and tab selection after close and reopen', () => {
    const onClose = vi.fn();
    const { rerender } = render(<MapWorkspaceShortcutHelp open onClose={onClose} />);
    fireEvent.change(getShortcutSearch(), { target: { value: 'ölçüm' } });
    fireEvent.click(getGuideTab());
    rerender(<MapWorkspaceShortcutHelp open={false} onClose={onClose} />);
    rerender(<MapWorkspaceShortcutHelp open onClose={onClose} />);
    expect(getShortcutTab()).toHaveAttribute('aria-selected', 'true');
    expect(getShortcutSearch()).toHaveValue('');
    expect(screen.getAllByRole('option')).toHaveLength(7);
  });

  it('closes from explicit close and done controls', () => {
    const { onClose } = renderOpenHelp();
    fireEvent.click(screen.getByRole('button', { name: 'Harita yardımını kapat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tamam' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes only when the backdrop itself receives mouse down', () => {
    const { onClose } = renderOpenHelp();
    const backdrop = screen.getByRole('dialog').parentElement;
    expect(backdrop).not.toBeNull();
    fireEvent.mouseDown(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
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

  it('opens and closes the help center from the launcher button', () => {
    render(<MapWorkspaceShortcutHelpLauncher />);
    const launcher = screen.getByRole('button', { name: 'Kısayollar' });
    expect(launcher).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(launcher);
    expect(launcher).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'Harita çalışma alanı yardımı' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tamam' }));
    expect(launcher).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens on governed Shift+? using an act-wrapped testing-library event', () => {
    render(<MapWorkspaceShortcutHelpLauncher />);
    fireEvent.keyDown(window, { key: '?', code: 'Slash', shiftKey: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not open from plain question-mark input', () => {
    render(<MapWorkspaceShortcutHelpLauncher />);
    fireEvent.keyDown(window, { key: '?', code: 'Slash' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not open while a text input owns the shortcut event', () => {
    render(<><input aria-label="Metin" /><MapWorkspaceShortcutHelpLauncher /></>);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Metin' }), { key: '?', code: 'Slash', shiftKey: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
