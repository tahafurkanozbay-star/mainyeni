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
    sessionStorage.clear();
    localStorage.clear();
    axiosPost.mockReset();
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
