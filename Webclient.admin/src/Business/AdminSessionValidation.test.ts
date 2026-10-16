import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthBusiness } from './AuthBusiness';
import {
  isSafeBearerToken,
  isValidAdminSession,
  snapshotValidAdminSession,
} from './AdminSessionValidation';

afterEach(() => {
  AuthBusiness.SetSessionInLocalStorage(null);
});

describe('Admin bearer descriptor snapshot boundary', () => {
  it('accepts a well-formed session as a detached, frozen primitive snapshot', () => {
    const raw = { accessToken: 'signed-token', userName: 'operator', address: 'private' };
    const snapshot = snapshotValidAdminSession(raw);
    expect(snapshot).toEqual({ accessToken: 'signed-token', userName: 'operator' });
    expect(Object.isFrozen(snapshot)).toBe(true);
    raw.accessToken = 'replacement';
    expect(snapshot?.accessToken).toBe('signed-token');
    expect(snapshot).not.toHaveProperty('address');
  });

  it('never executes accessToken or userName accessors when checking a login response', () => {
    const tokenGetter = vi.fn(() => 'signed-token');
    const nameGetter = vi.fn(() => 'operator');
    const token = Object.defineProperty({}, 'accessToken', { get: tokenGetter });
    const name = Object.defineProperties({}, {
      accessToken: { value: 'signed-token', enumerable: true },
      userName: { get: nameGetter },
    });
    expect(snapshotValidAdminSession(token)).toBeNull();
    expect(snapshotValidAdminSession(name)).toBeNull();
    expect(tokenGetter).not.toHaveBeenCalled();
    expect(nameGetter).not.toHaveBeenCalled();
  });

  it('never reads a Proxy get trap after descriptor validation', async () => {
    const get = vi.fn((_target: object, key: string | symbol) =>
      key === 'accessToken' ? 'malicious\\r\\nInjected: yes' : 'unexpected');
    const source = new Proxy({ accessToken: 'verified-token', userName: 'operator' }, { get });
    expect(isValidAdminSession(source)).toBe(true);
    expect(AuthBusiness.SetSessionInLocalStorage(source)).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(await AuthBusiness.GetRequestHeaders()).toMatchObject({
      Authorization: 'Bearer verified-token',
    });
    expect(AuthBusiness.GetSessionFromLocalStorage()).toEqual({
      accessToken: 'verified-token', userName: 'operator',
    });
  });

  it('validates the descriptor value even if a Proxy get trap pretends to be safe', () => {
    const value = new Proxy({ accessToken: 'contains spaces' }, {
      get: () => 'verified-token',
    });
    expect(snapshotValidAdminSession(value)).toBeNull();
    expect(AuthBusiness.SetSessionInLocalStorage(value)).toBe(false);
    expect(AuthBusiness.GetSessionFromLocalStorage()).toBeNull();
  });

  it('fails closed when own-descriptor inspection throws', () => {
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() { throw new Error('untrusted trap'); },
    });
    expect(snapshotValidAdminSession(hostile)).toBeNull();
    expect(AuthBusiness.SetSessionInLocalStorage(hostile)).toBe(false);
  });

  it('fails closed for revoked Proxies without leaking a prior bearer', async () => {
    AuthBusiness.SetSessionInLocalStorage({ accessToken: 'old-token' });
    const candidate = Proxy.revocable({ accessToken: 'new-token' }, {});
    candidate.revoke();
    expect(snapshotValidAdminSession(candidate.proxy)).toBeNull();
    expect(AuthBusiness.SetSessionInLocalStorage(candidate.proxy)).toBe(false);
    expect(await AuthBusiness.GetRequestHeaders()).toBeNull();
  });

  it('rejects inherited token values, invalid userName and unexpected token characters', () => {
    const inherited = Object.create({ accessToken: 'inherited' }) as object;
    expect(snapshotValidAdminSession(inherited)).toBeNull();
    expect(snapshotValidAdminSession({ accessToken: 'valid', userName: 3 })).toBeNull();
    expect(snapshotValidAdminSession({ accessToken: 'valid', userName: 'x'.repeat(513) })).toBeNull();
    expect(isSafeBearerToken('a'.repeat(8193))).toBe(false);
    expect(isSafeBearerToken('signed-token')).toBe(true);
    expect(isSafeBearerToken('injected\nheader')).toBe(false);
  });

  it('does not persist validated bearer material to browser Web Storage', () => {
    sessionStorage.clear();
    localStorage.clear();
    expect(AuthBusiness.SetSessionInLocalStorage({ accessToken: 'verified-token' })).toBe(true);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
