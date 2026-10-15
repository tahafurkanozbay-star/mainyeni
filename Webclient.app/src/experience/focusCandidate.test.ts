import { afterEach, describe, expect, it } from 'vitest';
import { getDeepActiveElement, isManagedFocusCandidate, isWithinComposedSubtree } from './focusCandidate';

afterEach(() => { document.body.replaceChildren(); });

describe('shared focus candidate and Shadow DOM ownership', () => {
  it('resolves nested open ShadowRoots without treating the host as the active control', () => {
    const host = document.createElement('div');
    const outer = host.attachShadow({ mode: 'open' });
    const innerHost = document.createElement('div');
    const inner = innerHost.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    inner.append(button);
    outer.append(innerHost);
    document.body.append(host);
    button.focus();
    expect(getDeepActiveElement(document)).toBe(button);
    expect(isManagedFocusCandidate(button)).toBe(true);
  });

  it('treats closed ShadowRoots as opaque rather than guessing an active child', () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    const button = document.createElement('button');
    root.append(button);
    document.body.append(host);
    button.focus();
    expect(getDeepActiveElement(document)).toBe(host);
  });

  it('recognizes ownership through nested open ShadowRoots', () => {
    const owner = document.createElement('section');
    const outerHost = document.createElement('div');
    const outerRoot = outerHost.attachShadow({ mode: 'open' });
    const innerHost = document.createElement('div');
    const innerRoot = innerHost.attachShadow({ mode: 'open' });
    const focused = document.createElement('button');
    const outside = document.createElement('button');
    innerRoot.append(focused);
    outerRoot.append(innerHost);
    owner.append(outerHost);
    document.body.append(owner, outside);
    focused.focus();

    expect(getDeepActiveElement(document)).toBe(focused);
    expect(owner.contains(focused)).toBe(false);
    expect(isWithinComposedSubtree(owner, focused)).toBe(true);
    expect(isWithinComposedSubtree(outerHost, focused)).toBe(true);
    expect(isWithinComposedSubtree(innerHost, focused)).toBe(true);
    expect(isWithinComposedSubtree(outside, focused)).toBe(false);
    expect(isWithinComposedSubtree(owner, outside)).toBe(false);
  });

  it('treats a closed shadow host as the observable owner', () => {
    const owner = document.createElement('section');
    const host = document.createElement('div');
    const closed = host.attachShadow({ mode: 'closed' });
    const button = document.createElement('button');
    closed.append(button);
    owner.append(host);
    document.body.append(owner);
    button.focus();

    expect(getDeepActiveElement(document)).toBe(host);
    expect(isWithinComposedSubtree(owner, getDeepActiveElement(document))).toBe(true);
    expect(isWithinComposedSubtree(null, host)).toBe(false);
    expect(isWithinComposedSubtree(owner, null)).toBe(false);
  });

  it('rejects CSS-hidden, inert and aria-disabled hosts across a shadow boundary', () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    root.append(button);
    document.body.append(host);
    expect(isManagedFocusCandidate(button)).toBe(true);
    host.style.display = 'none';
    expect(isManagedFocusCandidate(button)).toBe(false);
    host.style.display = '';
    host.style.visibility = 'hidden';
    expect(isManagedFocusCandidate(button)).toBe(false);
    host.style.visibility = '';
    host.setAttribute('inert', '');
    expect(isManagedFocusCandidate(button)).toBe(false);
    host.removeAttribute('inert');
    host.setAttribute('aria-disabled', 'true');
    expect(isManagedFocusCandidate(button)).toBe(false);
    host.removeAttribute('aria-disabled');
    expect(isManagedFocusCandidate(button)).toBe(true);
  });

  it('rejects disabled fieldsets and disconnected targets', () => {
    const fieldset = document.createElement('fieldset');
    const button = document.createElement('button');
    fieldset.append(button);
    document.body.append(fieldset);
    expect(isManagedFocusCandidate(button)).toBe(true);
    fieldset.disabled = true;
    expect(isManagedFocusCandidate(button)).toBe(false);
    fieldset.disabled = false;
    fieldset.remove();
    expect(isManagedFocusCandidate(button)).toBe(false);
  });
});
