import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Constants_ConfigKeys } from '../../../Core/Constants';
import { LocalStorageHelper } from '../../../Toolbox/LocalStorageHelper';
import type { BookmarkRecord } from '../_shared/MapWidgetRuntime';
import { BookmarkWidget } from './BookmarkWidget';

const mapRuntime = vi.hoisted(() => ({
  getMapView: vi.fn(),
  addGraphics: vi.fn(),
  removeGraphics: vi.fn(),
}));

vi.mock('../../../Store/Managers/MapManager', () => ({
  default: {
    GetMapView: mapRuntime.getMapView,
    AddGraphics: mapRuntime.addGraphics,
    RemoveGraphics: mapRuntime.removeGraphics,
  },
}));

const INITIAL: readonly BookmarkRecord[] = Object.freeze([
  Object.freeze({ Title: 'Kızılay', Lat: 39.9208, Lng: 32.8541, Zoom: 15 }),
  Object.freeze({ Title: 'Çankaya', Lat: 39.8897, Lng: 32.8634, Zoom: 14 }),
  Object.freeze({ Title: 'Kuğulu Park', Lat: 39.9027, Lng: 32.8608, Zoom: 17 }),
]);

const createWindowManager = () => ({
  IsVisible: vi.fn(() => true),
  IsMinimized: vi.fn(() => false),
  ToggleMinimiseWindow: vi.fn(),
  HideWindow: vi.fn(),
  ShowMessage: vi.fn(),
  ShowWindow: vi.fn(),
  RegisterWindow: vi.fn(),
  UnregisterWindow: vi.fn(),
});

const readStored = (): readonly BookmarkRecord[] => (
  LocalStorageHelper.Get<readonly BookmarkRecord[]>(Constants_ConfigKeys.BOOKMARKS) ?? []
);

const renderWidget = () => {
  const windowManager = createWindowManager();
  const result = render(<BookmarkWidget id="bookmark-test" windowManager={windowManager} />);
  return { ...result, windowManager };
};

const searchInput = (): HTMLInputElement => screen.getByRole('combobox', { name: 'Yer işareti ara' });
const listbox = (): HTMLElement => screen.getByRole('listbox', { name: 'Kayıtlı yer işaretleri' });
const options = (): HTMLElement[] => screen.queryAllByRole('option');

