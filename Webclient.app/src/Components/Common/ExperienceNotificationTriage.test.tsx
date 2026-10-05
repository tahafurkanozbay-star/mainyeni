import { fireEvent, render, screen, within } from '@testing-library/react';
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

const pushStandardItems = (model: NotificationCenterModel): void => {
  model.push({
    id: 'layer-ready',
    title: 'Katman hazır',
    message: 'Plan katmanı haritaya eklendi.',
    tone: 'success',
    category: 'Katmanlar',
  });
  model.push({
    id: 'query-warning',
    title: 'Sorgu sınırlandı',
    message: 'İlk 500 kayıt gösteriliyor.',
    tone: 'warning',
    category: 'Sorgu',
  });
  model.push({
    id: 'network-error',
    title: 'Bağlantı kesildi',
    message: 'Harita servisine ulaşılamıyor.',
    tone: 'error',
    priority: 'urgent',
    category: 'Bağlantı',
    dismissible: false,
  });
};

const renderTriage = (model = new NotificationCenterModel(), props: Partial<React.ComponentProps<typeof ExperienceNotificationTriage>> = {}) => {
  const result = render(<ExperienceNotificationTriage model={model} {...props} />);
  return { ...result, model };
};

const openPanel = (): HTMLElement => {
  const trigger = screen.getByRole('button', { name: /okunmamış/i });
  fireEvent.click(trigger);
  return screen.getByRole('region', { name: 'Bildirim hızlı inceleme paneli' });
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
    const model = new NotificationCenterModel();
    model.push({ id: 'a', title: 'Yeni bildirim' });
    renderTriage(model);
    const region = screen.getByLabelText('Bildirim hızlı işlemleri');
    expect(region).toHaveAttribute('data-expanded', 'false');
    expect(screen.getByRole('button', { name: /1 okunmamış/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Bildirim hızlı inceleme paneli' })).not.toBeInTheDocument();
  });

  it('marks the attention surface when important notifications exist', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'error', title: 'Hata', tone: 'error' });
    renderTriage(model);
    expect(screen.getByLabelText('Bildirim hızlı işlemleri')).toHaveAttribute('data-has-important', 'true');
    expect(screen.getByText('1 önemli')).toBeInTheDocument();
  });

  it('opens a non-modal quick panel with live metrics and scoped controls', () => {
    const model = new NotificationCenterModel();
    pushStandardItems(model);
    renderTriage(model);
    const panel = openPanel();
    expect(within(panel).getByRole('heading', { name: 'Bildirimler' })).toBeInTheDocument();
    expect(within(panel).getByLabelText('Bildirim özeti')).toHaveTextContent('3toplam');
    expect(within(panel).getByLabelText('Bildirim özeti')).toHaveTextContent('3okunmamış');
    expect(within(panel).getByLabelText('Bildirim özeti')).toHaveTextContent('2önemli');
    expect(within(panel).getByRole('button', { name: 'Tüm bildirimler' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders canonical notification content without copying it into a second store', () => {
    const model = new NotificationCenterModel();
    pushStandardItems(model);
    renderTriage(model);
    const panel = openPanel();
    expect(within(panel).getByText('Katman hazır')).toBeInTheDocument();
    expect(within(panel).getByText('Plan katmanı haritaya eklendi.')).toBeInTheDocument();
    expect(within(panel).getByText('Sorgu sınırlandı')).toBeInTheDocument();
    expect(within(panel).getByText('Bağlantı kesildi')).toBeInTheDocument();
  });

  it('updates immediately when the canonical model receives a new notification', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'a', title: 'Bir' });
    renderTriage(model);
    openPanel();
    expect(screen.getByText('Bir')).toBeInTheDocument();
    model.push({ id: 'b', title: 'İki' });
    expect(screen.getByText('İki')).toBeInTheDocument();
    expect(screen.getByText('2 okunmamış')).toBeInTheDocument();
  });

  it('filters unread notifications through the quick-scope control', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'read', title: 'Okunmuş' });
    model.markRead('read');
    model.push({ id: 'unread', title: 'Okunmamış kayıt' });
    renderTriage(model);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Okunmamış bildirimler' }));
    expect(within(panel).queryByText('Okunmuş')).not.toBeInTheDocument();
    expect(within(panel).getByText('Okunmamış kayıt')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Okunmamış bildirimler' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('filters important notifications using the same importance contract as the model', () => {
    const model = new NotificationCenterModel();
    pushStandardItems(model);
    renderTriage(model);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Önemli bildirimler' }));
    expect(within(panel).queryByText('Katman hazır')).not.toBeInTheDocument();
    expect(within(panel).getByText('Sorgu sınırlandı')).toBeInTheDocument();
    expect(within(panel).getByText('Bağlantı kesildi')).toBeInTheDocument();
  });

  it('offers a recovery action when the selected scope is empty', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'normal', title: 'Normal' });
    renderTriage(model);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Önemli bildirimler' }));
    expect(within(panel).getByText('Bu filtrede bildirim yok')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Tüm bildirimleri göster' }));
    expect(within(panel).getByText('Normal')).toBeInTheDocument();
  });

  it('uses one listbox tab stop with an active descendant', () => {
    const model = new NotificationCenterModel();
    pushStandardItems(model);
    renderTriage(model);
    const panel = openPanel();
    const listbox = within(panel).getByRole('listbox', { name: 'Hızlı bildirim listesi' });
    expect(listbox).toHaveAttribute('tabindex', '0');
    expect(listbox).toHaveAttribute('aria-activedescendant');
    expect(within(listbox).getAllByRole('option')).toHaveLength(3);
    expect(within(listbox).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('moves active-descendant navigation with J and K while retaining the listbox focus model', () => {
    const model = new NotificationCenterModel();
    pushStandardItems(model);
    renderTriage(model);
    const panel = openPanel();
    const listbox = within(panel).getByRole('listbox');
    const initial = listbox.getAttribute('aria-activedescendant');
    fireEvent.keyDown(listbox, { key: 'j' });
    expect(listbox.getAttribute('aria-activedescendant')).not.toBe(initial);
    fireEvent.keyDown(listbox, { key: 'k' });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(initial);
  });

  it('supports first and last navigation keys', () => {
    const model = new NotificationCenterModel();
    pushStandardItems(model);
    renderTriage(model);
    const panel = openPanel();
    const listbox = within(panel).getByRole('listbox');
    const first = listbox.getAttribute('aria-activedescendant');
    fireEvent.keyDown(listbox, { key: 'End' });
    const last = listbox.getAttribute('aria-activedescendant');
    expect(last).not.toBe(first);
    fireEvent.keyDown(listbox, { key: 'Home' });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(first);
  });

  it('marks the active notification read with Enter', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'a', title: 'A' });
    model.push({ id: 'b', title: 'B' });
    renderTriage(model);
    const panel = openPanel();
    const listbox = within(panel).getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(model.snapshot().items.find((candidate) => candidate.id === 'b')?.read).toBe(true);
  });

  it('marks all notifications read with Shift+A', () => {
    const model = new NotificationCenterModel();
    pushStandardItems(model);
    renderTriage(model);
    const panel = openPanel();
    fireEvent.keyDown(within(panel).getByRole('listbox'), { key: 'A', shiftKey: true });
    expect(model.snapshot().unreadCount).toBe(0);
    expect(within(panel).getByLabelText('Bildirim özeti')).toHaveTextContent('0okunmamış');
  });

  it('clears read dismissible notifications with Shift+C', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'read', title: 'Okunan' });
    model.markRead('read');
    model.push({ id: 'unread', title: 'Yeni' });
    renderTriage(model);
    const panel = openPanel();
    fireEvent.keyDown(within(panel).getByRole('listbox'), { key: 'C', shiftKey: true });
    expect(model.snapshot().items.map((candidate) => candidate.id)).toEqual(['unread']);
  });

  it('dismisses an active dismissible notification with Delete', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'dismiss', title: 'Kaldırılabilir' });
    model.push({ id: 'keep', title: 'Kalsın' });
    renderTriage(model);
    const panel = openPanel();
    const listbox = within(panel).getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'End' });
    fireEvent.keyDown(listbox, { key: 'Delete' });
    expect(model.snapshot().items.some((candidate) => candidate.id === 'dismiss')).toBe(false);
  });

  it('does not dismiss protected notifications', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'protected', title: 'Korunan', dismissible: false });
    renderTriage(model);
    const panel = openPanel();
    fireEvent.keyDown(within(panel).getByRole('listbox'), { key: 'Delete' });
    expect(model.snapshot().items).toHaveLength(1);
    expect(within(panel).queryByRole('button', { name: /Korunan: bildirimi kaldır/i })).not.toBeInTheDocument();
  });

  it('marks an item read from its explicit touch-friendly action', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'a', title: 'Dokunma hedefi' });
    renderTriage(model);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Dokunma hedefi: okundu olarak işaretle' }));
    expect(model.snapshot().items[0]?.read).toBe(true);
    expect(within(panel).getByText('Okundu')).toBeInTheDocument();
  });

  it('dismisses an item from its explicit action', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'a', title: 'Kaldır beni' });
    model.push({ id: 'b', title: 'Kal' });
    renderTriage(model);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Kaldır beni: bildirimi kaldır' }));
    expect(model.snapshot().items.map((candidate) => candidate.id)).toEqual(['b']);
  });

  it('executes bulk controls without bypassing canonical model capabilities', () => {
    const model = new NotificationCenterModel();
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
    const model = new NotificationCenterModel();
    model.push({ id: 'a', title: 'A' });
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command', listener);
    renderTriage(model);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Tam bildirim merkezini aç' }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ name: 'notifications', source: 'triage' });
    expect(screen.queryByRole('region', { name: 'Bildirim hızlı inceleme paneli' })).not.toBeInTheDocument();
    window.removeEventListener('kentrehberi:command', listener);
  });

  it('uses a supplied center-opening callback when provided', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'a', title: 'A' });
    const onOpenCenter = vi.fn();
    renderTriage(model, { onOpenCenter });
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Tam bildirim merkezini aç' }));
    expect(onOpenCenter).toHaveBeenCalledTimes(1);
  });

  it('captures errors raised by a supplied open callback without breaking the surface', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'a', title: 'A' });
    renderTriage(model, { onOpenCenter: () => { throw new Error('open failed'); } });
    const panel = openPanel();
    expect(() => fireEvent.click(within(panel).getByRole('button', { name: 'Tam bildirim merkezini aç' }))).not.toThrow();
    expect(mocks.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      { source: 'experience.notification-triage.open-center' },
      'warn',
    );
  });

  it('closes the quick panel and restores the compact trigger', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'a', title: 'A' });
    renderTriage(model);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Hızlı bildirim panelini kapat' }));
    expect(screen.queryByRole('region', { name: 'Bildirim hızlı inceleme paneli' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1 okunmamış/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the panel mounted after marking all read so the user can clear read items', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'a', title: 'A' });
    renderTriage(model);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Tümünü okundu yap' }));
    expect(screen.getByRole('region', { name: 'Bildirim hızlı inceleme paneli' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Okunanları temizle' })).toBeEnabled();
  });

  it('renders no more than the configured preview budget', () => {
    const model = new NotificationCenterModel({ capacity: 32 });
    for (let index = 0; index < 12; index += 1) {
      model.push({ id: `n-${index}`, title: `Bildirim ${index}` });
    }
    renderTriage(model, { previewLimit: 4 });
    const panel = openPanel();
    expect(within(panel).getAllByRole('option')).toHaveLength(4);
    expect(within(panel).getByRole('status')).toHaveTextContent('hızlı listede');
  });

  it('keeps keyboard guidance discoverable but collapsed by default', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'a', title: 'A' });
    renderTriage(model);
    const panel = openPanel();
    const summary = within(panel).getByText('Klavye komutları');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(summary);
    expect(within(panel).getByText(/J \/ K veya ok tuşları/)).toBeInTheDocument();
  });
});
