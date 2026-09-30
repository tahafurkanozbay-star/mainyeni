import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MapWorkspaceShortcutHelp } from './MapWorkspaceShortcutHelp';

vi.mock('./mapWorkspaceDialogRuntime', () => ({
  createMapWorkspaceDialogSession: vi.fn(() => ({
    focusInitial: vi.fn(),
    handleKeyDown: vi.fn(),
    dispose: vi.fn(),
  })),
}));

const renderHelp = () => render(<MapWorkspaceShortcutHelp open onClose={vi.fn()} />);

describe('Map workspace help accessibility contract', () => {
  it('exposes one modal with a labelled tablist', () => {
    renderHelp();
    const dialog = screen.getByRole('dialog', { name: 'Harita çalışma alanı yardımı' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const tablist = within(dialog).getByRole('tablist', { name: 'Harita yardım bölümleri' });
    expect(within(tablist).getAllByRole('tab')).toHaveLength(2);
  });

  it('keeps exactly one tab in the tab order', () => {
    renderHelp();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.filter((tab) => tab.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(tabs.filter((tab) => tab.getAttribute('tabindex') === '-1')).toHaveLength(1);
  });

  it('connects each tab to a real tabpanel', () => {
    renderHelp();
    for (const tab of screen.getAllByRole('tab')) {
      const controls = tab.getAttribute('aria-controls');
      expect(controls).toBeTruthy();
      expect(document.getElementById(controls!)).not.toBeNull();
    }
  });

  it('keeps inactive tabpanel content hidden from role queries', () => {
    renderHelp();
    expect(screen.queryByRole('combobox', { name: /çalışma alanı rehberinde ara/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Çalışma rehberi/i }));
    expect(screen.queryByRole('combobox', { name: /kısayol ara/i })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /çalışma alanı rehberinde ara/i })).toBeInTheDocument();
  });

  it('connects shortcut combobox active descendant to a rendered option', () => {
    renderHelp();
    const search = screen.getByRole('combobox', { name: /kısayol ara/i });
    const activeId = search.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    expect(document.getElementById(activeId!)).toHaveAttribute('role', 'option');
  });

  it('removes active descendant when shortcut results are empty', () => {
    renderHelp();
    const search = screen.getByRole('combobox', { name: /kısayol ara/i });
    fireEvent.change(search, { target: { value: 'eşleşmeyen ifade 12345' } });
    expect(search).not.toHaveAttribute('aria-activedescendant');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('connects guide combobox active descendant to a rendered option', () => {
    renderHelp();
    fireEvent.click(screen.getByRole('tab', { name: /Çalışma rehberi/i }));
    const search = screen.getByRole('combobox', { name: /çalışma alanı rehberinde ara/i });
    const activeId = search.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    expect(document.getElementById(activeId!)).toHaveAttribute('role', 'option');
  });

  it('publishes collection position metadata for shortcut results', () => {
    renderHelp();
    const options = screen.getAllByRole('option');
    options.forEach((option, index) => {
      expect(option).toHaveAttribute('aria-posinset', String(index + 1));
      expect(option).toHaveAttribute('aria-setsize', String(options.length));
    });
  });

  it('publishes collection position metadata for guide results', () => {
    renderHelp();
    fireEvent.click(screen.getByRole('tab', { name: /Çalışma rehberi/i }));
    const options = screen.getAllByRole('option');
    options.forEach((option, index) => {
      expect(option).toHaveAttribute('aria-posinset', String(index + 1));
      expect(option).toHaveAttribute('aria-setsize', String(options.length));
    });
  });

  it('keeps result announcements in polite status regions', () => {
    renderHelp();
    const shortcutStatus = screen.getByRole('status');
    expect(shortcutStatus).toHaveAttribute('aria-live', 'polite');
    expect(shortcutStatus).toHaveAttribute('aria-atomic', 'true');
    fireEvent.click(screen.getByRole('tab', { name: /Çalışma rehberi/i }));
    const guideStatus = screen.getByRole('status');
    expect(guideStatus).toHaveAttribute('aria-live', 'polite');
    expect(guideStatus).toHaveTextContent(/çalışma alanı rehberi gösteriliyor/i);
  });

  it('keeps visual result counters out of duplicate screen-reader speech', () => {
    renderHelp();
    expect(screen.getByText('7/7')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(screen.getByRole('tab', { name: /Çalışma rehberi/i }));
    expect(screen.getByText('16/16')).toHaveAttribute('aria-hidden', 'true');
  });

  it('uses button semantics for every category filter', () => {
    renderHelp();
    const shortcutFilters = screen.getByRole('group', { name: 'Kısayol kategorileri' });
    expect(within(shortcutFilters).getAllByRole('button')).toHaveLength(4);
    fireEvent.click(screen.getByRole('tab', { name: /Çalışma rehberi/i }));
    const guideFilters = screen.getByRole('group', { name: 'Rehber kategorileri' });
    expect(within(guideFilters).getAllByRole('button')).toHaveLength(6);
  });

  it('keeps exactly one pressed category in each active discovery surface', () => {
    renderHelp();
    const shortcutFilters = screen.getByRole('group', { name: 'Kısayol kategorileri' });
    expect(within(shortcutFilters).getAllByRole('button').filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    fireEvent.click(screen.getByRole('tab', { name: /Çalışma rehberi/i }));
    const guideFilters = screen.getByRole('group', { name: 'Rehber kategorileri' });
    expect(within(guideFilters).getAllByRole('button').filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
  });

  it('preserves tab semantics after repeated keyboard switching', () => {
    renderHelp();
    const shortcuts = screen.getByRole('tab', { name: /Kısayollar/i });
    fireEvent.keyDown(shortcuts, { key: 'ArrowRight' });
    const guide = screen.getByRole('tab', { name: /Çalışma rehberi/i });
    expect(guide).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(guide, { key: 'ArrowRight' });
    expect(shortcuts).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('tab').filter((tab) => tab.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('keeps explicit button types to prevent accidental form submission', () => {
    renderHelp();
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAttribute('type', 'button');
    }
  });
});
