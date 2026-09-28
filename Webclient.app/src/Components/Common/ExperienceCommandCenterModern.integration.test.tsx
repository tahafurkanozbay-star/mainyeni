import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  COMMAND_CENTER_CATALOG_REPORT,
  EXPERIENCE_COMMANDS,
  ExperienceCommandCenterModern,
  filterExperienceCommands,
  toCommandCenterItem,
} from './ExperienceCommandCenterModern';

const openCommandCenter = (): void => {
  window.dispatchEvent(new CustomEvent('kentrehberi:command', {
    detail: { name: 'command-palette' },
  }));
};

const renderCenter = () => {
  const ShowWindow = vi.fn();
  const view = render(<ExperienceCommandCenterModern windowManager={{ ShowWindow }} />);
  return { ...view, ShowWindow };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExperienceCommandCenterModern governed integration', () => {
  test('keeps the production catalog valid and bounded', () => {
    expect(COMMAND_CENTER_CATALOG_REPORT.valid).toBe(true);
    expect(COMMAND_CENTER_CATALOG_REPORT.commandCount).toBe(EXPERIENCE_COMMANDS.length);
    expect(COMMAND_CENTER_CATALOG_REPORT.enabledCount).toBe(EXPERIENCE_COMMANDS.length);
    expect(COMMAND_CENTER_CATALOG_REPORT.actionableCount).toBe(EXPERIENCE_COMMANDS.length);
    expect(COMMAND_CENTER_CATALOG_REPORT.issues.filter(issue => issue.severity === 'error')).toEqual([]);
  });

  test('adapts every production command to the interaction model contract', () => {
    const items = EXPERIENCE_COMMANDS.map(toCommandCenterItem);
    expect(items).toHaveLength(EXPERIENCE_COMMANDS.length);
    expect(items[0]).toMatchObject({
      id: 'search',
      group: 'Arama',
      label: 'Genel arama',
    });
    expect(items.every(item => item.searchText.includes(item.label))).toBe(true);
  });

  test('preserves the compatibility filter helper', () => {
    expect(filterExperienceCommands(EXPERIENCE_COMMANDS, 'kadin danisma')
      .map(command => command.label)).toContain('Kadın Danışma Merkezleri');
    expect(filterExperienceCommands(EXPERIENCE_COMMANDS, 'ölçüm alan')
      .map(command => command.id)).toContain('measure');
  });

  test('stays absent until the canonical command event opens it', () => {
    renderCenter();
    expect(screen.queryByRole('dialog', { name: 'Kent Rehberi Komut Merkezi' })).not.toBeInTheDocument();
    openCommandCenter();
    expect(screen.getByRole('dialog', { name: 'Kent Rehberi Komut Merkezi' })).toBeInTheDocument();
  });

  test('does not open for unrelated experience commands', () => {
    renderCenter();
    window.dispatchEvent(new CustomEvent('kentrehberi:command', { detail: { name: 'layers' } }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('resets query and scope on every open', () => {
    renderCenter();
    openCommandCenter();
    const input = screen.getByRole('combobox', { name: 'Komut veya kent hizmeti ara' });
    fireEvent.change(input, { target: { value: 'ölçüm' } });
    fireEvent.click(screen.getByRole('button', { name: /Hizmetler/i }));
    expect(input).toHaveValue('ölçüm');
    fireEvent.click(screen.getByRole('button', { name: 'Komut merkezini kapat' }));
    openCommandCenter();
    expect(screen.getByRole('combobox', { name: 'Komut veya kent hizmeti ara' })).toHaveValue('');
    expect(screen.getByRole('button', { name: /Tümü/i })).toHaveAttribute('aria-pressed', 'true');
  });

  test('exposes combobox/listbox ownership and active descendant', () => {
    renderCenter();
    openCommandCenter();
    const input = screen.getByRole('combobox', { name: 'Komut veya kent hizmeti ara' });
    const listbox = screen.getByRole('listbox', { name: 'Komut sonuçları' });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', listbox.id);
    expect(input).toHaveAttribute('aria-activedescendant', 'kr-command-item-search');
  });

  test('uses Turkish and accent tolerant model search in the real UI', () => {
    renderCenter();
    openCommandCenter();
    const input = screen.getByRole('combobox', { name: 'Komut veya kent hizmeti ara' });
    fireEvent.change(input, { target: { value: 'kadin danisma' } });
    expect(screen.getByRole('option', { name: /Kadın Danışma Merkezleri/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Yer imlerini aç/i })).not.toBeInTheDocument();
  });

  test('announces result count through an atomic polite region', () => {
    renderCenter();
    openCommandCenter();
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ölçüm' } });
    expect(status).toHaveTextContent(/1 sonuç bulundu/i);
  });

  test('announces empty results without leaving stale options', () => {
    renderCenter();
    openCommandCenter();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bulunmayacak-komut' } });
    expect(screen.getByRole('status')).toHaveTextContent(/sonuç bulunamadı/i);
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('Eşleşen komut bulunamadı')).toBeInTheDocument();
  });

  test('moves active identity with ArrowDown and ArrowUp', () => {
    renderCenter();
    openCommandCenter();
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'kr-command-item-layers');
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(input).toHaveAttribute('aria-activedescendant', 'kr-command-item-search');
  });

  test('wraps ArrowUp from first to the last command', () => {
    renderCenter();
    openCommandCenter();
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toContain('service-');
  });

  test('supports Home, End, PageUp and PageDown', () => {
    renderCenter();
    openCommandCenter();
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(window, { key: 'End' });
    expect(input.getAttribute('aria-activedescendant')).toContain('service-');
    fireEvent.keyDown(window, { key: 'Home' });
    expect(input).toHaveAttribute('aria-activedescendant', 'kr-command-item-search');
    fireEvent.keyDown(window, { key: 'PageDown' });
    expect(input).not.toHaveAttribute('aria-activedescendant', 'kr-command-item-search');
    fireEvent.keyDown(window, { key: 'PageUp' });
    expect(input).toHaveAttribute('aria-activedescendant', 'kr-command-item-search');
  });

  test('does not hijack modified navigation keys', () => {
    renderCenter();
    openCommandCenter();
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true });
    expect(input).toHaveAttribute('aria-activedescendant', 'kr-command-item-search');
  });

  test('bounds rendered options while retaining full aria set size', () => {
    renderCenter();
    openCommandCenter();
    const options = screen.getAllByRole('option');
    expect(options.length).toBeLessThan(EXPERIENCE_COMMANDS.length);
    expect(options.length).toBeLessThanOrEqual(20);
    expect(options[0]).toHaveAttribute('aria-posinset', '1');
    expect(options[0]).toHaveAttribute('aria-setsize', String(EXPERIENCE_COMMANDS.length));
    expect(screen.getByText(/sonraki sonuç/)).toBeInTheDocument();
  });

  test('moves the bounded render window when End activates a distant command', () => {
    renderCenter();
    openCommandCenter();
    fireEvent.keyDown(window, { key: 'End' });
    const selected = screen.getAllByRole('option').filter(option => option.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(Number(selected[0]?.getAttribute('aria-posinset'))).toBe(EXPERIENCE_COMMANDS.length);
    expect(screen.getByText(/önceki sonuç/)).toBeInTheDocument();
  });

  test('filters to the analysis scope and preserves query interaction', () => {
    renderCenter();
    openCommandCenter();
    fireEvent.click(screen.getByRole('button', { name: /Analiz/i }));
    expect(screen.getByRole('button', { name: /Analiz/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('option', { name: /Ölçüm aracını aç/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Genel arama/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'çizim' } });
    expect(screen.getByRole('option', { name: /Çizim aracını aç/i })).toBeInTheDocument();
  });

  test('filters to city services without changing the transport contract', () => {
    renderCenter();
    openCommandCenter();
    fireEvent.click(screen.getByRole('button', { name: /Hizmetler/i }));
    expect(screen.queryByRole('option', { name: /Ölçüm aracını aç/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('option').every(option => option.id.includes('service-'))).toBe(true);
  });

  test('returns to all scope with catalog counts intact', () => {
    renderCenter();
    openCommandCenter();
    fireEvent.click(screen.getByRole('button', { name: /Yardım/i }));
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Tümü/i }));
    expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
  });

  test('updates active identity from pointer hover without executing', () => {
    const { ShowWindow } = renderCenter();
    openCommandCenter();
    const bookmark = screen.getByRole('option', { name: /Yer imlerini aç/i });
    fireEvent.mouseEnter(bookmark);
    expect(bookmark).toHaveAttribute('aria-selected', 'true');
    expect(ShowWindow).not.toHaveBeenCalled();
  });

  test('executes target command through WindowManager and closes', () => {
    const { ShowWindow } = renderCenter();
    openCommandCenter();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ölçüm' } });
    fireEvent.click(screen.getByRole('option', { name: /Ölçüm aracını aç/i }));
    expect(ShowWindow).toHaveBeenCalledWith('measurement-widget');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('executes the active command with Enter', () => {
    const { ShowWindow } = renderCenter();
    openCommandCenter();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'yer imlerini' } });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(ShowWindow).toHaveBeenCalledWith('bookmark-widget');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('dispatches canonical map events without a second transport', () => {
    renderCenter();
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command', listener);
    openCommandCenter();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'katman yönetimi' } });
    fireEvent.click(screen.getByRole('option', { name: /Katman yönetimini aç/i }));
    const events = listener.mock.calls
      .map(([event]) => event as CustomEvent<{ name?: string }>)
      .filter(event => event.detail?.name === 'layers');
    expect(events).toHaveLength(1);
    window.removeEventListener('kentrehberi:command', listener);
  });

  test('publishes command-executed evidence after local dispatch', () => {
    renderCenter();
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command-executed', listener);
    openCommandCenter();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'lejandı' } });
    fireEvent.click(screen.getByRole('option', { name: /Lejandı aç/i }));
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]?.[0] as CustomEvent<{ name?: string }>;
    expect(event.detail.name).toBe('legend');
    window.removeEventListener('kentrehberi:command-executed', listener);
  });

  test('promotes a previously executed command on the next open without persistence', () => {
    const { ShowWindow } = renderCenter();
    openCommandCenter();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ölçüm' } });
    fireEvent.click(screen.getByRole('option', { name: /Ölçüm aracını aç/i }));
    expect(ShowWindow).toHaveBeenCalledWith('measurement-widget');
    openCommandCenter();
    expect(screen.getAllByRole('option')[0]).toHaveAccessibleName(/Ölçüm aracını aç/i);
    expect(screen.getByText(/Son: Ölçüm aracını aç/)).toBeInTheDocument();
  });

  test('keeps usage history session-local after component remount', () => {
    const first = renderCenter();
    openCommandCenter();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ölçüm' } });
    fireEvent.click(screen.getByRole('option', { name: /Ölçüm aracını aç/i }));
    first.unmount();

    renderCenter();
    openCommandCenter();
    expect(screen.getByText('Oturum geçmişi boş')).toBeInTheDocument();
    expect(screen.getAllByRole('option')[0]).toHaveAccessibleName(/Genel arama/i);
  });

  test('closes on backdrop activation but not dialog content activation', () => {
    renderCenter();
    openCommandCenter();
    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const backdrop = dialog.parentElement as HTMLElement;
    fireEvent.mouseDown(backdrop);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('closes on Escape through the shared keyboard authority', () => {
    renderCenter();
    openCommandCenter();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('keeps dialog label and description for screen-reader entry', () => {
    renderCenter();
    openCommandCenter();
    const dialog = screen.getByRole('dialog', { name: 'Kent Rehberi Komut Merkezi' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-describedby', 'kr-command-description');
    expect(screen.getByText('Harita araçları ve tüm kent servislerinde arama yapın.')).toBeInTheDocument();
  });

  test('bounds oversized user query values through the model', () => {
    renderCenter();
    openCommandCenter();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'x'.repeat(600) } });
    expect((input as HTMLInputElement).value.length).toBe(160);
  });

  test('scope controls expose pressed state and count text', () => {
    renderCenter();
    openCommandCenter();
    const nav = screen.getByRole('navigation', { name: 'Komut kapsamı' });
    const buttons = within(nav).getAllByRole('button');
    expect(buttons).toHaveLength(5);
    expect(within(nav).getByRole('button', { name: /Tümü/i })).toHaveAttribute('aria-pressed', 'true');
    expect(nav.textContent).toContain(String(EXPERIENCE_COMMANDS.length));
  });
});