const axiosPost = vi.hoisted(() => vi.fn());

vi.mock('axios', () => ({
  default: {
    post: axiosPost,
  },
}));

import { AuthBusiness } from './Business/AuthBusiness';
import { Constants } from './Core/Constants';

describe('admin authentication storage contract', () => {
  beforeEach(() => {
    AuthBusiness.SetSessionInLocalStorage(null);
    sessionStorage.clear();
    localStorage.clear();
    axiosPost.mockReset();
  });

  test('keeps a validated bearer only in volatile memory, not Web Storage', async () => {
    const session = { accessToken: 'signed-token', userName: 'operator' };

    expect(AuthBusiness.SetSessionInLocalStorage(session)).toBe(true);
    expect(localStorage.getItem(Constants.Session.SessionObjectTitle)).toBeNull();
    expect(sessionStorage.getItem(Constants.Session.SessionObjectTitle)).toBeNull();
    expect(AuthBusiness.GetSessionFromLocalStorage()).toEqual(session);
    expect(await AuthBusiness.GetRequestHeaders()).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Bearer signed-token',
    });
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  test('removes invalid session payloads', () => {
    sessionStorage.setItem(
      Constants.Session.SessionObjectTitle,
      JSON.stringify({ userName: 'operator' }),
    );

    expect(AuthBusiness.GetSessionFromLocalStorage()).toBeNull();
    expect(sessionStorage.getItem(Constants.Session.SessionObjectTitle)).toBeNull();
  });

  test('removes legacy persistent localStorage sessions', () => {
    localStorage.setItem(Constants.Session.SessionObjectTitle, 'legacy-encrypted-session');

    AuthBusiness.GetSessionFromLocalStorage();

    expect(localStorage.getItem(Constants.Session.SessionObjectTitle)).toBeNull();
  });


  test('never retains unrelated login response properties in the in-memory session', () => {
    const data = {
      accessToken: 'signed-token', userName: 'operator',
      password: 'must-not-be-preserved',
      profile: { address: 'sensitive' },
    };
    expect(AuthBusiness.SetSessionInLocalStorage(data)).toBe(true);
    expect(AuthBusiness.GetSessionFromLocalStorage()).toEqual({
      accessToken: 'signed-token',
      userName: 'operator',
    });
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  test('invalid bearer does not enter memory or browser persistence', async () => {
    for (const invalid of [
      { accessToken: '' },
      { accessToken: 'has spaces' },
      { accessToken: 'line\nbreak' },
      { accessToken: 'a'.repeat(8193) },
      { accessToken: null },
      { accessToken: 'okay', userName: 'a'.repeat(513) },
    ]) {
      expect(AuthBusiness.SetSessionInLocalStorage(invalid)).toBe(false);
      expect(AuthBusiness.GetSessionFromLocalStorage()).toBeNull();
      expect(await AuthBusiness.GetRequestHeaders()).toBeNull();
    }
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  test('purges formerly persisted valid-looking sessions without rehydrating them', () => {
    const legacy = JSON.stringify({ accessToken: 'old-bearer', userName: 'old' });
    localStorage.setItem(Constants.Session.SessionObjectTitle, legacy);
    sessionStorage.setItem(Constants.Session.SessionObjectTitle, legacy);
    expect(AuthBusiness.GetSessionFromLocalStorage()).toBeNull();
    expect(localStorage.getItem(Constants.Session.SessionObjectTitle)).toBeNull();
    expect(sessionStorage.getItem(Constants.Session.SessionObjectTitle)).toBeNull();
  });

  test('login posts credentials with a bounded timeout and returns response data', async () => {
    axiosPost.mockResolvedValue({ data: { isSuccess: true } });

    await expect(AuthBusiness.LoginUser('admin@example.test', 'example-password'))
      .resolves.toEqual({ isSuccess: true });

    expect(axiosPost).toHaveBeenCalledTimes(1);
    expect(axiosPost.mock.calls[0]?.[0]).toMatch(/\/Auth\/Login$/u);
    expect(axiosPost.mock.calls[0]?.[1]).toBeInstanceOf(FormData);
    expect(axiosPost.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ timeout: 15_000 }));
  });

  test('login returns null on transport failure without persisting credentials', async () => {
    axiosPost.mockRejectedValue(new Error('network unavailable'));

    await expect(AuthBusiness.LoginUser('admin@example.test', 'example-password'))
      .resolves.toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });
});
