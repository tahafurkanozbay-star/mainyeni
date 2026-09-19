import {
  createShortcutRuntime,
  isEditableShortcutTarget,
  type ShortcutDefinition,
} from './shortcutRuntime';

const dispatchKey = (
  target: Document | HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
};

describe('shortcutRuntime', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test('matches a simple shortcut and prevents default by default', () => {
    const handler = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      shortcuts: [{ id: 'help', key: '?', handler }],
    });

    const event = dispatchKey(document, '?');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(runtime.getSnapshot()).toEqual({
      active: true,
      shortcutCount: 1,
      sequence: 1,
      lastMatchedId: 'help',
    });
    runtime.dispose();
  });

  test('supports Ctrl-or-Meta shortcuts across desktop platforms', () => {
    const handler = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      shortcuts: [{
        id: 'command-palette',
        key: 'k',
        ctrlOrMeta: true,
        handler,
      }],
    });

    dispatchKey(document, 'k', { ctrlKey: true });
    dispatchKey(document, 'K', { metaKey: true });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(runtime.getSnapshot().sequence).toBe(2);
    runtime.dispose();
  });

  test('does not match Ctrl-or-Meta when neither modifier is pressed', () => {
    const handler = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      shortcuts: [{
        id: 'command-palette',
        key: 'k',
        ctrlOrMeta: true,
        handler,
      }],
    });

    dispatchKey(document, 'k');
    expect(handler).not.toHaveBeenCalled();
    runtime.dispose();
  });

  test('honours explicit modifier requirements', () => {
    const handler = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      shortcuts: [{
        id: 'alternate',
        key: 'x',
        ctrl: true,
        shift: true,
        alt: false,
        handler,
      }],
    });

    dispatchKey(document, 'x', { ctrlKey: true });
    dispatchKey(document, 'x', { ctrlKey: true, shiftKey: true, altKey: true });
    dispatchKey(document, 'x', { ctrlKey: true, shiftKey: true });

    expect(handler).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  test('can match a physical code in addition to the logical key', () => {
    const handler = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      shortcuts: [{
        id: 'slash',
        key: '/',
        code: 'Slash',
        handler,
      }],
    });

    dispatchKey(document, '/', { code: 'NumpadDivide' });
    dispatchKey(document, '/', { code: 'Slash' });
    expect(handler).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  test('ignores prevented, composing, dead and process events', () => {
    const handler = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      shortcuts: [{ id: 'action', key: 'a', handler }],
    });

    const prevented = new KeyboardEvent('keydown', {
      key: 'a',
      bubbles: true,
      cancelable: true,
    });
    prevented.preventDefault();
    document.dispatchEvent(prevented);

    dispatchKey(document, 'a', { isComposing: true });
    dispatchKey(document, 'Dead');
    dispatchKey(document, 'Process');

    expect(handler).not.toHaveBeenCalled();
    runtime.dispose();
  });

  test('ignores repeated events unless the shortcut opts in', () => {
    const once = vi.fn();
    const repeatable = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      shortcuts: [
        { id: 'once', key: 'a', handler: once },
        { id: 'repeatable', key: 'b', allowRepeat: true, handler: repeatable },
      ],
    });

    dispatchKey(document, 'a', { repeat: true });
    dispatchKey(document, 'b', { repeat: true });

    expect(once).not.toHaveBeenCalled();
    expect(repeatable).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  test('detects editable targets including text-like inputs', () => {
    const text = document.createElement('input');
    text.type = 'text';
    const search = document.createElement('input');
    search.type = 'search';
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    const textbox = document.createElement('div');
    textbox.setAttribute('role', 'textbox');

    document.body.append(text, search, textarea, select, editor, textbox);

    expect(isEditableShortcutTarget(text)).toBe(true);
    expect(isEditableShortcutTarget(search)).toBe(true);
    expect(isEditableShortcutTarget(textarea)).toBe(true);
    expect(isEditableShortcutTarget(select)).toBe(true);
    expect(isEditableShortcutTarget(editor)).toBe(true);
    expect(isEditableShortcutTarget(textbox)).toBe(true);
  });

  test('does not treat button-like input types as editable text', () => {
    const types = [
      'button',
      'checkbox',
      'color',
      'file',
      'hidden',
      'image',
      'radio',
      'range',
      'reset',
      'submit',
    ];

    for (const type of types) {
      const input = document.createElement('input');
      input.type = type;
      document.body.appendChild(input);
      expect(isEditableShortcutTarget(input)).toBe(false);
    }
  });

  test('suppresses global shortcuts while typing in editable controls', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);

    const handler = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      shortcuts: [{ id: 'help', key: '?', handler }],
    });

    dispatchKey(input, '?');
    expect(handler).not.toHaveBeenCalled();
    runtime.dispose();
  });

  test('can opt a shortcut into editable targets', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);

    const handler = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      shortcuts: [{
        id: 'command',
        key: 'k',
        ctrlOrMeta: true,
        allowInEditable: true,
        handler,
      }],
    });

    dispatchKey(input, 'k', { ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  test('can leave browser default behaviour untouched', () => {
    const handler = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      shortcuts: [{
        id: 'native-friendly',
        key: 'f',
        preventDefault: false,
        handler,
      }],
    });

    const event = dispatchKey(document, 'f');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    runtime.dispose();
  });

  test('enabled predicate can suppress a shortcut dynamically', () => {
    let enabled = false;
    const handler = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      shortcuts: [{
        id: 'conditional',
        key: 'c',
        enabled: () => enabled,
        handler,
      }],
    });

    dispatchKey(document, 'c');
    enabled = true;
    dispatchKey(document, 'c');

    expect(handler).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  test('isolates enabled-predicate failures and reports them', () => {
    const handler = vi.fn();
    const onHandlerError = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      onHandlerError,
      shortcuts: [{
        id: 'conditional',
        key: 'c',
        enabled: () => {
          throw new Error('predicate failure');
        },
        handler,
      }],
    });

    expect(() => dispatchKey(document, 'c')).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(onHandlerError).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  test('isolates handler failures and still records the match', () => {
    const onHandlerError = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      onHandlerError,
      shortcuts: [{
        id: 'unstable',
        key: 'u',
        handler: () => {
          throw new Error('handler failure');
        },
      }],
    });

    expect(() => dispatchKey(document, 'u')).not.toThrow();
    expect(runtime.getSnapshot().lastMatchedId).toBe('unstable');
    expect(runtime.getSnapshot().sequence).toBe(1);
    expect(onHandlerError).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  test('observer failures are isolated from keyboard handling', () => {
    const runtime = createShortcutRuntime({
      document,
      onHandlerError: () => {
        throw new Error('diagnostic observer failed');
      },
      shortcuts: [{
        id: 'unstable',
        key: 'u',
        handler: () => {
          throw new Error('handler failure');
        },
      }],
    });

    expect(() => dispatchKey(document, 'u')).not.toThrow();
    expect(runtime.getSnapshot().sequence).toBe(1);
    runtime.dispose();
  });

  test('higher-priority shortcut wins when definitions overlap', () => {
    const low = vi.fn();
    const high = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      shortcuts: [
        { id: 'low', key: 'g', priority: 1, handler: low },
        { id: 'high', key: 'g', priority: 10, handler: high },
      ],
    });

    dispatchKey(document, 'g');
    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().lastMatchedId).toBe('high');
    runtime.dispose();
  });

  test('stable id ordering resolves equal-priority overlaps deterministically', () => {
    const alpha = vi.fn();
    const beta = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      shortcuts: [
        { id: 'beta', key: 'g', priority: 5, handler: beta },
        { id: 'alpha', key: 'g', priority: 5, handler: alpha },
      ],
    });

    dispatchKey(document, 'g');
    expect(alpha).toHaveBeenCalledTimes(1);
    expect(beta).not.toHaveBeenCalled();
    runtime.dispose();
  });

  test('register returns an idempotent release function', () => {
    const runtime = createShortcutRuntime({ document });
    const handler = vi.fn();
    const release = runtime.register({
      id: 'dynamic',
      key: 'd',
      handler,
    });

    dispatchKey(document, 'd');
    release();
    release();
    dispatchKey(document, 'd');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().shortcutCount).toBe(0);
    runtime.dispose();
  });

  test('re-registering an id replaces the previous definition safely', () => {
    const runtime = createShortcutRuntime({ document });
    const first = vi.fn();
    const second = vi.fn();

    const releaseFirst = runtime.register({
      id: 'dynamic',
      key: 'd',
      handler: first,
    });
    const releaseSecond = runtime.register({
      id: 'dynamic',
      key: 'e',
      handler: second,
    });

    releaseFirst();
    dispatchKey(document, 'e');
    expect(second).toHaveBeenCalledTimes(1);

    releaseSecond();
    expect(runtime.getSnapshot().shortcutCount).toBe(0);
    runtime.dispose();
  });

  test('replace swaps the registry atomically', () => {
    const first = vi.fn();
    const second = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      shortcuts: [{ id: 'first', key: 'a', handler: first }],
    });

    runtime.replace([{ id: 'second', key: 'b', handler: second }]);
    dispatchKey(document, 'a');
    dispatchKey(document, 'b');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().shortcutCount).toBe(1);
    runtime.dispose();
  });

  test('replace rejects duplicate ids without leaving a partial registry', () => {
    const existing = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      shortcuts: [{ id: 'existing', key: 'e', handler: existing }],
    });

    const duplicates: ShortcutDefinition[] = [
      { id: 'duplicate', key: 'a', handler: vi.fn() },
      { id: 'duplicate', key: 'b', handler: vi.fn() },
    ];

    expect(() => runtime.replace(duplicates)).toThrow('Duplicate shortcut id');
    dispatchKey(document, 'e');
    expect(existing).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  test('validates identifiers and keys', () => {
    const runtime = createShortcutRuntime({ document });

    expect(() => runtime.register({
      id: '',
      key: 'a',
      handler: vi.fn(),
    })).toThrow('Shortcut id is required');

    expect(() => runtime.register({
      id: 'missing-key',
      key: '   ',
      handler: vi.fn(),
    })).toThrow('Shortcut key is required');

    runtime.dispose();
  });

  test('enforces a bounded registry capacity', () => {
    const runtime = createShortcutRuntime({ document });

    for (let index = 0; index < 128; index += 1) {
      runtime.register({
        id: `shortcut-${index}`,
        key: String(index),
        handler: vi.fn(),
      });
    }

    expect(() => runtime.register({
      id: 'overflow',
      key: 'o',
      handler: vi.fn(),
    })).toThrow('Shortcut capacity exceeded');

    runtime.dispose();
  });

  test('dispose is idempotent, clears definitions and detaches the listener', () => {
    const handler = vi.fn();
    const runtime = createShortcutRuntime({
      document,
      shortcuts: [{ id: 'help', key: '?', handler }],
    });

    runtime.dispose();
    runtime.dispose();
    dispatchKey(document, '?');

    expect(handler).not.toHaveBeenCalled();
    expect(runtime.getSnapshot()).toEqual({
      active: false,
      shortcutCount: 0,
      sequence: 0,
      lastMatchedId: null,
    });
  });
});
