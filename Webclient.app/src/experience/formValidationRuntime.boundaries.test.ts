import { describe, expect, it, vi } from 'vitest';
import { createFormValidationRuntime, required, type FieldValidator } from './formValidationRuntime';

describe('formValidationRuntime lifecycle boundaries', () => {
  it('does not validate disabled fields during whole-form validation', async () => {
    const disabledValidator = vi.fn<FieldValidator>(() => ({ code: 'required', message: 'Zorunlu' }));
    const runtime = createFormValidationRuntime([
      { name: 'disabled', label: 'Devre dışı', disabled: true, validators: [disabledValidator] },
      { name: 'active', label: 'Etkin', validators: [required()] },
    ]);
    const result = await runtime.validateAll('submit');
    expect(disabledValidator).not.toHaveBeenCalled();
    expect(result).toEqual({ valid: false, firstInvalid: 'active' });
  });

  it('keeps declaration order deterministic when validators finish out of order', async () => {
    let releaseFirst: (() => void) | undefined;
    const delayed: FieldValidator = () => new Promise((resolve) => {
      releaseFirst = () => resolve({ code: 'first', message: 'İlk alan geçersiz.' });
    });
    const runtime = createFormValidationRuntime([
      { name: 'first', label: 'İlk', validators: [delayed] },
      { name: 'second', label: 'İkinci', validators: [required()] },
    ]);
    const pending = runtime.validateAll();
    await Promise.resolve();
    releaseFirst?.();
    const result = await pending;
    expect(result.firstInvalid).toBe('first');
  });

  it('uses an immutable-by-convention snapshot for each validator pass', async () => {
    const observed: Array<Readonly<Record<string, unknown>>> = [];
    const capture: FieldValidator = ({ values }) => {
      observed.push(values);
      return null;
    };
    const runtime = createFormValidationRuntime([
      { name: 'query', label: 'Arama', validators: [capture] },
      { name: 'district', label: 'İlçe' },
    ], { query: 'park', district: 'Çankaya' });
    await runtime.validateField('query');
    runtime.setValue('district', 'Altındağ');
    await runtime.validateField('query');
    expect(observed).toEqual([
      { query: 'park', district: 'Çankaya' },
      { query: 'park', district: 'Altındağ' },
    ]);
    expect(observed[0]).not.toBe(observed[1]);
  });

  it('is safe to reset repeatedly after completed validation', async () => {
    const runtime = createFormValidationRuntime([
      { name: 'query', label: 'Arama', validators: [required()] },
    ], { query: '' });
    expect((await runtime.validateField('query')).invalid).toBe(true);
    runtime.reset();
    runtime.reset();
    expect(runtime.getField('query')).toMatchObject({ dirty: false, touched: false, validating: false, issues: [] });
  });

  it('does not let read-only fields drift during programmatic setValue calls', () => {
    const runtime = createFormValidationRuntime([
      { name: 'objectId', label: 'Nesne kimliği', readOnly: true },
    ], { objectId: 7 });
    for (const value of [8, 9, 10]) runtime.setValue('objectId', value);
    expect(runtime.getField('objectId')).toMatchObject({ value: 7, dirty: false });
  });
});
