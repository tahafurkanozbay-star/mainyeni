import { afterEach, describe, expect, it } from 'vitest';
import { focusManagedWindow, isManagedFocusCandidate } from './ManagedWindowFocus';

afterEach(() => { document.body.replaceChildren(); });

const createShadowButton = (host: HTMLElement): HTMLButtonElement => {
  const button = document.createElement('button');
  host.attachShadow({ mode: 'open' }).append(button);
  return button;
};

describe('managed focus through shadow hosts', () => {
  it('accepts a visible button in a connected web component', () => {
    const host = document.createElement('div');
    const button = createShadowButton(host);
    document.body.append(host);
    expect(isManagedFocusCandidate(button)).toBe(true);
  });

  it('rejects a button behind a hidden, inert or disabled host', () => {
    const host = document.createElement('div');
    const button = createShadowButton(host);
    document.body.append(host);
    host.hidden = true;
    expect(isManagedFocusCandidate(button)).toBe(false);
    host.hidden = false;
    host.setAttribute('inert', '');
    expect(isManagedFocusCandidate(button)).toBe(false);
    host.removeAttribute('inert');
    host.setAttribute('aria-disabled', 'true');
    expect(isManagedFocusCandidate(button)).toBe(false);
  });

  it('rejects computed CSS invisibility on the shadow host', () => {
    const host = document.createElement('div');
    const button = createShadowButton(host);
    document.body.append(host);
    host.style.display = 'none';
    expect(isManagedFocusCandidate(button)).toBe(false);
    host.style.display = 'block';
    host.style.visibility = 'hidden';
    expect(isManagedFocusCandidate(button)).toBe(false);
    host.style.visibility = 'visible';
    expect(isManagedFocusCandidate(button)).toBe(true);
  });

  it('checks outer ancestors across nested shadow roots', () => {
    const outer = document.createElement('div');
    const inner = document.createElement('div');
    outer.attachShadow({ mode: 'open' }).append(inner);
    const button = createShadowButton(inner);
    document.body.append(outer);
    expect(isManagedFocusCandidate(button)).toBe(true);
    outer.setAttribute('aria-hidden', 'true');
    expect(isManagedFocusCandidate(button)).toBe(false);
  });

  it('does not move initial focus into a CSS-hidden shadow host', () => {
    const host = document.createElement('div');
    const section = document.createElement('section');
    section.append(document.createElement('button'));
    host.attachShadow({ mode: 'open' }).append(section);
    document.body.append(host);
    host.style.display = 'none';
    expect(focusManagedWindow({ root: section })).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
