import { describe, expect, it, vi } from 'vitest';
import { createFormValidationModel } from './formValidationModel';

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('formValidationModel', () => {
  it('tracks registration, dirty state, touch state and reset deterministically', async () => {
    const model = createFormValidationModel();
    const unregister = model.register({ id: 'name', label: 'Ad', required: true }, 'Ada');

    expect(model.snapshot().fieldOrder).toEqual(['name']);
    expect(model.snapshot().fields.name).toMatchObject({
      value: 'Ada', dirty: false, touched: false, status: 'idle', required: true,
    });

    model.setValue('name', 'Grace');
    expect(model.snapshot().fields.name).toMatchObject({ value: 'Grace', dirty: true, status: 'idle' });
    expect(await model.blur('name')).toBe(true);
    expect(model.snapshot().fields.name).toMatchObject({ touched: true, status: 'valid', issue: null });

    model.reset();
    expect(model.snapshot().fields.name).toMatchObject({
      value: 'Ada', dirty: false, touched: false, status: 'idle', issue: null,
    });

    unregister();
    expect(model.snapshot().fieldOrder).toEqual([]);
  });

  it('normalizes required failures for blank strings and empty arrays', async () => {
    const model = createFormValidationModel({ mode: 'submit' });
    model.register({ id: 'title', label: 'Başlık', required: true }, '   ');
    model.register({ id: 'layers', label: 'Katmanlar', required: true }, [] as string[]);

    expect(await model.validateAll()).toBe(false);
    const snapshot = model.snapshot();
    expect(snapshot.invalidFieldIds).toEqual(['title', 'layers']);
    expect(snapshot.firstInvalidFieldId).toBe('title');
    expect(snapshot.fields.title?.issue).toEqual({ code: 'required', message: 'Başlık alanı zorunludur.' });
    expect(snapshot.fields.layers?.issue).toEqual({ code: 'required', message: 'Katmanlar alanı zorunludur.' });
    expect(snapshot.announcement).toBe('2 alanda düzeltme gerekiyor.');
  });

  it('supports asynchronous validators and exposes validating state', async () => {
    let resolveValidation: ((issue: null) => void) | undefined;
    const model = createFormValidationModel();
    model.register({
      id: 'parcel',
      label: 'Parsel',
      validate: () => new Promise<null>((resolve) => { resolveValidation = resolve; }),
    }, '42');

    const pending = model.validate('parcel');
    expect(model.snapshot().fields.parcel?.status).toBe('validating');
    expect(model.snapshot().valid).toBe(false);
    resolveValidation?.(null);
    expect(await pending).toBe(true);
    expect(model.snapshot().fields.parcel?.status).toBe('valid');
  });

  it('cancels stale async validation when a field value changes', async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(issue: { code: string; message: string } | null) => void> = [];
    const model = createFormValidationModel();
    model.register({
      id: 'address',
      label: 'Adres',
      validate: (_value, signal) => {
        signals.push(signal);
        return new Promise((resolve) => resolvers.push(resolve));
      },
    }, 'A');

    const first = model.validate('address');
    model.setValue('address', 'B');
    expect(signals[0]?.aborted).toBe(true);
    resolvers[0]?.({ code: 'stale', message: 'Eski sonuç' });
    expect(await first).toBe(false);
    expect(model.snapshot().fields.address).toMatchObject({ value: 'B', status: 'idle', issue: null });
  });

  it('prevents stale validators from overwriting a newer validation result', async () => {
    const resolvers: Array<(issue: { code: string; message: string } | null) => void> = [];
    const model = createFormValidationModel();
    model.register({
      id: 'query',
      label: 'Sorgu',
      validate: () => new Promise((resolve) => resolvers.push(resolve)),
    }, 'first');

    const first = model.validate('query');
    model.setValue('query', 'second');
    const second = model.validate('query');
    resolvers[1]?.(null);
    expect(await second).toBe(true);
    resolvers[0]?.({ code: 'old', message: 'Eski hata' });
    expect(await first).toBe(false);
    expect(model.snapshot().fields.query).toMatchObject({ value: 'second', status: 'valid', issue: null });
  });

  it('maps validator exceptions to a safe user-facing issue and reports diagnostics', async () => {
    const errors: unknown[] = [];
    const model = createFormValidationModel({ onObserverError: (error) => errors.push(error) });
    model.register({
      id: 'district',
      label: 'İlçe',
      validate: async () => { throw new Error('sensitive backend detail'); },
    }, 'Çankaya');

    expect(await model.validate('district')).toBe(false);
    expect(errors).toHaveLength(1);
    expect(model.snapshot().fields.district?.issue).toEqual({
      code: 'validation-unavailable',
      message: 'İlçe alanı şu anda doğrulanamadı. Lütfen tekrar deneyin.',
    });
  });

  it('validates all fields before entering submit state and announces failures', async () => {
    const model = createFormValidationModel({ mode: 'submit' });
    model.register({ id: 'name', label: 'Ad', required: true }, '');
    model.register({ id: 'note', label: 'Not' }, 'hazır');

    expect(await model.beginSubmit()).toBe(false);
    expect(model.snapshot()).toMatchObject({ submitting: false, submitCount: 1, firstInvalidFieldId: 'name' });
    expect(model.snapshot().fields.name?.touched).toBe(true);

    model.setValue('name', 'Ada');
    expect(await model.beginSubmit()).toBe(true);
    expect(model.snapshot()).toMatchObject({ submitting: true, submitCount: 2, announcement: 'Form gönderiliyor.' });
    model.endSubmit();
    expect(model.snapshot()).toMatchObject({ submitting: false, announcement: 'Form gönderimi tamamlandı.' });
  });

  it('does not start a second submit while a valid submission is active', async () => {
    const model = createFormValidationModel();
    model.register({ id: 'name', label: 'Ad', required: true }, 'Ada');
    expect(await model.beginSubmit()).toBe(true);
    expect(await model.beginSubmit()).toBe(false);
    expect(model.snapshot().submitCount).toBe(1);
  });

  it('validates on change when configured without blocking synchronous state updates', async () => {
    const validator = vi.fn(async (value: string) => value.length < 3
      ? { code: 'short', message: 'En az 3 karakter girin.' }
      : null);
    const model = createFormValidationModel({ mode: 'change' });
    model.register({ id: 'search', label: 'Arama', validate: validator }, 'abc');

    model.setValue('search', 'x');
    expect(model.snapshot().fields.search?.value).toBe('x');
    await tick();
    expect(validator).toHaveBeenCalledWith('x', expect.any(AbortSignal));
    expect(model.snapshot().fields.search?.issue).toEqual({ code: 'short', message: 'En az 3 karakter girin.' });
  });

  it('defers blur validation in submit-only mode', async () => {
    const validator = vi.fn(async () => ({ code: 'bad', message: 'Geçersiz.' }));
    const model = createFormValidationModel({ mode: 'submit' });
    model.register({ id: 'code', label: 'Kod', validate: validator }, 'x');

    expect(await model.blur('code')).toBe(true);
    expect(validator).not.toHaveBeenCalled();
    expect(model.snapshot().fields.code).toMatchObject({ touched: true, status: 'idle' });
    expect(await model.validateAll()).toBe(false);
    expect(validator).toHaveBeenCalledTimes(1);
  });

  it('isolates observer failures and keeps notifying healthy observers', () => {
    const errors: unknown[] = [];
    const model = createFormValidationModel({ onObserverError: (error) => errors.push(error) });
    model.subscribe(() => { throw new Error('observer failed'); });
    const healthy = vi.fn();
    model.subscribe(healthy);

    model.register({ id: 'name', label: 'Ad' }, 'Ada');
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(healthy).toHaveBeenCalled();
  });

  it('rejects duplicate and blank field identifiers', () => {
    const model = createFormValidationModel();
    model.register({ id: 'name', label: 'Ad' }, 'Ada');
    expect(() => model.register({ id: 'name', label: 'Başka' }, 'Grace')).toThrow(/zaten kayıtlı/);
    expect(() => model.register({ id: '   ', label: 'Boş' }, '')).toThrow(/boş olamaz/);
  });

  it('disposes validators and rejects further mutations', async () => {
    let signal: AbortSignal | undefined;
    const model = createFormValidationModel();
    model.register({
      id: 'slow',
      label: 'Yavaş',
      validate: (_value, nextSignal) => {
        signal = nextSignal;
        return new Promise<null>(() => undefined);
      },
    }, 'x');
    void model.validate('slow');
    model.dispose();
    expect(signal?.aborted).toBe(true);
    expect(() => model.setValue('slow', 'y')).toThrow(/dispose/);
  });
});
