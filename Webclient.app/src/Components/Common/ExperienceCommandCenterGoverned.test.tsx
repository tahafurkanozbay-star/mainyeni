import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExperienceCommandCenterGoverned,
  GOVERNED_EXPERIENCE_COMMANDS,
  toCommandCenterItem,
} from './ExperienceCommandCenterGoverned';

const openCommandCenter = (): void => {
  window.dispatchEvent(new CustomEvent('kentrehberi:command', {
    detail: { name: 'command-palette' },
  }));
};

const renderCenter = () => {
  const ShowWindow = vi.fn();
  const view = render(<ExperienceCommandCenterGoverned windowManager={{ ShowWindow }} />);
  return { ...view, ShowWindow };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExperienceCommandCenterGoverned', () => {
  it('adapts every command to the bounded interaction-model contract', () => {
    const items = GOVERNED_EXPERIENCE_COMMANDS.map(toCommandCenterItem);
    expect(items).toHaveLength(GOVERNED_EXPERIENCE_COMMANDS.length);
    expect(items[0]).toMatchObject({
      id: 'search',
      group: 'Arama',
      label: 'Genel arama',
      disabled: undefined,
    });
    expect(items.every((item) => item.searchText.includes(item.label))).toBe(true);
  });

  it('stays absent until the canonical command event opens it', () => {
    renderCenter();
    expect(screen.queryByRole('dialog', { name: 'Kent Rehberi Komut Merkezi' })).not.toBeInTheDocument();
    openCommandCenter();
    expect(screen.getByRole('dialog', { name: 'Kent Rehberi Komut Merkezi' })).toBeInTheDocument();
  });

  it('resets to a bounded initial state on each open', () => {
    renderCenter();
    openCommandCenter();
    const input = screen.getByRole('textbox', { name: 'Komut veya kent hizmeti ara' });
    fireEvent.change(input, { target: { value: 'ölçüm' } });
    expect(input).toHaveValue('ölçüm');
    fireEvent.click(screen.getByRole('button', { name: 'Komut merkezini kapat' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    openCommandCenter();
    expect(screen.getByRole('textbox', { name: 'Komut veya kent hizmeti ara' })).toHaveValue('');
  });

  it('uses Turkish-aware model search for the real command list', () => {
    renderCenter();
    openCommandCenter();
    const input = screen.getByRole('textbox', { name: 'Komut veya kent hizmeti ara' });
    fireEvent.change(input, { target: { value: 'ÖLÇÜM' } });
    expect(screen.getByRole('option', { name: /Ölçüm aracını aç/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Yer imlerini aç/i })).not.toBeInTheDocument();
  });

  it('announces query result counts through a polite atomic live region', () => {
    renderCenter();
    openCommandCenter();
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    const input = screen.getByRole('textbox', { name: 'Komut veya kent hizmeti ara' });
    fireEvent.change(input, { target: { value: 'ölçüm' } });
    expect(status).toHaveTextContent(/“ölçüm” için 1 sonuç bulundu/i);
  });

  it('announces a deterministic empty result without exposing stale options', () => {
    renderCenter();
    openCommandCenter();
    const input = screen.getByRole('textbox', { name: 'Komut veya kent hizmeti ara' });
    fireEvent.change(input, { target: { value: 'bulunmayacak-komut' } });
    expect(screen.getByRole('status')).toHaveTextContent(/sonuç bulunamadı/i);
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('Eşleşen komut bulunamadı')).toBeInTheDocument();
  });

  it('exposes active descendant from model identity rather than list index', () => {
    renderCenter();
    openCommandCenter();
    const input = screen.getByRole('textbox', { name: 'Komut veya kent hizmeti ara' });
    expect(input).toHaveAttribute('aria-activedescendant', 'kr-command-item-search');
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'kr-command-item-layers');
  });

  it('moves selection with ArrowDown and ArrowUp using deterministic wrapping', () => {
    renderCenter();
    openCommandCenter();
    const listbox = screen.getByRole('listbox', { name: 'Komut sonuçları' });
    const options = within(listbox).getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    const afterWrap = within(listbox).getAllByRole('option');
    expect(afterWrap.at(-1)).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(within(listbox).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('supports Home and End without depending on rendered DOM order state', () => {
    renderCenter();
    openCommandCenter();
    const input = screen.getByRole('textbox', { name: 'Komut veya kent hizmeti ara' });
    fireEvent.keyDown(window, { key: 'End' });
    expect(input.getAttribute('aria-activedescendant')).toContain('service-');
    fireEvent.keyDown(window, { key: 'Home' });
    expect(input).toHaveAttribute('aria-activedescendant', 'kr-command-item-search');
  });

  it('supports bounded page navigation in both directions', () => {
    renderCenter();
    openCommandCenter();
    const input = screen.getByRole('textbox', { name: 'Komut veya kent hizmeti ara' });
    fireEvent.keyDown(window, { key: 'PageDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'kr-command-item-sketch');
    fireEvent.keyDown(window, { key: 'PageUp' });
    expect(input).toHaveAttribute('aria-activedescendant', 'kr-command-item-search');
  });

  it('updates active identity from pointer hover without executing the command', () => {
    const { ShowWindow } = renderCenter();
    openCommandCenter();
    const bookmark = screen.getByRole('option', { name: /Yer imlerini aç/i });
    fireEvent.mouseEnter(bookmark);
    expect(bookmark).toHaveAttribute('aria-selected', 'true');
    expect(ShowWindow).not.toHaveBeenCalled();
  });

  it('executes a target command through WindowManager and closes the modal', () => {
    const { ShowWindow } = renderCenter();
    openCommandCenter();
    fireEvent.click(screen.getByRole('option', { name: /Ölçüm aracını aç/i }));
    expect(ShowWindow).toHaveBeenCalledTimes(1);
    expect(ShowWindow).toHaveBeenCalledWith('measurement-widget');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('executes the model active command with Enter from the search input', () => {
    const { ShowWindow } = renderCenter();
    openCommandCenter();
    const input = screen.getByRole('textbox', { name: 'Komut veya kent hizmeti ara' });
    fireEvent.change(input, { target: { value: 'yer imlerini' } });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(ShowWindow).toHaveBeenCalledWith('bookmark-widget');
  });

  it('dispatches canonical map commands without inventing a second transport', () => {
    renderCenter();
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command', listener);
    openCommandCenter();
    fireEvent.click(screen.getByRole('option', { name: /Katman yönetimini aç/i }));
    const commandEvents = listener.mock.calls
      .map(([event]) => event as CustomEvent<{ name?: string }>)
      .filter((event) => event.detail?.name === 'layers');
    expect(commandEvents).toHaveLength(1);
    window.removeEventListener('kentrehberi:command', listener);
  });

  it('publishes command-executed evidence after a successful local dispatch', () => {
    renderCenter();
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command-executed', listener);
    openCommandCenter();
    fireEvent.click(screen.getByRole('option', { name: /Lejandı aç/i }));
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]?.[0] as CustomEvent<{ name?: string }>;
    expect(event.detail.name).toBe('legend');
    window.removeEventListener('kentrehberi:command-executed', listener);
  });

  it('closes on backdrop pointer activation but not on dialog content pointer activation', () => {
    renderCenter();
    openCommandCenter();
    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const backdrop = dialog.parentElement;
    expect(backdrop).not.toBeNull();
    fireEvent.mouseDown(backdrop!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('provides listbox semantics and exactly one selected option while results exist', () => {
    renderCenter();
    openCommandCenter();
    const listbox = screen.getByRole('listbox', { name: 'Komut sonuçları' });
    const options = within(listbox).getAllByRole('option');
    expect(options.length).toBeGreaterThan(5);
    expect(options.filter((option) => option.getAttribute('aria-selected') === 'true')).toHaveLength(1);
  });

  it('keeps command descriptions visible in the option accessible name', () => {
    renderCenter();
    openCommandCenter();
    const option = screen.getByRole('option', { name: /Genel arama.*Adres, yer ve katmanlarda arayın/i });
    expect(option).toBeInTheDocument();
  });

  it('keeps the dialog labelled and described for screen-reader entry', () => {
    renderCenter();
    openCommandCenter();
    const dialog = screen.getByRole('dialog', { name: 'Kent Rehberi Komut Merkezi' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-describedby', 'kr-command-description');
    expect(screen.getByText('Harita araçları ve tüm kent servislerinde arama yapın.')).toBeInTheDocument();
  });

  it('does not open for unrelated command events', () => {
    renderCenter();
    window.dispatchEvent(new CustomEvent('kentrehberi:command', { detail: { name: 'layers' } }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('bounds oversized user query values through the interaction model', () => {
    renderCenter();
    openCommandCenter();
    const input = screen.getByRole('textbox', { name: 'Komut veya kent hizmeti ara' });
    fireEvent.change(input, { target: { value: 'x'.repeat(600) } });
    expect((input as HTMLInputElement).value.length).toBe(160);
  });
});
