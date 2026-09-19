import {
  createFocusScope,
  getFocusableElements,
  isFocusableElement,
} from './focusScopeRuntime';

const createDialog = (): {
  container: HTMLElement;
  before: HTMLButtonElement;
  first: HTMLButtonElement;
  middle: HTMLInputElement;
  last: HTMLButtonElement;
} => {
  document.body.innerHTML = `
    <button id="before" type="button">Önceki</button>
    <section id="dialog" tabindex="-1">
      <button id="first" type="button">İlk</button>
      <input id="middle" aria-label="Orta alan" />
      <button id="last" type="button">Son</button>
    </section>
  `;

  const before = document.getElementById('before');
  const container = document.getElementById('dialog');
  const first = document.getElementById('first');
  const middle = document.getElementById('middle');
  const last = document.getElementById('last');

  if (
    !(before instanceof HTMLButtonElement)
    || !(container instanceof HTMLElement)
    || !(first instanceof HTMLButtonElement)
    || !(middle instanceof HTMLInputElement)
    || !(last instanceof HTMLButtonElement)
  ) {
    throw new Error('Focus scope test fixture is incomplete');
  }

  return { container, before, first, middle, last };
};

describe('focusScopeRuntime', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test('collects only interaction-visible tabbable elements', () => {
    const { container, first, middle, last } = createDialog();
    middle.disabled = true;

    const hidden = document.createElement('button');
    hidden.hidden = true;
    container.appendChild(hidden);

    const ariaHidden = document.createElement('button');
    ariaHidden.setAttribute('aria-hidden', 'true');
    container.appendChild(ariaHidden);

    const inertGroup = document.createElement('div');
    inertGroup.setAttribute('inert', '');
    const inertButton = document.createElement('button');
    inertGroup.appendChild(inertButton);
    container.appendChild(inertGroup);

    expect(getFocusableElements(container)).toEqual([first, last]);
    expect(isFocusableElement(first)).toBe(true);
    expect(isFocusableElement(middle)).toBe(false);
    expect(isFocusableElement(hidden)).toBe(false);
    expect(isFocusableElement(ariaHidden)).toBe(false);
    expect(isFocusableElement(inertButton)).toBe(false);
  });

  test('focuses the requested initial control and restores previous focus', () => {
    const { container, before, middle } = createDialog();
    before.focus();

    const scope = createFocusScope({
      document,
      container,
      initialFocus: middle,
    });

    scope.activate();
    expect(document.activeElement).toBe(middle);
    expect(scope.getSnapshot()).toEqual({
      active: true,
      topMost: true,
      focusableCount: 3,
      sequence: 1,
    });

    scope.deactivate();
    expect(document.activeElement).toBe(before);
    expect(scope.getSnapshot()).toEqual({
      active: false,
      topMost: false,
      focusableCount: 3,
      sequence: 2,
    });
  });

  test('resolves initial focus from a selector inside the container', () => {
    const { container, last } = createDialog();

    const scope = createFocusScope({
      document,
      container,
      initialFocus: '#last',
    });

    scope.activate();
    expect(document.activeElement).toBe(last);
    scope.dispose();
  });

  test('uses a callback focus target when the element is available', () => {
    const { container, middle } = createDialog();
    const resolve = vi.fn(() => middle);

    const scope = createFocusScope({
      document,
      container,
      initialFocus: resolve,
    });

    scope.activate();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(middle);
    scope.dispose();
  });

  test('falls back to the first focusable control when initial focus is invalid', () => {
    const { container, first } = createDialog();
    const detached = document.createElement('button');

    const scope = createFocusScope({
      document,
      container,
      initialFocus: detached,
    });

    scope.activate();
    expect(document.activeElement).toBe(first);
    scope.dispose();
  });

  test('supports an explicit fallback when no child is tabbable', () => {
    document.body.innerHTML = `
      <button id="before">Önceki</button>
      <section id="dialog" tabindex="-1">
        <button type="button" disabled>Kapalı</button>
      </section>
      <button id="fallback" type="button">Yedek</button>
    `;

    const container = document.getElementById('dialog');
    const fallback = document.getElementById('fallback');
    if (!(container instanceof HTMLElement) || !(fallback instanceof HTMLButtonElement)) {
      throw new Error('Fallback fixture is incomplete');
    }

    const scope = createFocusScope({
      document,
      container,
      fallbackFocus: fallback,
    });

    scope.activate();
    expect(document.activeElement).toBe(fallback);
    scope.dispose();
  });

  test('cycles Tab from the final control back to the first', () => {
    const { container, first, last } = createDialog();
    const scope = createFocusScope({ document, container });
    scope.activate();

    last.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    scope.dispose();
  });

  test('cycles Shift+Tab from the first control back to the final control', () => {
    const { container, first, last } = createDialog();
    const scope = createFocusScope({ document, container });
    scope.activate();

    first.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    scope.dispose();
  });

  test('recovers focus into the scope when Tab starts outside the modal', () => {
    const { container, before, first } = createDialog();
    const scope = createFocusScope({ document, container });
    scope.activate();

    before.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    scope.dispose();
  });

  test('does not trap modified Tab combinations', () => {
    const { container, last } = createDialog();
    const scope = createFocusScope({ document, container });
    scope.activate();

    last.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(last);
    scope.dispose();
  });

  test('can disable focus trapping for non-modal surfaces', () => {
    const { container, last } = createDialog();
    const scope = createFocusScope({
      document,
      container,
      trapFocus: false,
    });
    scope.activate();

    last.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(last);
    scope.dispose();
  });

  test('routes Escape to the top-most scope only', () => {
    const outerFixture = createDialog();
    const inner = document.createElement('section');
    inner.innerHTML = '<button id="inner-close" type="button">İç</button>';
    document.body.appendChild(inner);

    const outerEscape = vi.fn();
    const innerEscape = vi.fn();
    const outer = createFocusScope({
      document,
      container: outerFixture.container,
      onEscape: outerEscape,
    });
    const innerScope = createFocusScope({
      document,
      container: inner,
      onEscape: innerEscape,
    });

    outer.activate();
    innerScope.activate();

    const firstEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(firstEscape);

    expect(firstEscape.defaultPrevented).toBe(true);
    expect(innerEscape).toHaveBeenCalledTimes(1);
    expect(outerEscape).not.toHaveBeenCalled();

    innerScope.deactivate();

    const secondEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(secondEscape);

    expect(outerEscape).toHaveBeenCalledTimes(1);
    outer.dispose();
    innerScope.dispose();
  });

  test('can keep Escape available to a parent keyboard handler', () => {
    const { container } = createDialog();
    const onEscape = vi.fn();
    const scope = createFocusScope({
      document,
      container,
      closeOnEscape: false,
      onEscape,
    });
    scope.activate();

    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onEscape).not.toHaveBeenCalled();
    scope.dispose();
  });

  test('nested scopes expose deterministic top-most snapshots', () => {
    const { container } = createDialog();
    const secondContainer = document.createElement('section');
    secondContainer.innerHTML = '<button type="button">İç</button>';
    document.body.appendChild(secondContainer);

    const outer = createFocusScope({ document, container });
    const inner = createFocusScope({ document, container: secondContainer });

    outer.activate();
    expect(outer.getSnapshot().topMost).toBe(true);

    inner.activate();
    expect(outer.getSnapshot().topMost).toBe(false);
    expect(inner.getSnapshot().topMost).toBe(true);

    inner.deactivate();
    expect(outer.getSnapshot().topMost).toBe(true);

    outer.dispose();
    inner.dispose();
  });

  test('does not restore focus when restoration is disabled', () => {
    const { container, before, middle } = createDialog();
    before.focus();
    const scope = createFocusScope({
      document,
      container,
      initialFocus: middle,
      restoreFocus: false,
    });

    scope.activate();
    expect(document.activeElement).toBe(middle);
    scope.deactivate();
    expect(document.activeElement).toBe(middle);
  });

  test('does not restore a detached previous focus target', () => {
    const { container, before, middle } = createDialog();
    before.focus();
    const scope = createFocusScope({
      document,
      container,
      initialFocus: middle,
    });

    scope.activate();
    before.remove();
    scope.deactivate();

    expect(document.activeElement).not.toBe(before);
  });

  test('isolates focus and escape observer failures', () => {
    const { container, first } = createDialog();
    const onFocusError = vi.fn();
    const onEscape = vi.fn(() => {
      throw new Error('escape observer failed');
    });

    const scope = createFocusScope({
      document,
      container,
      initialFocus: () => {
        throw new Error('resolver failed');
      },
      onEscape,
      onFocusError,
    });

    expect(() => scope.activate()).not.toThrow();
    expect(document.activeElement).toBe(first);

    expect(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
    }).not.toThrow();

    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onFocusError).toHaveBeenCalledTimes(1);
    scope.dispose();
  });

  test('dispose is idempotent and removes the keyboard listener', () => {
    const { container, last } = createDialog();
    const onEscape = vi.fn();
    const scope = createFocusScope({
      document,
      container,
      onEscape,
    });

    scope.activate();
    scope.dispose();
    scope.dispose();
    last.focus();

    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(onEscape).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  test('activate and deactivate are idempotent within one lifecycle', () => {
    const { container } = createDialog();
    const scope = createFocusScope({ document, container });

    scope.activate();
    scope.activate();
    expect(scope.getSnapshot().sequence).toBe(1);

    scope.deactivate();
    scope.deactivate();
    expect(scope.getSnapshot().sequence).toBe(2);

    scope.dispose();
  });
});