describe('BookmarkWidget modern screen', () => {
  beforeEach(() => {
    window.localStorage.clear();
    LocalStorageHelper.Set(Constants_ConfigKeys.BOOKMARKS, INITIAL);
    mapRuntime.getMapView.mockReset();
    mapRuntime.getMapView.mockReturnValue({
      center: { latitude: 39.93, longitude: 32.85 },
      zoom: 13,
      goTo: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('renders the shared widget region and canonical headings', async () => {
    renderWidget();
    expect(screen.getByRole('region', { name: 'Yer İşaretleri' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Bu görünümü kaydet' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Kayıtlı görünümler' })).toBeVisible();
    await waitFor(() => expect(options()).toHaveLength(3));
  });

  it('registers and unregisters the managed window lifecycle', () => {
    const { unmount, windowManager } = renderWidget();
    expect(windowManager.RegisterWindow).toHaveBeenCalledTimes(1);
    unmount();
    expect(windowManager.UnregisterWindow).toHaveBeenCalledWith('bookmark-test', null);
  });

  it('shows the canonical stored bookmark count', async () => {
    renderWidget();
    await waitFor(() => expect(screen.getAllByText('3 yer işareti kayıtlı.').length).toBeGreaterThan(0));
  });

  it('renders semantic listbox metadata', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    expect(listbox()).toHaveAttribute('tabindex', '0');
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    expect(options()[0]).toHaveAttribute('aria-posinset', '1');
    expect(options()[2]).toHaveAttribute('aria-setsize', '3');
    expect(listbox()).toHaveAttribute('aria-activedescendant', options()[0].id);
  });

  it('searches Turkish text without requiring exact diacritics', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.change(searchInput(), { target: { value: 'CANKAYA' } });
    expect(options()).toHaveLength(1);
    expect(options()[0]).toHaveTextContent('Çankaya');
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('searches coordinate fragments', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.change(searchInput(), { target: { value: '39.9027' } });
    expect(options()).toHaveLength(1);
    expect(options()[0]).toHaveTextContent('Kuğulu Park');
  });

  it('shows and recovers from a no-results state', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.change(searchInput(), { target: { value: 'bulunmayan kayıt' } });
    expect(screen.getByText('Eşleşme bulunamadı')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Tüm yer işaretlerini göster' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Tüm yer işaretlerini göster' }));
    expect(searchInput()).toHaveValue('');
    expect(options()).toHaveLength(3);
  });

  it('clears search from the explicit accessible clear control', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.change(searchInput(), { target: { value: 'park' } });
    fireEvent.click(screen.getByRole('button', { name: 'Yer işareti aramasını temizle' }));
    expect(searchInput()).toHaveValue('');
    expect(options()).toHaveLength(3);
  });

  it('switches between card and list views with pressed state', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    const card = screen.getByRole('button', { name: 'Kart' });
    const list = screen.getByRole('button', { name: 'Liste' });
    expect(card).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(list);
    expect(list).toHaveAttribute('aria-pressed', 'true');
    expect(card).toHaveAttribute('aria-pressed', 'false');
    expect(listbox()).toHaveAttribute('data-view', 'list');
  });

  it('moves the active descendant with ArrowDown from search', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    const input = searchInput();
    const secondId = options()[1].id;
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', secondId);
  });

  it('supports End and Home on the collection', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    const firstId = options()[0].id;
    const lastId = options()[2].id;
    fireEvent.keyDown(listbox(), { key: 'End' });
    expect(listbox()).toHaveAttribute('aria-activedescendant', lastId);
    fireEvent.keyDown(listbox(), { key: 'Home' });
    expect(listbox()).toHaveAttribute('aria-activedescendant', firstId);
  });

  it('saves a new current view and keeps existing records', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    const input = screen.getByRole('textbox', { name: 'Yer işareti adı' });
    fireEvent.change(input, { target: { value: 'Yeni çalışma alanı' } });
    fireEvent.click(screen.getByRole('button', { name: 'Görünümü kaydet' }));
    await waitFor(() => expect(readStored()).toHaveLength(4));
    expect(readStored().map((item) => item.Title)).toEqual(['Kızılay', 'Çankaya', 'Kuğulu Park', 'Yeni çalışma alanı']);
    expect(input).toHaveValue('');
    expect(screen.getByText('Yeni çalışma alanı kaydedildi.')).toBeVisible();
  });

  it('does not drop hidden bookmarks when saving with an active search', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.change(searchInput(), { target: { value: 'Kızılay' } });
    expect(options()).toHaveLength(1);
    fireEvent.change(screen.getByRole('textbox', { name: 'Yer işareti adı' }), { target: { value: 'Yeni' } });
    fireEvent.click(screen.getByRole('button', { name: 'Görünümü kaydet' }));
    await waitFor(() => expect(readStored().map((item) => item.Title)).toEqual(['Kızılay', 'Çankaya', 'Kuğulu Park', 'Yeni']));
  });

  it('shows inline validation when title is blank', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Görünümü kaydet' }));
    expect(screen.getByText('Lütfen yer işareti adını doldurunuz.')).toBeVisible();
  });

  it('shows duplicate-title validation without mutating storage', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.change(screen.getByRole('textbox', { name: 'Yer işareti adı' }), { target: { value: 'Kızılay' } });
    fireEvent.click(screen.getByRole('button', { name: 'Görünümü kaydet' }));
    expect(screen.getByText(/Aynı adla bir yer işareti bulunuyor/)).toBeVisible();
    expect(readStored()).toHaveLength(3);
  });

  it('requires explicit confirmation before deleting a bookmark', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Çankaya yer işaretini sil' }));
    const confirmation = screen.getByRole('group', { name: 'Çankaya silme onayı' });
    expect(within(confirmation).getByText('Bu kayıt silinsin mi?')).toBeVisible();
    expect(readStored()).toHaveLength(3);
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Vazgeç' }));
    expect(screen.queryByRole('group', { name: 'Çankaya silme onayı' })).not.toBeInTheDocument();
    expect(readStored()).toHaveLength(3);
  });

  it('deletes after confirmation and preserves other bookmarks', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Çankaya yer işaretini sil' }));
    fireEvent.click(screen.getByRole('button', { name: 'Evet, sil' }));
    await waitFor(() => expect(readStored().map((item) => item.Title)).toEqual(['Kızılay', 'Kuğulu Park']));
    expect(screen.getByText('Çankaya silindi.')).toBeVisible();
  });

  it('preserves hidden bookmarks when deleting under a search filter', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.change(searchInput(), { target: { value: 'Kızılay' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kızılay yer işaretini sil' }));
    fireEvent.click(screen.getByRole('button', { name: 'Evet, sil' }));
    await waitFor(() => expect(readStored().map((item) => item.Title)).toEqual(['Çankaya', 'Kuğulu Park']));
  });

  it('navigates to a bookmark from its action', async () => {
    const goTo = vi.fn().mockResolvedValue(undefined);
    mapRuntime.getMapView.mockReturnValue({
      center: { latitude: 39.93, longitude: 32.85 },
      zoom: 13,
      goTo,
    });
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    const first = options()[0];
    fireEvent.click(within(first).getByRole('button', { name: 'Haritada göster' }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith({ center: [32.8541, 39.9208], zoom: 15 }));
    await waitFor(() => expect(screen.getByText('Kızılay görünümüne gidildi.')).toBeVisible());
  });

  it('supports Enter navigation from the active collection row', async () => {
    const goTo = vi.fn().mockResolvedValue(undefined);
    mapRuntime.getMapView.mockReturnValue({
      center: { latitude: 39.93, longitude: 32.85 },
      zoom: 13,
      goTo,
    });
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.keyDown(listbox(), { key: 'Enter' });
    await waitFor(() => expect(goTo).toHaveBeenCalledWith({ center: [32.8541, 39.9208], zoom: 15 }));
  });

  it('shows navigation errors inline when the map view is unavailable', async () => {
    mapRuntime.getMapView.mockReturnValue({});
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.click(within(options()[0]).getByRole('button', { name: 'Haritada göster' }));
    expect(await screen.findByText('Harita görünümü henüz hazır değil.')).toBeVisible();
  });

  it('allows dismissing an inline operation notice', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Görünümü kaydet' }));
    expect(screen.getByText('Lütfen yer işareti adını doldurunuz.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'İşlem bildirimini kapat' }));
    expect(screen.queryByText('Lütfen yer işareti adını doldurunuz.')).not.toBeInTheDocument();
  });

  it('renders storage recovery warning for rejected records', async () => {
    LocalStorageHelper.Set(Constants_ConfigKeys.BOOKMARKS, [
      ...INITIAL,
      { Title: '', Lat: 'bad', Lng: 32, Zoom: 10 },
    ]);
    renderWidget();
    expect(await screen.findByText(/1 geçersiz veya yinelenen yer işareti/)).toBeVisible();
    expect(options()).toHaveLength(3);
  });

  it('renders an empty state with no stored bookmarks', async () => {
    LocalStorageHelper.Set(Constants_ConfigKeys.BOOKMARKS, []);
    renderWidget();
    expect(await screen.findByText('Henüz yer işareti yok')).toBeVisible();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
  it('publishes keyboard shortcuts and help on the search control', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    expect(searchInput()).toHaveAttribute(
      'aria-keyshortcuts',
      'ArrowDown ArrowUp Home End PageDown PageUp Escape',
    );
    expect(searchInput().getAttribute('aria-describedby')).toContain('bookmark-keyboard-help');
    expect(screen.getByText(/Delete ile silme onayını aç/)).toBeVisible();
  });

  it('publishes collection keyboard shortcuts and shared help description', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    expect(listbox()).toHaveAttribute(
      'aria-keyshortcuts',
      'ArrowDown ArrowUp ArrowLeft ArrowRight Home End PageDown PageUp Enter Delete Escape',
    );
    expect(listbox().getAttribute('aria-describedby')).toContain('bookmark-keyboard-help');
  });

  it('clears search with Escape without changing stored bookmarks', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.change(searchInput(), { target: { value: 'Çankaya' } });
    expect(options()).toHaveLength(1);
    fireEvent.keyDown(searchInput(), { key: 'Escape' });
    expect(searchInput()).toHaveValue('');
    expect(options()).toHaveLength(3);
    expect(readStored()).toHaveLength(3);
  });

  it('does not clear search during IME composition', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.change(searchInput(), { target: { value: 'Çankaya' } });
    fireEvent.keyDown(searchInput(), { key: 'Escape', isComposing: true });
    expect(searchInput()).toHaveValue('Çankaya');
  });

  it('moves focus from collection to search with slash', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    listbox().focus();
    expect(listbox()).toHaveFocus();
    fireEvent.keyDown(listbox(), { key: '/' });
    expect(searchInput()).toHaveFocus();
  });

  it('does not steal shifted slash from the collection', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    listbox().focus();
    fireEvent.keyDown(listbox(), { key: '/', shiftKey: true });
    expect(listbox()).toHaveFocus();
  });

  it('opens delete confirmation from the active row with Delete', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.keyDown(listbox(), { key: 'ArrowDown' });
    expect(listbox()).toHaveAttribute('aria-activedescendant', options()[1].id);
    fireEvent.keyDown(listbox(), { key: 'Delete' });
    expect(screen.getByRole('group', { name: 'Çankaya silme onayı' })).toBeVisible();
    expect(readStored()).toHaveLength(3);
  });

  it('opens delete confirmation from the active row with Backspace', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.keyDown(listbox(), { key: 'Backspace' });
    expect(screen.getByRole('group', { name: 'Kızılay silme onayı' })).toBeVisible();
    expect(readStored()).toHaveLength(3);
  });

  it('cancels keyboard delete confirmation with Escape', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.keyDown(listbox(), { key: 'Delete' });
    expect(screen.getByRole('group', { name: 'Kızılay silme onayı' })).toBeVisible();
    fireEvent.keyDown(listbox(), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Kızılay silme onayı' })).not.toBeInTheDocument();
    expect(readStored()).toHaveLength(3);
  });

  it('does not repeat keyboard deletion intent', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.keyDown(listbox(), { key: 'Delete', repeat: true });
    expect(screen.queryByRole('group', { name: 'Kızılay silme onayı' })).not.toBeInTheDocument();
  });

  it('does not repeat Enter map navigation', async () => {
    const goTo = vi.fn().mockResolvedValue(undefined);
    mapRuntime.getMapView.mockReturnValue({
      center: { latitude: 39.93, longitude: 32.85 },
      zoom: 13,
      goTo,
    });
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.keyDown(listbox(), { key: 'Enter', repeat: true });
    expect(goTo).not.toHaveBeenCalled();
  });

  it('does not steal Ctrl+ArrowDown from browser or assistive technology commands', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    const activeBefore = listbox().getAttribute('aria-activedescendant');
    fireEvent.keyDown(listbox(), { key: 'ArrowDown', ctrlKey: true });
    expect(listbox()).toHaveAttribute('aria-activedescendant', activeBefore);
  });

  it('does not steal Meta+Enter from platform commands', async () => {
    const goTo = vi.fn().mockResolvedValue(undefined);
    mapRuntime.getMapView.mockReturnValue({
      center: { latitude: 39.93, longitude: 32.85 },
      zoom: 13,
      goTo,
    });
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.keyDown(listbox(), { key: 'Enter', metaKey: true });
    expect(goTo).not.toHaveBeenCalled();
  });

  it('supports PageDown and PageUp through the governed collection policy', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    const firstId = options()[0].id;
    const lastId = options()[2].id;
    fireEvent.keyDown(listbox(), { key: 'PageDown' });
    expect(listbox()).toHaveAttribute('aria-activedescendant', lastId);
    fireEvent.keyDown(listbox(), { key: 'PageUp' });
    expect(listbox()).toHaveAttribute('aria-activedescendant', firstId);
  });

  it('supports Home and End from search without mutating the query', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.change(searchInput(), { target: { value: 'a' } });
    const currentOptions = options();
    expect(currentOptions.length).toBeGreaterThan(1);
    fireEvent.keyDown(searchInput(), { key: 'End' });
    expect(searchInput()).toHaveAttribute('aria-activedescendant', currentOptions.at(-1)?.id);
    fireEvent.keyDown(searchInput(), { key: 'Home' });
    expect(searchInput()).toHaveAttribute('aria-activedescendant', currentOptions[0].id);
    expect(searchInput()).toHaveValue('a');
  });

  it('keeps an empty search untouched when Escape has no local action', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.keyDown(searchInput(), { key: 'Escape' });
    expect(searchInput()).toHaveValue('');
    expect(options()).toHaveLength(3);
  });

  it('does not move search active descendant for Ctrl+ArrowDown', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    const activeBefore = searchInput().getAttribute('aria-activedescendant');
    fireEvent.keyDown(searchInput(), { key: 'ArrowDown', ctrlKey: true });
    expect(searchInput()).toHaveAttribute('aria-activedescendant', activeBefore);
  });

  it('does not move collection active descendant during IME composition', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    const activeBefore = listbox().getAttribute('aria-activedescendant');
    fireEvent.keyDown(listbox(), { key: 'ArrowDown', isComposing: true });
    expect(listbox()).toHaveAttribute('aria-activedescendant', activeBefore);
  });

  it('opens keyboard delete confirmation for the filtered active result only', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.change(searchInput(), { target: { value: 'Kuğulu' } });
    expect(options()).toHaveLength(1);
    fireEvent.keyDown(listbox(), { key: 'Delete' });
    expect(screen.getByRole('group', { name: 'Kuğulu Park silme onayı' })).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Kızılay silme onayı' })).not.toBeInTheDocument();
    expect(readStored()).toHaveLength(3);
  });

  it('keeps filtered storage intact after keyboard delete cancellation', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.change(searchInput(), { target: { value: 'Çankaya' } });
    fireEvent.keyDown(listbox(), { key: 'Delete' });
    fireEvent.keyDown(listbox(), { key: 'Escape' });
    expect(readStored().map((item) => item.Title)).toEqual(['Kızılay', 'Çankaya', 'Kuğulu Park']);
    expect(options()).toHaveLength(1);
    expect(options()[0]).toHaveTextContent('Çankaya');
  });

  it('preserves roving selection when slash returns focus to search', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.keyDown(listbox(), { key: 'ArrowDown' });
    const selectedId = listbox().getAttribute('aria-activedescendant');
    fireEvent.keyDown(listbox(), { key: '/' });
    expect(searchInput()).toHaveFocus();
    expect(searchInput()).toHaveAttribute('aria-activedescendant', selectedId);
  });

  it('keeps keyboard help associated after switching visual layout', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Liste' }));
    expect(listbox()).toHaveAttribute('data-view', 'list');
    expect(listbox().getAttribute('aria-describedby')).toContain('bookmark-keyboard-help');
    fireEvent.click(screen.getByRole('button', { name: 'Kart' }));
    expect(listbox()).toHaveAttribute('data-view', 'grid');
    expect(listbox().getAttribute('aria-describedby')).toContain('bookmark-keyboard-help');
  });

  it('keeps keyboard navigation available after clearing a no-results query', async () => {
    renderWidget();
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.change(searchInput(), { target: { value: 'eşleşmeyen' } });
    expect(screen.getByText('Eşleşme bulunamadı')).toBeVisible();
    fireEvent.keyDown(searchInput(), { key: 'Escape' });
    expect(options()).toHaveLength(3);
    const firstId = options()[0].id;
    fireEvent.keyDown(searchInput(), { key: 'ArrowDown' });
    expect(searchInput()).not.toHaveAttribute('aria-activedescendant', firstId);
    expect(searchInput()).toHaveAttribute('aria-activedescendant', options()[1].id);
  });

});
