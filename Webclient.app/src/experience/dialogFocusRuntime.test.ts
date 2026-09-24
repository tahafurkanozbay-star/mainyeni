import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogStackModel } from './dialogStackModel';
import { createDialogFocusRuntime } from './dialogFocusRuntime';

const mounted: HTMLElement[] = [];

const mount = (tag = 'div'): HTMLElement => {
  const element = document.createElement(tag);
  document.body.append(element);
  mounted.push(element);
  return element;
};

const addSurface = (root: HTMLElement, id: string, buttons = 2): HTMLElement => {
  const surface = document.createElement('section');
  surface.dataset.experienceDialogId = id;
  for (let index = 0; index < buttons; index += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${id}-${index + 1}`;
    surface.append(button);
  }
  root.append(surface);
  return surface;
};

afterEach(() => {
  mounted.splice(0).forEach((element) => element.remove());
  document.body.innerHTML = '';
  document.body.style.overflow = '';
  document.body.style.overscrollBehavior = '';
  document.documentElement.removeAttribute('data-experience-modal-open');
  document.documentElement.removeAttribute('data-experience-overlay-count');
});

describe('dialogFocusRuntime', () => {
  it('inerts declared background roots while a modal surface is active', () => {
    const overlay = mount();
    const background = mount('main');
    addSurface(overlay, 'settings');
    const model = new DialogStackModel();
    const runtime = createDialogFocusRuntime({ document, overlayRoot: overlay, backgroundRoots: [background] });

    model.open({ id: 'settings', kind: 'modal', label: 'Ayarlar' });
    runtime.apply(model.snapshot());

    expect(background.inert).toBe(true);
    expect(background.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.dataset.experienceOverlayActive).toBe('settings');

    model.close('settings');
    runtime.apply(model.snapshot());
    expect(background.inert).toBe(false);
    expect(background.hasAttribute('aria-hidden')).toBe(false);
    runtime.dispose();
  });

  it('locks document scrolling while a modal is active and restores the page on close', () => {
    const overlay = mount();
    addSurface(overlay, 'settings');
    document.body.style.overflow = 'clip';
    document.body.style.overscrollBehavior = 'contain';
    const model = new DialogStackModel();
    const runtime = createDialogFocusRuntime({ document, overlayRoot: overlay });

    model.open({ id: 'settings', kind: 'modal', label: 'Ayarlar' });
    runtime.apply(model.snapshot());

    expect(document.documentElement).toHaveAttribute('data-experience-modal-open');
    expect(document.documentElement).toHaveAttribute('data-experience-overlay-count', '1');
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.body.style.overscrollBehavior).toBe('none');

    model.close('settings');
    runtime.apply(model.snapshot());

    expect(document.documentElement).not.toHaveAttribute('data-experience-modal-open');
    expect(document.documentElement).toHaveAttribute('data-experience-overlay-count', '0');
    expect(document.body.style.overflow).toBe('clip');
    expect(document.body.style.overscrollBehavior).toBe('contain');
    runtime.dispose();
  });

  it('restores pre-existing document contract values when disposed mid-modal', () => {
    const overlay = mount();
    addSurface(overlay, 'help');
    document.documentElement.setAttribute('data-experience-modal-open', '');
    document.documentElement.setAttribute('data-experience-overlay-count', '7');
    document.body.style.overflow = 'scroll';
    document.body.style.overscrollBehavior = 'auto';
    const model = new DialogStackModel();
    const runtime = createDialogFocusRuntime({ document, overlayRoot: overlay });

    model.open({ id: 'help', kind: 'modal', label: 'Yardım' });
    runtime.apply(model.snapshot());
    runtime.dispose();

    expect(document.documentElement).toHaveAttribute('data-experience-modal-open');
    expect(document.documentElement).toHaveAttribute('data-experience-overlay-count', '7');
    expect(document.body.style.overflow).toBe('scroll');
    expect(document.body.style.overscrollBehavior).toBe('auto');
  });

  it('preserves pre-existing inert and aria-hidden state after disposal', () => {
    const overlay = mount();
    const background = mount();
    background.inert = true;
    background.setAttribute('aria-hidden', 'true');
    addSurface(overlay, 'help');
    const model = new DialogStackModel();
    const runtime = createDialogFocusRuntime({ document, overlayRoot: overlay, backgroundRoots: [background] });

    model.open({ id: 'help', kind: 'modal', label: 'Yardım' });
    runtime.apply(model.snapshot());
    runtime.dispose();

    expect(background.inert).toBe(true);
    expect(background.getAttribute('aria-hidden')).toBe('true');
  });

  it('focuses the first interactive control when a surface becomes active', () => {
    const overlay = mount();
    const surface = addSurface(overlay, 'layers');
    const first = surface.querySelector('button');
    const model = new DialogStackModel();
    const runtime = createDialogFocusRuntime({ document, overlayRoot: overlay });

    model.open({ id: 'layers', kind: 'drawer', label: 'Katmanlar' });
    runtime.apply(model.snapshot());

    expect(document.activeElement).toBe(first);
    runtime.dispose();
  });

  it('prefers an explicit autofocus target', () => {
    const overlay = mount();
    const surface = addSurface(overlay, 'search');
    const input = document.createElement('input');
    input.dataset.experienceAutofocus = 'true';
    surface.prepend(input);
    const model = new DialogStackModel();
    const runtime = createDialogFocusRuntime({ document, overlayRoot: overlay });

    model.open({ id: 'search', kind: 'modal', label: 'Arama' });
    runtime.apply(model.snapshot());

    expect(document.activeElement).toBe(input);
    runtime.dispose();
  });

  it('focuses the surface itself when it has no focusable descendants', () => {
    const overlay = mount();
    const surface = addSurface(overlay, 'empty', 0);
    const model = new DialogStackModel();
    const runtime = createDialogFocusRuntime({ document, overlayRoot: overlay });

    model.open({ id: 'empty', kind: 'modal', label: 'Boş dialog' });
    runtime.apply(model.snapshot());

    expect(surface.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(surface);
    runtime.dispose();
  });

  it('wraps Tab from the final control to the first control', () => {
    const overlay = mount();
    const surface = addSurface(overlay, 'dialog');
    const buttons = surface.querySelectorAll<HTMLButtonElement>('button');
    const first = buttons.item(0);
    const last = buttons.item(1);
    const model = new DialogStackModel();
    const runtime = createDialogFocusRuntime({ document, overlayRoot: overlay });
    model.open({ id: 'dialog', kind: 'modal', label: 'Dialog' });
    runtime.apply(model.snapshot());
    last.focus();

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    runtime.dispose();
  });

  it('wraps Shift+Tab from the first control to the final control', () => {
    const overlay = mount();
    const surface = addSurface(overlay, 'dialog');
    const buttons = surface.querySelectorAll<HTMLButtonElement>('button');
    const first = buttons.item(0);
    const last = buttons.item(1);
    const model = new DialogStackModel();
    const runtime = createDialogFocusRuntime({ document, overlayRoot: overlay });
    model.open({ id: 'dialog', kind: 'modal', label: 'Dialog' });
    runtime.apply(model.snapshot());
    first.focus();

    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    runtime.dispose();
  });

  it('returns escaped focus back into the active modal', () => {
    const overlay = mount();
    const surface = addSurface(overlay, 'dialog');
    const outside = mount('button');
    const first = surface.querySelector('button');
    const model = new DialogStackModel();
    const runtime = createDialogFocusRuntime({ document, overlayRoot: overlay });
    model.open({ id: 'dialog', kind: 'modal', label: 'Dialog' });
    runtime.apply(model.snapshot());

    outside.focus();
    outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    expect(document.activeElement).toBe(first);
    runtime.dispose();
  });

  it('does not trap focus for a popover', () => {
    const overlay = mount();
    addSurface(overlay, 'popover');
    const outside = mount('button');
    const model = new DialogStackModel();
    const runtime = createDialogFocusRuntime({ document, overlayRoot: overlay });
    model.open({ id: 'popover', kind: 'popover', label: 'Menü' });
    runtime.apply(model.snapshot());

    outside.focus();
    outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    expect(document.activeElement).toBe(outside);
    runtime.dispose();
  });

  it('requests active dismissal on Escape only when allowed', () => {
    const overlay = mount();
    addSurface(overlay, 'dismissible');
    const request = vi.fn();
    const model = new DialogStackModel();
    const runtime = createDialogFocusRuntime({ document, overlayRoot: overlay, onDismissRequest: request });
    model.open({ id: 'dismissible', kind: 'modal', label: 'Dialog' });
    runtime.apply(model.snapshot());

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(request).toHaveBeenCalledWith('dismissible');

    model.close('dismissible');
    model.open({ id: 'protected', kind: 'modal', label: 'Korunan', dismissible: false });
    addSurface(overlay, 'protected');
    runtime.apply(model.snapshot());
    request.mockClear();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(request).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('restores focus to the declared trigger when the final surface closes', () => {
    const overlay = mount();
    addSurface(overlay, 'help');
    const trigger = mount('button');
    trigger.id = 'help-trigger';
    const model = new DialogStackModel();
    const runtime = createDialogFocusRuntime({ document, overlayRoot: overlay });
    model.open({ id: 'help', kind: 'modal', label: 'Yardım', restoreFocusTo: trigger.id });
    runtime.apply(model.snapshot());

    model.close('help');
    runtime.apply(model.snapshot());

    expect(document.activeElement).toBe(trigger);
    runtime.dispose();
  });

  it('reflects accessibility media preferences on the overlay root', () => {
    const overlay = mount();
    const model = new DialogStackModel();
    const runtime = createDialogFocusRuntime({ document, overlayRoot: overlay });
    model.setPreferences({ reducedMotion: true, forcedColors: true, coarsePointer: true });
    runtime.apply(model.snapshot());

    expect(overlay.dataset.experienceReducedMotion).toBe('true');
    expect(overlay.dataset.experienceForcedColors).toBe('true');
    expect(overlay.dataset.experienceCoarsePointer).toBe('true');
    runtime.dispose();
  });

  it('removes document listeners and restores document state after disposal', () => {
    const overlay = mount();
    addSurface(overlay, 'dialog');
    const request = vi.fn();
    const model = new DialogStackModel();
    const runtime = createDialogFocusRuntime({ document, overlayRoot: overlay, onDismissRequest: request });
    model.open({ id: 'dialog', kind: 'modal', label: 'Dialog' });
    runtime.apply(model.snapshot());
    runtime.dispose();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(request).not.toHaveBeenCalled();
    expect(overlay.hasAttribute('data-experience-overlay-active')).toBe(false);
    expect(document.documentElement).not.toHaveAttribute('data-experience-modal-open');
    expect(document.documentElement).not.toHaveAttribute('data-experience-overlay-count');
  });
});