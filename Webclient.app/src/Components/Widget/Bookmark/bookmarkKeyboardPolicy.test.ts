import { describe, expect, it } from 'vitest';
import {
  BOOKMARK_KEYBOARD_SHORTCUTS,
  bookmarkKeyboardAriaShortcuts,
  bookmarkKeyboardHelpText,
  resolveBookmarkKeyboardIntent,
  type BookmarkKeyboardContext,
  type BookmarkKeyboardEventLike,
} from './bookmarkKeyboardPolicy';

const baseContext = (overrides: Partial<BookmarkKeyboardContext> = {}): BookmarkKeyboardContext => ({
  surface: 'collection',
  resultCount: 5,
  hasActiveEntry: true,
  hasPendingDelete: false,
  hasQuery: false,
  busy: false,
  ...overrides,
});
const key = (value: string, overrides: Partial<BookmarkKeyboardEventLike> = {}): BookmarkKeyboardEventLike => ({ key: value, ...overrides });

describe('bookmark keyboard movement', () => {
  it.each([
    ['ArrowDown', 'next'],
    ['ArrowRight', 'next'],
    ['ArrowUp', 'previous'],
    ['ArrowLeft', 'previous'],
    ['Home', 'first'],
    ['End', 'last'],
    ['PageDown', 'page-next'],
    ['PageUp', 'page-previous'],
  ] as const)('maps %s to %s in the collection', (keyboardKey, move) => {
    expect(resolveBookmarkKeyboardIntent(key(keyboardKey), baseContext())).toEqual({
      intent: { kind: 'move', move },
      preventDefault: true,
      announceShortcut: false,
    });
  });

  it.each([
    ['ArrowDown', 'next'],
    ['ArrowRight', 'next'],
    ['ArrowUp', 'previous'],
    ['ArrowLeft', 'previous'],
    ['Home', 'first'],
    ['End', 'last'],
    ['PageDown', 'page-next'],
    ['PageUp', 'page-previous'],
  ] as const)('maps %s to %s from search', (keyboardKey, move) => {
    expect(resolveBookmarkKeyboardIntent(
      key(keyboardKey),
      baseContext({ surface: 'search', hasQuery: true }),
    ).intent).toEqual({ kind: 'move', move });
  });

  it('does not consume movement with no results', () => {
    expect(resolveBookmarkKeyboardIntent(
      key('ArrowDown'),
      baseContext({ resultCount: 0, hasActiveEntry: false }),
    )).toEqual({ intent: { kind: 'none' }, preventDefault: false, announceShortcut: false });
  });

  it.each(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'])(
    'does not steal %s with Ctrl',
    (keyboardKey) => {
      expect(resolveBookmarkKeyboardIntent(key(keyboardKey, { ctrlKey: true }), baseContext()).intent.kind).toBe('none');
    },
  );

  it('allows Shift with movement', () => {
    expect(resolveBookmarkKeyboardIntent(key('ArrowDown', { shiftKey: true }), baseContext()).intent)
      .toEqual({ kind: 'move', move: 'next' });
  });
});

describe('bookmark keyboard collection actions', () => {
  it('activates the selected bookmark with Enter', () => {
    expect(resolveBookmarkKeyboardIntent(key('Enter'), baseContext())).toEqual({
      intent: { kind: 'activate' },
      preventDefault: true,
      announceShortcut: false,
    });
  });

  it('does not activate without an active result', () => {
    expect(resolveBookmarkKeyboardIntent(key('Enter'), baseContext({ hasActiveEntry: false })).intent.kind).toBe('none');
  });

  it('does not activate while busy', () => {
    expect(resolveBookmarkKeyboardIntent(key('Enter'), baseContext({ busy: true })).intent.kind).toBe('none');
  });

  it('does not repeat Enter activation', () => {
    expect(resolveBookmarkKeyboardIntent(key('Enter', { repeat: true }), baseContext()).intent.kind).toBe('none');
  });

  it.each(['Delete', 'Backspace'])('requests confirmation with %s', (keyboardKey) => {
    expect(resolveBookmarkKeyboardIntent(key(keyboardKey), baseContext())).toEqual({
      intent: { kind: 'request-delete' },
      preventDefault: true,
      announceShortcut: false,
    });
  });

  it('does not request deletion while busy', () => {
    expect(resolveBookmarkKeyboardIntent(key('Delete'), baseContext({ busy: true })).intent.kind).toBe('none');
  });

  it('does not repeat destructive intent', () => {
    expect(resolveBookmarkKeyboardIntent(key('Delete', { repeat: true }), baseContext()).intent.kind).toBe('none');
  });

  it.each(['ArrowDown', 'Home', 'Enter', 'Delete', 'Backspace', '/'])(
    'does not handle %s while a delete confirmation is open',
    (keyboardKey) => {
      expect(resolveBookmarkKeyboardIntent(
        key(keyboardKey),
        baseContext({ hasPendingDelete: true }),
      ).intent.kind).toBe('none');
    },
  );

  it('does not change search selection while delete confirmation is open', () => {
    expect(resolveBookmarkKeyboardIntent(
      key('ArrowDown'),
      baseContext({ surface: 'search', hasPendingDelete: true, hasQuery: true }),
    ).intent.kind).toBe('none');
  });

  it('cancels delete confirmation with Escape even while busy', () => {
    expect(resolveBookmarkKeyboardIntent(
      key('Escape'),
      baseContext({ busy: true, hasPendingDelete: true }),
    ).intent).toEqual({ kind: 'cancel-delete' });
  });

  it('does not consume Escape without confirmation', () => {
    expect(resolveBookmarkKeyboardIntent(key('Escape'), baseContext()).preventDefault).toBe(false);
  });

  it('focuses search with slash', () => {
    expect(resolveBookmarkKeyboardIntent(key('/'), baseContext())).toEqual({
      intent: { kind: 'focus-search' },
      preventDefault: true,
      announceShortcut: true,
    });
  });

  it('does not treat shifted slash as shortcut', () => {
    expect(resolveBookmarkKeyboardIntent(key('/', { shiftKey: true }), baseContext()).intent.kind).toBe('none');
  });

  it('does not repeat slash shortcut', () => {
    expect(resolveBookmarkKeyboardIntent(key('/', { repeat: true }), baseContext()).intent.kind).toBe('none');
  });
});

