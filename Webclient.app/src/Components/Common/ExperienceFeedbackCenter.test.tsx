import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationCenterModel } from '../../experience/notificationCenterModel';
import { ExperienceFeedbackCenter } from './ExperienceFeedbackCenter';

const createMatchMedia = (matches: Readonly<Record<string, boolean>> = {}) =>
  (query: string): MediaQueryList => ({
    matches: matches[query] ?? false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  });

const push = (
  model: NotificationCenterModel,
  id: string,
  options: {
    tone?: 'info' | 'success' | 'warning' | 'error';
    priority?: 'normal' | 'urgent';
    message?: string;
    actions?: readonly { id: string; label: string }[];
  } = {},
): void => {
  act(() => {
    model.push({
      id,
      title: `Bildirim ${id}`,
      message: options.message ?? `Açıklama ${id}`,
      tone: options.tone,
      priority: options.priority,
      actions: options.actions,
      createdAt: Date.now(),
    });
  });
};

const getHistoryItems = (): HTMLElement[] =>
  screen.queryAllByRole('listitem');

describe('ExperienceFeedbackCenter', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: createMatchMedia() });
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: (callback: FrameRequestCallback): number => {
        callback(performance.now());
        return 1;
      },
    });
    Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, writable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
  });

  it('renders an accessible empty history surface', () => {
    const model = new NotificationCenterModel();
    render(<ExperienceFeedbackCenter model={model} />);
    expect(screen.getByRole('heading', { name: 'Bildirim merkezi' })).toBeInTheDocument();
    expect(screen.getByText('Bildirim geçmişi boş.')).toBeInTheDocument();
    expect(screen.getByText(/0 okunmamış/i)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Bildirim geçmişi' })).toBeInTheDocument();
  });

  it('mirrors live notifications into presentation history', () => {
    const model = new NotificationCenterModel();
    render(<ExperienceFeedbackCenter model={model} />);
    push(model, 'one');
    expect(screen.getByRole('heading', { name: 'Bildirim one' })).toBeInTheDocument();
    expect(screen.getByText('Açıklama one')).toBeInTheDocument();
    expect(getHistoryItems()).toHaveLength(1);
  });

  it('keeps dismissed notifications discoverable in history', () => {
    const model = new NotificationCenterModel();
    render(<ExperienceFeedbackCenter model={model} />);
    push(model, 'kept');
    act(() => {
      model.dismiss('kept');
    });
    expect(model.snapshot().items).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'Bildirim kept' })).toBeInTheDocument();
  });

  it('exposes urgent and warning events through the important filter', () => {
    const model = new NotificationCenterModel();
    render(<ExperienceFeedbackCenter model={model} />);
    push(model, 'normal');
    push(model, 'warning', { tone: 'warning' });
    push(model, 'urgent', { priority: 'urgent' });
    fireEvent.click(screen.getByRole('button', { name: 'Önemli' }));
    expect(screen.queryByRole('heading', { name: 'Bildirim normal' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Bildirim warning' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Bildirim urgent' })).toBeInTheDocument();
  });

  it('filters to unread notifications and reacts to source read state', () => {
    const model = new NotificationCenterModel();
    render(<ExperienceFeedbackCenter model={model} />);
    push(model, 'read-me');
    push(model, 'stay-unread');
    act(() => {
      model.markRead('read-me');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Okunmamış' }));
    expect(screen.queryByRole('heading', { name: 'Bildirim read-me' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Bildirim stay-unread' })).toBeInTheDocument();
  });

  it('marks every live notification as read from the bulk action', () => {
    const model = new NotificationCenterModel();
    render(<ExperienceFeedbackCenter model={model} />);
    push(model, 'a');
    push(model, 'b');
    fireEvent.click(screen.getByRole('button', { name: 'Tümünü okundu işaretle' }));
    expect(model.snapshot().unreadCount).toBe(0);
  });

  it('clears read live notifications while retaining unread events', () => {
    const model = new NotificationCenterModel();
    render(<ExperienceFeedbackCenter model={model} />);
    push(model, 'read');
    push(model, 'unread');
    act(() => {
      model.markRead('read');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Okunanları temizle' }));
    expect(model.snapshot().items.map((entry) => entry.id)).toEqual(['unread']);
  });

  it('invokes source notification actions and marks the item read', () => {
    const model = new NotificationCenterModel();
    const onAction = vi.fn();
    render(<ExperienceFeedbackCenter model={model} onAction={onAction} />);
    push(model, 'action', { actions: [{ id: 'open', label: 'Sonucu aç' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Sonucu aç' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]?.[0].id).toBe('action');
    expect(onAction.mock.calls[0]?.[1]).toEqual({ id: 'open', label: 'Sonucu aç' });
    expect(model.snapshot().items[0]?.read).toBe(true);
  });

  it('removes an item from both live center and presentation history', () => {
    const model = new NotificationCenterModel();
    render(<ExperienceFeedbackCenter model={model} />);
    push(model, 'remove');
    fireEvent.click(screen.getByRole('button', { name: 'Bildirim remove bildirimini geçmişten kaldır' }));
    expect(model.snapshot().items).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: 'Bildirim remove' })).not.toBeInTheDocument();
  });

  it('sorts oldest-first without mutating the source center order', () => {
    let clock = 10_000;
    const model = new NotificationCenterModel({ now: () => clock });
    render(<ExperienceFeedbackCenter model={model} />);
    push(model, 'first');
    clock += 1_000;
    push(model, 'second');
    fireEvent.click(screen.getByRole('button', { name: 'En eski' }));
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual(['Bildirim first', 'Bildirim second']);
    expect(model.snapshot().items.map((entry) => entry.id)).toEqual(['second', 'first']);
  });

  it('persists bounded density preference in session storage', () => {
    const model = new NotificationCenterModel();
    render(<ExperienceFeedbackCenter model={model} />);
    fireEvent.click(screen.getByText('Görünüm ve duyuru tercihleri'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Yoğunluk' }), { target: { value: 'compact' } });
    const stored = window.sessionStorage.getItem('kent-rehberi:feedback-history-preferences:v1');
    expect(stored).toContain('"density":"compact"');
    expect(stored?.length).toBeLessThan(512);
  });

  it('restores valid session preferences on the next mount', () => {
    window.sessionStorage.setItem('kent-rehberi:feedback-history-preferences:v1', JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      source: 'user',
      preferences: {
        filter: 'all',
        sort: 'newest',
        density: 'compact',
        announcementMode: 'off',
        autoMarkRead: true,
      },
    }));
    const model = new NotificationCenterModel();
    const { container } = render(<ExperienceFeedbackCenter model={model} />);
    expect(container.querySelector('.experience-feedback-center')).toHaveAttribute('data-density', 'compact');
    fireEvent.click(screen.getByText('Görünüm ve duyuru tercihleri'));
    expect(screen.getByRole('combobox', { name: 'Ekran okuyucu duyuruları' })).toHaveValue('off');
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('fails closed to default preferences when session payload is malformed', () => {
    window.sessionStorage.setItem('kent-rehberi:feedback-history-preferences:v1', '{bad-json');
    const model = new NotificationCenterModel();
    const { container } = render(<ExperienceFeedbackCenter model={model} />);
    expect(container.querySelector('.experience-feedback-center')).toHaveAttribute('data-density', 'comfortable');
  });

  it('resets user preferences to safe defaults', () => {
    const model = new NotificationCenterModel();
    render(<ExperienceFeedbackCenter model={model} />);
    fireEvent.click(screen.getByText('Görünüm ve duyuru tercihleri'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Yoğunluk' }), { target: { value: 'compact' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tercihleri sıfırla' }));
    expect(screen.getByRole('combobox', { name: 'Yoğunluk' })).toHaveValue('comfortable');
  });

  it('uses phone bottom-sheet presentation on narrow viewports', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 480 });
    const model = new NotificationCenterModel();
    const { container } = render(<ExperienceFeedbackCenter model={model} />);
    expect(container.querySelector('.experience-feedback-center')).toHaveAttribute('data-placement', 'bottom-sheet');
  });

  it('reflects reduced-motion and forced-colors preferences in the surface contract', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: createMatchMedia({
        '(prefers-reduced-motion: reduce)': true,
        '(forced-colors: active)': true,
      }),
    });
    const model = new NotificationCenterModel();
    const { container } = render(<ExperienceFeedbackCenter model={model} />);
    const center = container.querySelector('.experience-feedback-center');
    expect(center).toHaveAttribute('data-motion', 'reduced');
    expect(center).toHaveAttribute('data-forced-colors', 'true');
  });

  it('moves the active history row with ArrowDown while keeping a single roving tab stop', () => {
    const model = new NotificationCenterModel();
    render(<ExperienceFeedbackCenter model={model} />);
    push(model, 'one');
    push(model, 'two');
    const list = screen.getByRole('list', { name: 'Bildirim geçmişi' });
    const before = getHistoryItems().filter((entry) => entry.tabIndex === 0);
    expect(before).toHaveLength(1);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    const after = getHistoryItems().filter((entry) => entry.tabIndex === 0);
    expect(after).toHaveLength(1);
  });

  it('supports Home and End history navigation without changing filter controls', () => {
    const model = new NotificationCenterModel();
    render(<ExperienceFeedbackCenter model={model} />);
    push(model, 'one');
    push(model, 'two');
    push(model, 'three');
    const list = screen.getByRole('list', { name: 'Bildirim geçmişi' });
    fireEvent.keyDown(list, { key: 'End' });
    expect(getHistoryItems().filter((entry) => entry.tabIndex === 0)).toHaveLength(1);
    fireEvent.keyDown(list, { key: 'Home' });
    expect(screen.getByRole('button', { name: 'Tümü' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('cycles filter controls with ArrowRight', () => {
    const model = new NotificationCenterModel();
    render(<ExperienceFeedbackCenter model={model} />);
    push(model, 'important', { tone: 'warning' });
    const allButton = screen.getByRole('button', { name: 'Tümü' });
    const controls = allButton.closest('.experience-feedback-center__controls');
    expect(controls).not.toBeNull();
    fireEvent.keyDown(controls!, { key: 'ArrowRight' });
    expect(screen.getByRole('button', { name: 'Okunmamış' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders each feedback row with explicit accessible description and controls', () => {
    const model = new NotificationCenterModel();
    render(<ExperienceFeedbackCenter model={model} />);
    push(model, 'semantic', { tone: 'error' });
    const row = getHistoryItems()[0];
    expect(row).toHaveAttribute('aria-labelledby');
    expect(row).toHaveAttribute('aria-describedby');
    expect(within(row).getByText('Hata')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /okundu işaretle/i })).toBeInTheDocument();
  });
});
