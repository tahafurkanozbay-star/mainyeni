import { afterEach, describe, expect, it } from 'vitest';
import { getDeepActiveElement, isManagedFocusCandidate } from './focusCandidate';

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
