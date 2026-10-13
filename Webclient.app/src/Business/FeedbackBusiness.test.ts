import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackBusiness } from './FeedbackBusiness';
const runtime = vi.hoisted(() => ({ headers: vi.fn(), post: vi.fn(), diagnostic: vi.fn() }));
vi.mock('./AuthBusiness', () => ({ AuthBusiness: { GetRequestHeaders: runtime.headers } }));
vi.mock('./HttpBusiness', () => ({ HttpBusiness: { Post: runtime.post } }));
vi.mock('../platform/runtime/runtimeDiagnostics', () => ({ runtimeDiagnostics: { captureError: runtime.diagnostic } }));
beforeEach(() => { vi.resetAllMocks(); runtime.headers.mockResolvedValue({ 'Content-Type': 'application/json' }); runtime.post.mockResolvedValue({ type: 10 }); });
describe('feedback JSON and request ownership', () => {
  it('keeps the existing endpoint/body and passes the owned signal to canonical POST transport', async () => {
    const signal = new AbortController().signal; const payload = { FullName: 'Test User', Country: 'Türkiye' };
    await expect(FeedbackBusiness.SendFeedBack(payload, { signal })).resolves.toEqual({ type: 10 });
    expect(runtime.post).toHaveBeenCalledWith(expect.stringMatching(/\/Feedback\/Save$/), payload, { headers: { 'Content-Type': 'application/json' }, signal });
  });
  it('never submits when cancelled before authentication finishes', async () => {
    const owner = new AbortController(); let finish: (headers: object) => void = () => undefined;
    runtime.headers.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const result = FeedbackBusiness.SendFeedBack({}, { signal: owner.signal }); owner.abort(); finish({});
    await expect(result).resolves.toBeNull(); expect(runtime.post).not.toHaveBeenCalled(); expect(runtime.diagnostic).not.toHaveBeenCalled();
  });
  it('preserves the nullable failure contract and reports only through canonical diagnostics', async () => {
    const error = new Error('transport failed'); runtime.post.mockRejectedValue(error);
    await expect(FeedbackBusiness.SendFeedBack({})).resolves.toBeNull(); expect(runtime.diagnostic).toHaveBeenCalledWith(error, { source: 'feedback-business.submit' }, 'warn');
  });
  it('isolates diagnostic reporter failure from the legacy return contract', async () => {
    runtime.post.mockRejectedValue(new Error('network')); runtime.diagnostic.mockImplementation(() => { throw new Error('reporter'); });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try { await expect(FeedbackBusiness.SendFeedBack({})).resolves.toBeNull(); expect(warning).toHaveBeenCalledWith('Feedback diagnostic reporting failed.'); } finally { warning.mockRestore(); }
  });
});
