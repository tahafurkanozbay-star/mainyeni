import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationCenterModel } from '../../experience/notificationCenterModel';
import { ExperienceNotificationTriage } from './ExperienceNotificationTriage';

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;
const originalMatchMedia = window.matchMedia;
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;

interface MediaState {
  readonly coarse?: boolean;
  readonly reducedMotion?: boolean;
  readonly forcedColors?: boolean;
}

const setViewport = (width: number, height: number, media: MediaState = {}): void => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === '(pointer: coarse)'
        ? media.coarse === true
        : query === '(prefers-reduced-motion: reduce)'
          ? media.reducedMotion === true
          : query === '(forced-colors: active)'
            ? media.forcedColors === true
            : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  });
};

const createModel = (): NotificationCenterModel => {
  const model = new NotificationCenterModel();
  model.push({
    id: 'mobile-notification',
    title: 'Mobil bildirim',
    message: 'Harita çalışma alanında dikkat gerektiren bir bildirim.',
    tone: 'warning',
  });
  return model;
};

const openTriage = (model = createModel()): HTMLElement => {
  render(<ExperienceNotificationTriage model={model} />);
  fireEvent.click(screen.getByRole('button', { name: /1 okunmamış/i }));
  return screen.getByLabelText('Bildirim hızlı işlemleri');
};

beforeEach(() => {
  setViewport(1280, 800);
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: vi.fn((callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    }),
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: vi.fn(),
  });
  if (typeof HTMLElement.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  }
});

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: originalRequestAnimationFrame });
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: originalCancelAnimationFrame });
  vi.restoreAllMocks();
});

describe('ExperienceNotificationTriage responsive presentation', () => {
  it('keeps the desktop quick surface non-modal', () => {
    setViewport(1280, 800);
    const root = openTriage();
    expect(root).toHaveAttribute('data-modal', 'false');
    expect(root).toHaveAttribute('data-surface', 'floating');
    expect(root).toHaveAttribute('data-placement', 'overlay');
    expect(screen.getByRole('region', { name: 'Bildirim hızlı inceleme paneli' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('promotes the phone surface to an accessible modal bottom sheet', () => {
    setViewport(390, 780, { coarse: true });
    const root = openTriage();
    expect(root).toHaveAttribute('data-modal', 'true');
    expect(root).toHaveAttribute('data-surface', 'sheet');
    expect(root).toHaveAttribute('data-placement', 'bottom');
    expect(root).toHaveAttribute('data-min-target', '48');
    const dialog = screen.getByRole('dialog', { name: 'Bildirimler' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-describedby', 'experience-notification-triage-status');
    expect(root.querySelector('.experience-notification-triage__backdrop')).not.toBeNull();
    expect(screen.getByRole('button', { name: /1 okunmamış/i })).toHaveAttribute('tabindex', '-1');
  });

  it('closes the mobile modal with Escape and returns focus to the compact trigger', () => {
    setViewport(390, 780, { coarse: true });
    openTriage();
    const dialog = screen.getByRole('dialog', { name: 'Bildirimler' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    const trigger = screen.getByRole('button', { name: /1 okunmamış/i });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).not.toHaveAttribute('tabindex', '-1');
  });

  it('lets Escape clear an active search before closing the mobile modal', () => {
    setViewport(390, 780, { coarse: true });
    openTriage();
    const dialog = screen.getByRole('dialog', { name: 'Bildirimler' });
    const search = within(dialog).getByRole('searchbox', { name: 'Bildirim ara' });
    fireEvent.change(search, { target: { value: 'mobil' } });
    expect(search).toHaveValue('mobil');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(screen.getByRole('dialog', { name: 'Bildirimler' })).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the modal through the visual backdrop without adding a tab stop', () => {
    setViewport(390, 780, { coarse: true });
    const root = openTriage();
    const backdrop = root.querySelector<HTMLElement>('.experience-notification-triage__backdrop');
    expect(backdrop).not.toBeNull();
    if (!backdrop) throw new Error('Expected notification modal backdrop');
    expect(backdrop).toHaveAttribute('aria-hidden', 'true');
    expect(backdrop).not.toHaveAttribute('tabindex');
    fireEvent.mouseDown(backdrop);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('traps forward Tab navigation at the last modal control', () => {
    setViewport(390, 780, { coarse: true });
    openTriage();
    const dialog = screen.getByRole('dialog', { name: 'Bildirimler' });
    const lastControl = within(dialog).getByRole('button', { name: 'Tam bildirim merkezini aç' });
    const firstControl = within(dialog).getByRole('button', { name: 'Hızlı bildirim panelini kapat' });
    lastControl.focus();
    fireEvent.keyDown(lastControl, { key: 'Tab' });
    expect(firstControl).toHaveFocus();
  });

  it('traps reverse Tab navigation at the first modal control', () => {
    setViewport(390, 780, { coarse: true });
    openTriage();
    const dialog = screen.getByRole('dialog', { name: 'Bildirimler' });
    const firstControl = within(dialog).getByRole('button', { name: 'Hızlı bildirim panelini kapat' });
    const lastControl = within(dialog).getByRole('button', { name: 'Tam bildirim merkezini aç' });
    firstControl.focus();
    fireEvent.keyDown(firstControl, { key: 'Tab', shiftKey: true });
    expect(lastControl).toHaveFocus();
  });

  it('reflects reduced-motion and forced-colors preferences into the DOM contract', () => {
    setViewport(390, 780, { reducedMotion: true, forcedColors: true });
    const root = openTriage();
    expect(root).toHaveAttribute('data-motion', 'reduced');
    expect(root).toHaveAttribute('data-forced-colors', 'true');
  });

  it('recomputes modal semantics after a viewport resize', () => {
    setViewport(1280, 800);
    const root = openTriage();
    expect(root).toHaveAttribute('data-modal', 'false');
    setViewport(390, 780, { coarse: true });
    fireEvent(window, new Event('resize'));
    expect(root).toHaveAttribute('data-modal', 'true');
    expect(screen.getByRole('dialog', { name: 'Bildirimler' })).toHaveAttribute('aria-modal', 'true');
  });
});
