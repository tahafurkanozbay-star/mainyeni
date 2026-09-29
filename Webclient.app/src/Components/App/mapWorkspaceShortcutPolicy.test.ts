import { afterEach, describe, expect, it } from 'vitest';
import {
  auditShortcutDefinitions,
  chordMatches,
  createShortcutChord,
  evaluateShortcutPolicy,
  formatShortcutLabel,
  isShortcutEditableTarget,
  normalizeShortcutKey,
} from './mapWorkspaceShortcutPolicy';

afterEach(() => { document.body.innerHTML = ''; });

const keyboardShape = (overrides: Partial<KeyboardEvent> = {}): KeyboardEvent => new KeyboardEvent('keydown', {
  key: 'm',
  altKey: true,
  bubbles: true,
  ...overrides,
});

describe('mapWorkspaceShortcutPolicy', () => {
  it('normalizes legacy and Turkish-aware keys deterministically', () => {
    expect(normalizeShortcutKey('Esc')).toBe('escape');
    expect(normalizeShortcutKey('Spacebar')).toBe(' ');
    expect(normalizeShortcutKey(' I ')).toBe('ı');
    expect(normalizeShortcutKey('İ')).toBe('i');
  });

  it('creates an immutable-value chord shape from keyboard state', () => {
    expect(createShortcutChord(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true }))).toEqual({
      key: 'k', alt: false, ctrl: true, meta: false, shift: false,
    });
  });

  it('matches the complete modifier contract rather than key only', () => {
    const chord = createShortcutChord(new KeyboardEvent('keydown', { key: 'b', altKey: true }));
    expect(chordMatches(chord, { key: 'B', alt: true })).toBe(true);
    expect(chordMatches(chord, { key: 'b', alt: true, shift: true })).toBe(false);
    expect(chordMatches(chord, { key: 'b' })).toBe(false);
  });

  it.each([
    ['input', '<input />'],
    ['textarea', '<textarea></textarea>'],
    ['select', '<select><option>Bir</option></select>'],
    ['textbox role', '<div role="textbox" tabindex="0"></div>'],
    ['searchbox role', '<div role="searchbox" tabindex="0"></div>'],
    ['combobox role', '<div role="combobox" tabindex="0"></div>'],
    ['spinbutton role', '<div role="spinbutton" tabindex="0"></div>'],
    ['explicit editable scope', '<div data-shortcut-scope="editable"><button>İçerik</button></div>'],
  ])('recognizes %s as an editable shortcut target', (_name, markup) => {
    document.body.innerHTML = markup;
    const target = document.body.querySelector('*')?.lastElementChild ?? document.body.querySelector('*');
    expect(isShortcutEditableTarget(target)).toBe(true);
  });

  it.each(['', 'true', 'plaintext-only'])('recognizes contenteditable="%s" ancestors without DOM implementation assumptions', (value) => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', value);
    const child = document.createElement('span');
    editor.appendChild(child);
    document.body.appendChild(editor);
    expect(isShortcutEditableTarget(child)).toBe(true);
  });

  it('honors contenteditable=false as an explicit non-editable boundary', () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const island = document.createElement('div');
    island.setAttribute('contenteditable', 'false');
    const button = document.createElement('button');
    island.appendChild(button);
    editor.appendChild(island);
    document.body.appendChild(editor);
    expect(isShortcutEditableTarget(button)).toBe(false);
  });

  it('allows an explicit global scope to terminate editable ancestor traversal', () => {
    const editor = document.createElement('div');
    editor.setAttribute('data-shortcut-scope', 'editable');
    const global = document.createElement('div');
    global.setAttribute('data-shortcut-scope', 'global');
    const button = document.createElement('button');
    global.appendChild(button);
    editor.appendChild(global);
    document.body.appendChild(editor);
    expect(isShortcutEditableTarget(button)).toBe(false);
  });

  it('rejects already-consumed keyboard events', () => {
    const event = keyboardShape();
    event.preventDefault();
    expect(evaluateShortcutPolicy(event)).toEqual({ allowed: false, reason: 'default-prevented' });
  });

  it('rejects key repeat so a held shortcut cannot reopen windows continuously', () => {
    expect(evaluateShortcutPolicy(keyboardShape({ repeat: true }))).toEqual({ allowed: false, reason: 'repeat' });
  });

  it('rejects IME composition events', () => {
    expect(evaluateShortcutPolicy(keyboardShape({ isComposing: true }))).toEqual({ allowed: false, reason: 'composition' });
  });

  it('rejects events originating in editable controls', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const event = keyboardShape();
    Object.defineProperty(event, 'target', { value: input });
    expect(evaluateShortcutPolicy(event)).toEqual({ allowed: false, reason: 'editable-target' });
  });

  it('rejects workspace shortcuts while an aria-modal dialog owns interaction', () => {
    const dialog = document.createElement('section');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const button = document.createElement('button');
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    const event = keyboardShape();
    Object.defineProperty(event, 'target', { value: button });
    expect(evaluateShortcutPolicy(event)).toEqual({ allowed: false, reason: 'modal-scope' });
  });

  it('rejects workspace shortcuts while a native open dialog owns interaction', () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    const button = document.createElement('button');
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    const event = keyboardShape();
    Object.defineProperty(event, 'target', { value: button });
    expect(evaluateShortcutPolicy(event)).toEqual({ allowed: false, reason: 'modal-scope' });
  });

  it('allows a clean non-editable workspace event', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    const event = keyboardShape();
    Object.defineProperty(event, 'target', { value: button });
    expect(evaluateShortcutPolicy(event)).toEqual({ allowed: true, reason: 'allowed' });
  });

  it('formats labels without relying on navigator platform sniffing', () => {
    expect(formatShortcutLabel({ key: 'k', ctrl: true })).toBe('Ctrl+K');
    expect(formatShortcutLabel({ key: 'k', meta: true }, 'mac')).toBe('Command+K');
    expect(formatShortcutLabel({ key: 'b', alt: true }, 'mac')).toBe('Option+B');
    expect(formatShortcutLabel({ key: 'r', alt: true, shift: true })).toBe('Alt+Shift+R');
  });

  it('audits duplicate identifiers and complete chord collisions', () => {
    const issues = auditShortcutDefinitions([
      { id: 'map', key: 'm', alt: true },
      { id: 'map', key: 'n', alt: true },
      { id: 'other', key: 'M', alt: true },
      { id: '', key: 'x', alt: true },
    ]);
    expect(issues).toContain('Tekrarlanan kısayol kimliği: map');
    expect(issues).toContain('Kısayol çakışması: map ve other');
    expect(issues).toContain('Kısayol kimliği boş olamaz.');
  });

  it('returns no audit issues for a deterministic registry', () => {
    expect(auditShortcutDefinitions([
      { id: 'map', key: 'm', alt: true },
      { id: 'nav', key: 'n', alt: true },
      { id: 'command', key: 'k', ctrl: true },
    ])).toEqual([]);
  });
});
