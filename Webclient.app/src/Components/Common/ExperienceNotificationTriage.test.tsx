import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationCenterModel } from '../../experience/notificationCenterModel';
import { ExperienceNotificationTriage } from './ExperienceNotificationTriage';

const mocks = vi.hoisted(() => ({
  captureError: vi.fn(),
}));

vi.mock('../../platform/runtime/runtimeDiagnostics', () => ({
  runtimeDiagnostics: {
    captureError: mocks.captureError,
  },
}));

const createModel = (): NotificationCenterModel => {
  let now = 1_000;
  return new NotificationCenterModel({ now: () => ++now });
};

const pushStandardItems = (model: NotificationCenterModel): void => {
  model.push({
    id: 'layer-ready',
    title: 'Katman hazır',
    message: 'Plan katmanı haritaya eklendi.',
    tone: 'success',
    category: 'Katmanlar',
    createdAt: 1_001,
  });
  model.push({
    id: 'query-warning',
    title: 'Sorgu sınırlandı',
    message: 'İlk 500 kayıt gösteriliyor.',
    tone: 'warning',
    category: 'Sorgu',
    createdAt: 1_002,
  });
  model.push({
    id: 'network-error',
    title: 'Bağlantı kesildi',
    message: 'Harita servisine ulaşılamıyor.',
    tone: 'error',
    priority: 'urgent',
    category: 'Bağlantı',
    dismissible: false,
    createdAt: 1_003,
  });
};

const renderTriage = (
  model = createModel(),
  props: Partial<ComponentProps<typeof ExperienceNotificationTriage>> = {},
) => {
  const result = render(<ExperienceNotificationTriage model={model} {...props} />);
  return { ...result, model };
};

const openPanel = (): HTMLElement => {
  const trigger = screen.getByRole('button', { name: /okunmamış/i });
  fireEvent.click(trigger);
  const panel = document.getElementById('experience-notification-triage-panel');
  if (!(panel instanceof HTMLElement)) throw new Error('Expected notification triage panel');
  return panel;
};

const getListbox = (panel: HTMLElement): HTMLElement =>
  within(panel).getByRole('listbox', { name: 'Hızlı bildirim listesi' });

const getSelectedOption = (panel: HTMLElement): HTMLElement => {
  const option = within(getListbox(panel)).getAllByRole('option')
    .find((candidate) => candidate.getAttribute('aria-selected') === 'true');
  if (!option) throw new Error('Expected one selected notification option');
  return option;
};

beforeAll(() => {
  if (!globalThis.CSS) {
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { escape: (value: string) => value },
    });
  } else if (typeof globalThis.CSS.escape !== 'function') {
    Object.defineProperty(globalThis.CSS, 'escape', {
      configurable: true,
      value: (value: string) => value,
    });
  }
  if (typeof HTMLElement.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  }
});

