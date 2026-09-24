import { describe, expect, it, vi } from 'vitest';
import { DialogStackModel } from './dialogStackModel';

describe('DialogStackModel', () => {
  it('makes only the active modal a focus trap and inerts the page', () => {
    const model = new DialogStackModel();
    model.open({ id: 'layers', kind: 'drawer', label: 'Katmanlar', restoreFocusTo: 'layers-button' });
    model.open({ id: 'confirm', kind: 'modal', label: 'Onay' });

    const snapshot = model.snapshot();
    expect(snapshot.pageInert).toBe(true);
    expect(snapshot.activeId).toBe('confirm');
    expect(snapshot.dialogs[0]).toMatchObject({ active: false, trapFocus: false, ariaHidden: true });
    expect(snapshot.dialogs[1]).toMatchObject({ active: true, trapFocus: true, ariaHidden: false });
  });

  it('restores focus to the declared trigger when closing', () => {
    const model = new DialogStackModel();
    model.open({ id: 'help', kind: 'modal', label: 'Klavye yardımı', restoreFocusTo: 'help-button' });
    expect(model.close('help')).toBe('help-button');
    expect(model.snapshot().activeId).toBeNull();
  });

  it('does not dismiss a protected active dialog with escape policy', () => {
    const model = new DialogStackModel();
    model.open({ id: 'save', kind: 'modal', label: 'Kaydediliyor', dismissible: false });
    expect(model.snapshot().escapeDismisses).toBe(false);
    expect(model.dismissActive()).toBeNull();
    expect(model.snapshot().activeId).toBe('save');
  });

  it('keeps popovers non-modal while exposing the active surface', () => {
    const model = new DialogStackModel();
    model.open({ id: 'basemap', kind: 'popover', label: 'Altlık harita' });
    const snapshot = model.snapshot();
    expect(snapshot.pageInert).toBe(false);
    expect(snapshot.dialogs[0]).toMatchObject({ modal: false, trapFocus: false, active: true });
  });

  it('uses larger targets for coarse pointers and carries user media preferences', () => {
    const model = new DialogStackModel();
    model.setPreferences({ coarsePointer: true, reducedMotion: true, forcedColors: true });
    expect(model.snapshot()).toMatchObject({
      minimumTargetPx: 48,
      coarsePointer: true,
      reducedMotion: true,
      forcedColors: true,
    });
  });

  it('rejects duplicate and unlabeled dialogs', () => {
    const model = new DialogStackModel();
    expect(() => model.open({ id: ' ', kind: 'modal', label: 'Test' })).toThrow('Dialog id is required');
    expect(() => model.open({ id: 'x', kind: 'modal', label: ' ' })).toThrow('Dialog label is required');
    model.open({ id: 'x', kind: 'modal', label: 'X' });
    expect(() => model.open({ id: 'x', kind: 'drawer', label: 'Other' })).toThrow('already open');
  });

  it('isolates observer and reporter failures from state changes', () => {
    const reporter = vi.fn(() => { throw new Error('reporter failed'); });
    const model = new DialogStackModel({ onObserverError: reporter });
    model.subscribe(() => { throw new Error('observer failed'); });
    expect(() => model.open({ id: 'x', kind: 'modal', label: 'X' })).not.toThrow();
    expect(model.snapshot().activeId).toBe('x');
    expect(reporter).toHaveBeenCalled();
  });

  it('notifies subscribers with immutable snapshots', () => {
    const model = new DialogStackModel();
    const observer = vi.fn();
    const unsubscribe = model.subscribe(observer);
    model.open({ id: 'x', kind: 'drawer', label: 'X' });
    expect(observer).toHaveBeenCalledTimes(2);
    expect(Object.isFrozen(observer.mock.calls.at(-1)?.[0])).toBe(true);
    unsubscribe();
    model.close('x');
    expect(observer).toHaveBeenCalledTimes(2);
  });
});
