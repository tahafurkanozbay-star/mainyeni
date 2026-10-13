import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FeedbackForm from './FeedbackForm';
const runtime = vi.hoisted(() => ({ send: vi.fn(), types: vi.fn() }));
vi.mock('../../../Business/FeedbackBusiness', () => ({ FeedbackBusiness: { SendFeedBack: runtime.send, GetFeedbackTypes: runtime.types } }));
const setup = () => { const close = vi.fn(); return { ...render(<FeedbackForm show closeWindow={close} />), close }; };
const fill = () => {
  for (const [name, value] of [['Ad Soyad', ' Test Kullanıcı '], ['Şehir', ' Ankara '], ['E-posta', ' qa@example.invalid '], ['Adres', ' Test adresi '], ['Açıklama', ' Harita test bildirimi ']]) fireEvent.change(screen.getByRole('textbox', { name: new RegExp(`^${name}`) }), { target: { value } });
};
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Gönder', exact: true }));
beforeEach(() => { vi.resetAllMocks(); runtime.types.mockReturnValue([{ id: 1, name: 'Görüş ve tavsiye' }, { id: 2, name: 'Adres sorunu' }]); runtime.send.mockResolvedValue({ Type: 10, IsSuccess: true }); });
afterEach(() => vi.useRealTimers());
describe('feedback form contract and usability', () => {
  it('names all real required fields and initializes the server country contract', () => {
    setup(); expect(screen.getByRole('textbox', { name: /^Ülke/ })).toHaveValue('Türkiye');
    expect(screen.getByRole('textbox', { name: /^Ad Soyad/ })).toBeRequired(); expect(screen.queryByText('Güvenlik metni')).toBeNull();
  });
  it('focuses the first invalid field and exposes inline errors without sending', () => {
    setup(); submit(); expect(runtime.send).not.toHaveBeenCalled();
    const name = screen.getByRole('textbox', { name: /^Ad Soyad/ }); expect(name).toHaveFocus(); expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Zorunlu alanları kontrol edin'); expect(screen.getByText('Ad Soyad alanını doldurun.')).toBeVisible();
  });
  it('validates email while retaining the draft and gives that field focus', () => {
    setup(); fill(); fireEvent.change(screen.getByRole('textbox', { name: /^E-posta/ }), { target: { value: 'not-an-email' } }); submit();
    expect(screen.getByRole('textbox', { name: /^E-posta/ })).toHaveFocus(); expect(screen.getByText('Geçerli bir e-posta adresi girin.')).toBeVisible(); expect(runtime.send).not.toHaveBeenCalled();
  });
  it('uses native form submission and a trimmed JSON body with a numeric type', async () => {
    setup(); fill(); fireEvent.submit(screen.getByRole('textbox', { name: /^Ad Soyad/ }).closest('form')!);
    await screen.findByText('Başvurunuz gönderildi');
    expect(runtime.send).toHaveBeenCalledWith({ FeedbackType: 1, FullName: 'Test Kullanıcı', Country: 'Türkiye', City: 'Ankara', Email: 'qa@example.invalid', Address: 'Test adresi', Description: 'Harita test bildirimi' }, { signal: expect.any(AbortSignal) });
  });
  it('coalesces repeated submit events and locks every editable field during sending', async () => {
    runtime.send.mockImplementation(() => new Promise(() => undefined)); const { unmount } = setup(); fill();
    const form = screen.getByRole('textbox', { name: /^Ad Soyad/ }).closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form); await waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('textbox', { name: /^Ad Soyad/ })).toBeDisabled(); expect(screen.getByRole('radio', { name: 'Görüş ve tavsiye' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Vazgeç' })).toBeEnabled(); unmount();
  });
  it('keeps an acknowledged outcome visible until the user closes it', async () => {
    const { close } = setup(); fill(); submit(); await screen.findByText('Başvurunuz gönderildi');
    expect(screen.queryByRole('button', { name: 'Gönder', exact: true })).toBeNull(); expect(close).not.toHaveBeenCalled();
    vi.useFakeTimers(); await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Kapat', exact: true })); expect(close).toHaveBeenCalledTimes(1);
  });
  it.each([null, {}, [], true, 'success', { Type: 20 }, { type: 20 }, { Type: [10] }, { Type: {} }, { isSuccess: true }, { Type: 10, IsSuccess: false }, { type: 10, Type: 20 }, { type: 10, isSuccess: 'false' }, { type: 10, isSuccess: null }, { type: 10, isSuccess: true, IsSuccess: false }])('never mistakes an unconfirmed response for success: %j', async result => {
    runtime.send.mockResolvedValue(result); setup(); fill(); submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('kaydedildiği doğrulanamadı'); expect(screen.queryByText('Başvurunuz gönderildi')).toBeNull();
    expect(screen.getByRole('textbox', { name: /^Ad Soyad/ })).toHaveValue(' Test Kullanıcı ');
  });
  it('accepts the server camel-case service result', async () => { runtime.send.mockResolvedValue({ type: 10, isSuccess: true }); setup(); fill(); submit(); expect(await screen.findByText('Başvurunuz gönderildi')).toBeVisible(); });
  it('does not reflect private upstream error text into the dialog', async () => {
    runtime.send.mockRejectedValue(new Error('private server details')); setup(); fill(); submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Gönderim sonucu doğrulanamadı'); expect(screen.queryByText('private server details')).toBeNull();
  });
  it('bounds a stalled send without retrying the non-idempotent POST', async () => {
    runtime.send.mockImplementation(() => new Promise(() => undefined)); setup(); fill(); vi.useFakeTimers(); submit();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    expect(screen.getByRole('alert')).toHaveTextContent('Gönderim sonucu doğrulanamadı'); expect(runtime.send).toHaveBeenCalledTimes(1); expect(screen.getByRole('button', { name: 'Gönder', exact: true })).toBeEnabled();
  });
  it('aborts on close and keeps a late acknowledgement from replacing a reopened form', async () => {
    let finish: (result: unknown) => void = () => undefined; runtime.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { close, rerender } = setup(); fill(); submit(); await waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(1));
    const signal = runtime.send.mock.calls[0][1].signal as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'Vazgeç' })); expect(signal.aborted).toBe(true);
    rerender(<FeedbackForm show={false} closeWindow={close} />); rerender(<FeedbackForm show closeWindow={close} />);
    await act(async () => { finish({ Type: 10 }); }); expect(screen.queryByText('Başvurunuz gönderildi')).toBeNull(); expect(screen.getByRole('button', { name: 'Gönder', exact: true })).toBeEnabled();
  });
});