describe('ExperienceNotificationTriage', () => {
  beforeEach(() => {
    mocks.captureError.mockReset();
  });

  it('does not add page chrome when there is nothing requiring attention', () => {
    renderTriage();
    expect(screen.queryByLabelText('Bildirim hızlı işlemleri')).not.toBeInTheDocument();
  });

  it('surfaces a compact unread summary without immediately opening the panel', () => {
    const model = createModel();
    model.push({ id: 'a', title: 'Yeni bildirim' });
    renderTriage(model);
    const region = screen.getByLabelText('Bildirim hızlı işlemleri');
    expect(region).toHaveAttribute('data-expanded', 'false');
    expect(screen.getByRole('button', { name: /1 okunmamış/i })).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('experience-notification-triage-panel')).not.toBeInTheDocument();
  });

  it('marks the attention surface when important notifications exist', () => {
    const model = createModel();
    model.push({ id: 'error', title: 'Hata', tone: 'error' });
    renderTriage(model);
    expect(screen.getByLabelText('Bildirim hızlı işlemleri')).toHaveAttribute('data-has-important', 'true');
    expect(screen.getByText('1 önemli')).toBeInTheDocument();
  });

  it('opens a quick panel with live metrics and scoped controls', () => {
    const model = createModel();
    pushStandardItems(model);
    renderTriage(model);
    const panel = openPanel();
    expect(within(panel).getByRole('heading', { name: 'Bildirimler' })).toBeInTheDocument();
    const metrics = within(panel).getByLabelText('Bildirim özeti');
    expect(metrics).toHaveTextContent('3 toplam');
    expect(metrics).toHaveTextContent('3 okunmamış');
    expect(metrics).toHaveTextContent('1 acil');
    expect(metrics).toHaveTextContent('2 önemli');
    expect(within(panel).getByRole('button', { name: 'Tüm bildirimler' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders canonical notification content without copying it into a second store', () => {
    const model = createModel();
    pushStandardItems(model);
    renderTriage(model);
    const panel = openPanel();
    expect(within(panel).getByText('Katman hazır')).toBeInTheDocument();
    expect(within(panel).getByText('Plan katmanı haritaya eklendi.')).toBeInTheDocument();
    expect(within(panel).getByText('Sorgu sınırlandı')).toBeInTheDocument();
    expect(within(panel).getByText('Bağlantı kesildi')).toBeInTheDocument();
  });

  it('updates when the canonical model receives a notification after render', () => {
    const model = createModel();
    model.push({ id: 'a', title: 'Bir', createdAt: 1_001 });
    renderTriage(model);
    const panel = openPanel();
    expect(within(panel).getByText('Bir')).toBeInTheDocument();
    act(() => {
      model.push({ id: 'b', title: 'İki', createdAt: 1_002 });
    });
    expect(within(panel).getByText('İki')).toBeInTheDocument();
    expect(screen.getByText('2 okunmamış')).toBeInTheDocument();
  });

  it('filters unread notifications through the quick-scope control', () => {
    const model = createModel();
    model.push({ id: 'read', title: 'Okunmuş', createdAt: 1_001 });
    model.markRead('read');
    model.push({ id: 'unread', title: 'Okunmamış kayıt', createdAt: 1_002 });
    renderTriage(model);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Okunmamış bildirimler' }));
    expect(within(panel).queryByText('Okunmuş')).not.toBeInTheDocument();
    expect(within(panel).getByText('Okunmamış kayıt')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Okunmamış bildirimler' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('filters important notifications using the model importance contract', () => {
    const model = createModel();
    pushStandardItems(model);
    renderTriage(model);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Önemli bildirimler' }));
    expect(within(panel).queryByText('Katman hazır')).not.toBeInTheDocument();
    expect(within(panel).getByText('Sorgu sınırlandı')).toBeInTheDocument();
    expect(within(panel).getByText('Bağlantı kesildi')).toBeInTheDocument();
  });

  it('offers a recovery action when the selected scope is empty', () => {
    const model = createModel();
    model.push({ id: 'normal', title: 'Normal' });
    renderTriage(model);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Önemli bildirimler' }));
    expect(within(panel).getByText('Eşleşen bildirim yok')).toBeInTheDocument();
    expect(within(panel).getByText('Başka bir bildirim filtresi seçin.')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Filtreleri ve aramayı sıfırla' }));
    expect(within(panel).getByText('Normal')).toBeInTheDocument();
  });

  it('searches title, message and category using the canonical triage model', () => {
    const model = createModel();
    pushStandardItems(model);
    renderTriage(model);
    const panel = openPanel();
    const search = within(panel).getByRole('searchbox', { name: 'Bildirim ara' });
    fireEvent.change(search, { target: { value: 'plan katmanı' } });
    expect(within(panel).getByText('Katman hazır')).toBeInTheDocument();
    expect(within(panel).queryByText('Sorgu sınırlandı')).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Bildirim aramasını temizle' }));
    expect(search).toHaveValue('');
  });

  it('changes result ordering through the sort control', () => {
    const model = createModel();
    model.push({ id: 'old', title: 'Eski', createdAt: 10 });
    model.push({ id: 'new', title: 'Yeni', createdAt: 20 });
    renderTriage(model);
    const panel = openPanel();
    expect(getSelectedOption(panel)).toHaveTextContent('Yeni');
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Sıralama' }), { target: { value: 'oldest' } });
    expect(getSelectedOption(panel)).toHaveTextContent('Eski');
  });

  it('uses one listbox tab stop with an active descendant', () => {
    const model = createModel();
    pushStandardItems(model);
    renderTriage(model);
    const panel = openPanel();
    const listbox = getListbox(panel);
    expect(listbox).toHaveAttribute('tabindex', '0');
    expect(listbox).toHaveAttribute('aria-activedescendant');
    expect(within(listbox).getAllByRole('option')).toHaveLength(3);
    expect(getSelectedOption(panel)).toHaveAttribute('aria-selected', 'true');
  });

  it('moves active-descendant navigation with J and K while retaining listbox focus', () => {
    const model = createModel();
    pushStandardItems(model);
    renderTriage(model);
    const panel = openPanel();
    const listbox = getListbox(panel);
    listbox.focus();
    const initial = listbox.getAttribute('aria-activedescendant');
    fireEvent.keyDown(listbox, { key: 'j' });
    expect(listbox.getAttribute('aria-activedescendant')).not.toBe(initial);
    expect(document.activeElement).toBe(listbox);
    fireEvent.keyDown(listbox, { key: 'k' });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(initial);
  });

  it('supports first and last navigation keys', () => {
    const model = createModel();
    pushStandardItems(model);
    renderTriage(model);
    const panel = openPanel();
    const listbox = getListbox(panel);
    const first = listbox.getAttribute('aria-activedescendant');
    fireEvent.keyDown(listbox, { key: 'End' });
    const last = listbox.getAttribute('aria-activedescendant');
    expect(last).not.toBe(first);
    fireEvent.keyDown(listbox, { key: 'Home' });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(first);
  });

  it('marks the deterministic active notification read with Enter', () => {
    const model = createModel();
    model.push({ id: 'a', title: 'A', createdAt: 10 });
    model.push({ id: 'b', title: 'B', createdAt: 20 });
    renderTriage(model);
    const panel = openPanel();
    const listbox = getListbox(panel);
    expect(getSelectedOption(panel)).toHaveTextContent('B');
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(model.snapshot().items.find((candidate) => candidate.id === 'b')?.read).toBe(true);
  });

  it('marks all notifications read with Shift+A and keeps spaced metrics readable', () => {
    const model = createModel();
    pushStandardItems(model);
    renderTriage(model);
    const panel = openPanel();
    fireEvent.keyDown(getListbox(panel), { key: 'A', shiftKey: true });
    expect(model.snapshot().unreadCount).toBe(0);
    expect(within(panel).getByLabelText('Bildirim özeti')).toHaveTextContent('0 okunmamış');
  });

  it('clears read dismissible notifications with Shift+C', () => {
    const model = createModel();
    model.push({ id: 'read', title: 'Okunan', createdAt: 10 });
    model.markRead('read');
    model.push({ id: 'unread', title: 'Yeni', createdAt: 20 });
    renderTriage(model);
    const panel = openPanel();
    fireEvent.keyDown(getListbox(panel), { key: 'C', shiftKey: true });
    expect(model.snapshot().items.map((candidate) => candidate.id)).toEqual(['unread']);
  });

  it('dismisses the explicitly selected dismissible notification with Delete', () => {
    const model = createModel();
    model.push({ id: 'keep', title: 'Kalsın', createdAt: 10 });
    model.push({ id: 'dismiss', title: 'Kaldırılabilir', createdAt: 20 });
    renderTriage(model);
    const panel = openPanel();
    const dismissOption = within(getListbox(panel)).getByRole('option', { name: /Kaldırılabilir/i });
    fireEvent.mouseDown(dismissOption);
    expect(dismissOption).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(getListbox(panel), { key: 'Delete' });
    expect(model.snapshot().items.some((candidate) => candidate.id === 'dismiss')).toBe(false);
    expect(model.snapshot().items.some((candidate) => candidate.id === 'keep')).toBe(true);
  });

  it('does not dismiss protected notifications', () => {
    const model = createModel();
    model.push({ id: 'protected', title: 'Korunan', dismissible: false });
    renderTriage(model);
    const panel = openPanel();
    fireEvent.keyDown(getListbox(panel), { key: 'Delete' });
    expect(model.snapshot().items).toHaveLength(1);
    expect(within(panel).queryByRole('button', { name: /Korunan: bildirimi kaldır/i })).not.toBeInTheDocument();
  });

  it('marks an item read from its explicit touch-friendly action', () => {
    const model = createModel();
    model.push({ id: 'a', title: 'Dokunma hedefi' });
    renderTriage(model);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Dokunma hedefi: okundu olarak işaretle' }));
    expect(model.snapshot().items[0]?.read).toBe(true);
    expect(within(panel).getByText('Okundu')).toBeInTheDocument();
  });

  it('dismisses an item from its explicit action', () => {
    const model = createModel();
    model.push({ id: 'a', title: 'Kaldır beni', createdAt: 20 });
    model.push({ id: 'b', title: 'Kal', createdAt: 10 });
    renderTriage(model);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Kaldır beni: bildirimi kaldır' }));
    expect(model.snapshot().items.map((candidate) => candidate.id)).toEqual(['b']);
  });

  it('executes bulk controls through canonical model capabilities', () => {
    const model = createModel();
    model.push({ id: 'a', title: 'A' });
    model.push({ id: 'b', title: 'B' });
    renderTriage(model);
    const panel = openPanel();
    const markAll = within(panel).getByRole('button', { name: 'Tümünü okundu yap' });
    const clear = within(panel).getByRole('button', { name: 'Okunanları temizle' });
    expect(markAll).toBeEnabled();
    expect(clear).toBeDisabled();
    fireEvent.click(markAll);
    expect(markAll).toBeDisabled();
    expect(clear).toBeEnabled();
    fireEvent.click(clear);
    expect(model.snapshot().items).toHaveLength(0);
  });

  it('opens the full notification center through the canonical command event', () => {
    const model = createModel();
    model.push({ id: 'a', title: 'A' });
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command', listener);
    renderTriage(model);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Tam bildirim merkezini aç' }));
    expect(listener).toHaveBeenCalledTimes(1);
    const firstCall = listener.mock.calls[0];
    if (!firstCall) throw new Error('Expected kentrehberi:command event');
    expect((firstCall[0] as CustomEvent).detail).toEqual({ name: 'notifications', source: 'triage' });
    expect(document.getElementById('experience-notification-triage-panel')).not.toBeInTheDocument();
    window.removeEventListener('kentrehberi:command', listener);
  });

  it('uses a supplied center-opening callback when provided', () => {
    const model = createModel();
    model.push({ id: 'a', title: 'A' });
    const onOpenCenter = vi.fn();
    renderTriage(model, { onOpenCenter });
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Tam bildirim merkezini aç' }));
    expect(onOpenCenter).toHaveBeenCalledTimes(1);
  });

  it('captures callback failures instead of breaking the notification surface', () => {
    const model = createModel();
    model.push({ id: 'a', title: 'A' });
    renderTriage(model, { onOpenCenter: () => { throw new Error('boom'); } });
    const panel = openPanel();
    expect(() => fireEvent.click(within(panel).getByRole('button', { name: 'Tam bildirim merkezini aç' }))).not.toThrow();
    expect(mocks.captureError).toHaveBeenCalledTimes(1);
  });

  it('keeps command guidance discoverable and collapsed by default', () => {
    const model = createModel();
    model.push({ id: 'a', title: 'A' });
    renderTriage(model);
    const panel = openPanel();
    const summary = within(panel).getByText('Klavye komutları');
    const details = summary.closest('details');
    expect(details).toBeInstanceOf(HTMLDetailsElement);
    expect(details).not.toHaveAttribute('open');
    if (!(details instanceof HTMLDetailsElement)) throw new Error('Expected keyboard command details');
    expect(within(details).getByText('Sonraki eşleşme')).toBeInTheDocument();
    expect(within(details).getByText('↓ / J')).toBeInTheDocument();
    expect(within(details).getByText('Etkin bildirimi okundu yap')).toBeInTheDocument();
  });

  it('renders no more notification options than the configured preview budget', () => {
    const model = createModel();
    for (let index = 0; index < 9; index += 1) {
      model.push({
        id: `n-${index}`,
        title: `Bildirim ${index}`,
        createdAt: 1_000 + index,
      });
    }
    renderTriage(model, { previewLimit: 4 });
    const panel = openPanel();
    const listbox = getListbox(panel);
    expect(within(listbox).getAllByRole('option')).toHaveLength(4);
    expect(within(panel).getByRole('combobox', { name: 'Sıralama' })).toBeInTheDocument();
  });

  it('exposes deterministic semantic option ids for active-descendant navigation', () => {
    const model = createModel();
    model.push({ id: 'critical network', title: 'Ağ uyarısı', createdAt: 10 });
    renderTriage(model);
    const panel = openPanel();
    const listbox = getListbox(panel);
    expect(listbox).toHaveAttribute('aria-activedescendant', 'experience-notification-triage-critical-network');
    expect(within(listbox).getByRole('option')).toHaveAttribute('id', 'experience-notification-triage-critical-network');
  });

  it('advertises the full-center Alt+N shortcut on the explicit action', () => {
    const model = createModel();
    model.push({ id: 'a', title: 'A' });
    renderTriage(model);
    const panel = openPanel();
    expect(within(panel).getByRole('button', { name: 'Tam bildirim merkezini aç' })).toHaveAttribute('aria-keyshortcuts', 'Alt+N');
  });
});