describe('bookmark keyboard search actions', () => {
  it('clears populated search with Escape', () => {
    expect(resolveBookmarkKeyboardIntent(
      key('Escape'),
      baseContext({ surface: 'search', hasQuery: true }),
    )).toEqual({ intent: { kind: 'clear-search' }, preventDefault: true, announceShortcut: false });
  });

  it('does not consume Escape for empty search', () => {
    expect(resolveBookmarkKeyboardIntent(
      key('Escape'),
      baseContext({ surface: 'search', hasQuery: false }),
    ).intent.kind).toBe('none');
  });

  it.each(['Enter', 'Delete', '/', 'Backspace'])('does not expose %s collection action from search', (keyboardKey) => {
    expect(resolveBookmarkKeyboardIntent(
      key(keyboardKey),
      baseContext({ surface: 'search', hasQuery: true }),
    ).intent.kind).toBe('none');
  });
});

describe('bookmark keyboard input safety', () => {
  it.each([
    { isComposing: true },
    { defaultPrevented: true },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
  ])('does not steal Enter for guarded event %o', (guard) => {
    expect(resolveBookmarkKeyboardIntent(key('Enter', guard), baseContext()).intent.kind).toBe('none');
  });

  it.each(['Process', 'Dead'])('ignores IME/dead-key sentinel %s', (keyboardKey) => {
    expect(resolveBookmarkKeyboardIntent(key(keyboardKey), baseContext())).toEqual({
      intent: { kind: 'none' },
      preventDefault: false,
      announceShortcut: false,
    });
  });

  it.each([
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
  ])('does not steal slash with command modifier %o', (modifier) => {
    expect(resolveBookmarkKeyboardIntent(key('/', modifier), baseContext()).intent.kind).toBe('none');
  });

  it('does not steal Escape from command-modified search', () => {
    expect(resolveBookmarkKeyboardIntent(
      key('Escape', { metaKey: true }),
      baseContext({ surface: 'search', hasQuery: true }),
    ).intent.kind).toBe('none');
  });

  it('returns frozen decisions', () => {
    const resolved = resolveBookmarkKeyboardIntent(key('Enter'), baseContext());
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.intent)).toBe(true);
  });
});

describe('bookmark keyboard discoverability', () => {
  it('documents every interaction category', () => {
    expect(BOOKMARK_KEYBOARD_SHORTCUTS.map((shortcut) => shortcut.key)).toEqual([
      'Arrow keys',
      'Home / End',
      'PageUp / PageDown',
      'Enter',
      'Delete',
      'Escape',
      '/',
    ]);
  });

  it('keeps shortcut metadata immutable', () => {
    expect(Object.isFrozen(BOOKMARK_KEYBOARD_SHORTCUTS)).toBe(true);
    for (const shortcut of BOOKMARK_KEYBOARD_SHORTCUTS) {
      expect(Object.isFrozen(shortcut)).toBe(true);
      expect(Object.isFrozen(shortcut.surfaces)).toBe(true);
    }
  });

  it('scopes activation and deletion to collection', () => {
    expect(BOOKMARK_KEYBOARD_SHORTCUTS.find((shortcut) => shortcut.key === 'Enter')?.surfaces).toEqual(['collection']);
    expect(BOOKMARK_KEYBOARD_SHORTCUTS.find((shortcut) => shortcut.key === 'Delete')?.surfaces).toEqual(['collection']);
  });

  it('makes navigation discoverable on both surfaces', () => {
    expect(BOOKMARK_KEYBOARD_SHORTCUTS.find((shortcut) => shortcut.key === 'Arrow keys')?.surfaces)
      .toEqual(['search', 'collection']);
  });

  it('provides search aria-keyshortcuts tokens', () => {
    expect(bookmarkKeyboardAriaShortcuts('search')).toBe('ArrowDown ArrowUp Home End PageDown PageUp Escape');
  });

  it('provides collection aria-keyshortcuts tokens', () => {
    expect(bookmarkKeyboardAriaShortcuts('collection')).toBe(
      'ArrowDown ArrowUp ArrowLeft ArrowRight Home End PageDown PageUp Enter Delete Escape',
    );
  });

  it('provides concise visible help', () => {
    const help = bookmarkKeyboardHelpText();
    expect(help).toContain('Enter ile haritada göster');
    expect(help).toContain('Delete ile silme onayını aç');
    expect(help).toContain('/ ile aramaya dön');
    expect(help).toContain('Escape ile iptal et');
  });

  it('does not promise direct deletion', () => {
    const remove = BOOKMARK_KEYBOARD_SHORTCUTS.find((shortcut) => shortcut.key === 'Delete');
    expect(remove?.description).toContain('onay');
    expect(remove?.description).toContain('doğrudan silmez');
  });
  it('keeps visible shortcut labels non-empty for assistive documentation', () => {
    for (const shortcut of BOOKMARK_KEYBOARD_SHORTCUTS) {
      expect(shortcut.label.trim().length).toBeGreaterThan(0);
      expect(shortcut.description.trim().length).toBeGreaterThan(0);
      expect(shortcut.surfaces.length).toBeGreaterThan(0);
    }
  });

});
