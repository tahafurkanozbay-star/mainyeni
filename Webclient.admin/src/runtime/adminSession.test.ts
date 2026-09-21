import {
  ADMIN_SESSION_STORAGE_KEY,
  clearAdminSession,
  readAdminSession,
  writeAdminSession,
} from './adminSession';

describe('adminSession', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  test('stores valid bearer sessions only for the browser session', () => {
    const session = { accessToken: 'signed-token', userName: 'operator' };

    expect(writeAdminSession(session)).toBe(true);
    expect(localStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(ADMIN_SESSION_STORAGE_KEY) ?? 'null'))
      .toEqual(session);
    expect(readAdminSession()).toEqual(session);
  });

  test('purges legacy persistent localStorage sessions on read', () => {
    localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, 'legacy-session');

    expect(readAdminSession()).toBeNull();
    expect(localStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).toBeNull();
  });

  test('fails closed and removes malformed session payloads', () => {
    sessionStorage.setItem(ADMIN_SESSION_STORAGE_KEY, '{bad json');

    expect(readAdminSession()).toBeNull();
    expect(sessionStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).toBeNull();
  });

  test('rejects objects without a bearer token', () => {
    expect(writeAdminSession({ userName: 'operator' })).toBe(false);
    expect(sessionStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).toBeNull();
  });

  test('clear removes both session and legacy persistent copies', () => {
    sessionStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify({ accessToken: 'x' }));
    localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, 'legacy');

    clearAdminSession();

    expect(sessionStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).toBeNull();
  });

  test('returns an immutable snapshot instead of the mutable parsed object', () => {
    writeAdminSession({ accessToken: 'token', userName: 'operator' });
    const session = readAdminSession();

    expect(Object.isFrozen(session)).toBe(true);
  });
});
