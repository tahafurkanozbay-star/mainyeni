import { AuthBusiness } from './Business/AuthBusiness';
import { Constants } from './Core/Constants';

describe('admin authentication contract', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  test('stores valid bearer sessions only for the browser session', () => {
    const session = { accessToken: 'signed-token', userName: 'operator' };

    expect(AuthBusiness.SetSessionInLocalStorage(session)).toBe(true);
    expect(localStorage.getItem(Constants.Session.SessionObjectTitle)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(Constants.Session.SessionObjectTitle) ?? 'null'))
      .toEqual(session);
    expect(AuthBusiness.GetSessionFromLocalStorage()).toEqual(session);
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

  test('login posts FormData through bounded native fetch transport', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ isSuccess: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(AuthBusiness.LoginUser('admin@example.test', 'example-password'))
      .resolves.toEqual({ isSuccess: true });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/Auth\/Login$/u);
    expect(init?.body).toBeInstanceOf(FormData);
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('login returns null on transport failure without persisting credentials', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network unavailable'));

    await expect(AuthBusiness.LoginUser('admin@example.test', 'example-password'))
      .resolves.toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });
});
