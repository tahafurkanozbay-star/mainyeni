import { describe, expect, it, vi } from 'vitest';
import {
  createFormValidationRuntime,
  minLength,
  numberRange,
  required,
  type FieldValidator,
} from './formValidationRuntime';

describe('formValidationRuntime', () => {
  it('rejects empty definitions and duplicate names', () => {
    expect(() => createFormValidationRuntime([])).toThrow('At least one field');
    expect(() => createFormValidationRuntime([
      { name: 'query', label: 'Arama' },
      { name: 'query', label: 'Arama tekrar' },
    ])).toThrow('Duplicate field');
  });

  it('tracks values, dirty state and touch state without mutating initial values', () => {
    const runtime = createFormValidationRuntime(
      [{ name: 'address', label: 'Adres' }],
      { address: 'Kızılay' },
    );
    expect(runtime.getField('address')).toMatchObject({ value: 'Kızılay', dirty: false, touched: false });
    runtime.setValue('address', 'Ulus');
    expect(runtime.getField('address')).toMatchObject({ value: 'Ulus', initialValue: 'Kızılay', dirty: true });
    runtime.touch('address');
    expect(runtime.getField('address').touched).toBe(true);
    runtime.reset();
    expect(runtime.getField('address')).toMatchObject({ value: 'Kızılay', dirty: false, touched: false, issues: [] });
  });

  it('keeps disabled and read-only values immutable', () => {
    const runtime = createFormValidationRuntime(
      [
        { name: 'district', label: 'İlçe', disabled: true },
        { name: 'objectId', label: 'Kimlik', readOnly: true },
      ],
      { district: 'Çankaya', objectId: 42 },
    );
    runtime.setValue('district', 'Keçiören');
    runtime.setValue('objectId', 99);
    expect(runtime.getValues()).toEqual({ district: 'Çankaya', objectId: 42 });
  });

  it('validates required text while accepting boolean false and numeric zero', async () => {
    const runtime = createFormValidationRuntime([
      { name: 'query', label: 'Arama', validators: [required()] },
      { name: 'visible', label: 'Görünür', validators: [required()] },
      { name: 'level', label: 'Seviye', validators: [required()] },
    ], { query: '   ', visible: false, level: 0 });
    expect((await runtime.validateField('query')).invalid).toBe(true);
    expect((await runtime.validateField('visible')).invalid).toBe(false);
    expect((await runtime.validateField('level')).invalid).toBe(false);
  });

  it('validates minimum text length and ignores optional empty values', async () => {
    const runtime = createFormValidationRuntime([
      { name: 'search', label: 'Arama', validators: [minLength(3)] },
    ], { search: '' });
    expect((await runtime.validateField('search')).invalid).toBe(false);
    runtime.setValue('search', 'ab');
    expect((await runtime.validateField('search')).issues[0]?.code).toBe('minLength');
    runtime.setValue('search', 'abc');
    expect((await runtime.validateField('search')).invalid).toBe(false);
  });

  it('validates finite numeric ranges', async () => {
    const runtime = createFormValidationRuntime([
      { name: 'opacity', label: 'Saydamlık', validators: [numberRange(0, 1)] },
    ], { opacity: 2 });
    expect((await runtime.validateField('opacity')).issues[0]?.code).toBe('max');
    runtime.setValue('opacity', -1);
    expect((await runtime.validateField('opacity')).issues[0]?.code).toBe('min');
    runtime.setValue('opacity', Number.NaN);
    expect((await runtime.validateField('opacity')).issues[0]?.code).toBe('type');
    runtime.setValue('opacity', 0.5);
    expect((await runtime.validateField('opacity')).invalid).toBe(false);
  });

  it('rejects invalid validator configuration eagerly', () => {
    expect(() => minLength(-1)).toThrow(RangeError);
    expect(() => numberRange(10, 1)).toThrow(RangeError);
  });

  it('preserves warnings without making a field invalid', async () => {
    const warning: FieldValidator = () => ({ code: 'precision', message: 'Yaklaşık sonuç', severity: 'warning' });
    const runtime = createFormValidationRuntime([{ name: 'location', label: 'Konum', validators: [warning] }]);
    const state = await runtime.validateField('location');
    expect(state.issues).toHaveLength(1);
    expect(state.invalid).toBe(false);
  });

  it('reports first invalid enabled field in declaration order', async () => {
    const runtime = createFormValidationRuntime([
      { name: 'name', label: 'Ad', validators: [required()] },
      { name: 'disabled', label: 'Devre dışı', validators: [required()], disabled: true },
      { name: 'district', label: 'İlçe', validators: [required()] },
    ]);
    const result = await runtime.validateAll();
    expect(result).toEqual({ valid: false, firstInvalid: 'name' });
  });

  it('passes a coherent cross-field value snapshot to validators', async () => {
    const validator = vi.fn<FieldValidator>(({ value, values }) =>
      value === values.confirm ? null : { code: 'mismatch', message: 'Değerler eşleşmiyor.' },
    );
    const runtime = createFormValidationRuntime([
      { name: 'source', label: 'Kaynak', validators: [validator] },
      { name: 'confirm', label: 'Onay' },
    ], { source: 'A', confirm: 'B' });
    expect((await runtime.validateField('source')).invalid).toBe(true);
    runtime.setValue('confirm', 'A');
    expect((await runtime.validateField('source')).invalid).toBe(false);
    expect(validator).toHaveBeenCalledTimes(2);
  });

  it('passes validation trigger and AbortSignal to validators', async () => {
    const validator = vi.fn<FieldValidator>(({ trigger, signal }) => {
      expect(trigger).toBe('blur');
      expect(signal.aborted).toBe(false);
      return null;
    });
    const runtime = createFormValidationRuntime([{ name: 'query', label: 'Arama', validators: [validator] }]);
    await runtime.validateField('query', 'blur');
    expect(validator).toHaveBeenCalledOnce();
  });

  it('normalizes arrays of issues and defaults severity to error', async () => {
    const runtime = createFormValidationRuntime([{
      name: 'geometry',
      label: 'Geometri',
      validators: [() => [
        { code: 'empty', message: 'Geometri boş.' },
        { code: 'projection', message: 'Projeksiyon kontrol edilmeli.', severity: 'warning' },
      ]],
    }]);
    const state = await runtime.validateField('geometry');
    expect(state.issues).toEqual([
      { code: 'empty', message: 'Geometri boş.', severity: 'error' },
      { code: 'projection', message: 'Projeksiyon kontrol edilmeli.', severity: 'warning' },
    ]);
    expect(state.invalid).toBe(true);
  });

  it('converts unexpected validator failures into a user-safe validation issue', async () => {
    const runtime = createFormValidationRuntime([{
      name: 'service',
      label: 'Servis',
      validators: [() => { throw new Error('internal detail'); }],
    }]);
    const state = await runtime.validateField('service');
    expect(state.issues).toEqual([{ code: 'validation', message: 'Doğrulama tamamlanamadı.', severity: 'error' }]);
  });

  it('suppresses stale asynchronous validation results', async () => {
    let resolveFirst: ((value: { code: string; message: string } | null) => void) | undefined;
    const slow: FieldValidator = ({ value }) => value === 'old'
      ? new Promise((resolve) => { resolveFirst = resolve; })
      : null;
    const runtime = createFormValidationRuntime([{ name: 'query', label: 'Arama', validators: [slow] }], { query: 'old' });
    const first = runtime.validateField('query');
    runtime.setValue('query', 'new');
    const second = runtime.validateField('query');
    resolveFirst?.({ code: 'stale', message: 'Eski sonuç' });
    await Promise.all([first, second]);
    expect(runtime.getField('query').issues).toEqual([]);
  });

  it('aborts the previous validator signal when validation restarts', async () => {
    let firstSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const validator: FieldValidator = ({ signal }) => {
      if (!firstSignal) {
        firstSignal = signal;
        return new Promise((resolve) => { release = () => resolve(null); });
      }
      return null;
    };
    const runtime = createFormValidationRuntime([{ name: 'query', label: 'Arama', validators: [validator] }]);
    const first = runtime.validateField('query');
    const second = runtime.validateField('query');
    expect(firstSignal?.aborted).toBe(true);
    release?.();
    await Promise.all([first, second]);
  });

  it('aborts pending validation during reset and clears transient state', async () => {
    let signal: AbortSignal | undefined;
    const validator: FieldValidator = ({ signal: nextSignal }) => {
      signal = nextSignal;
      return new Promise(() => undefined);
    };
    const runtime = createFormValidationRuntime([{ name: 'query', label: 'Arama', validators: [validator] }], { query: 'initial' });
    void runtime.validateField('query');
    expect(runtime.getField('query').validating).toBe(true);
    runtime.setValue('query', 'changed');
    runtime.touch('query');
    runtime.reset();
    expect(signal?.aborted).toBe(true);
    expect(runtime.getField('query')).toMatchObject({ value: 'initial', dirty: false, touched: false, validating: false, issues: [] });
  });

  it('aborts pending validation on dispose and rejects later operations', () => {
    let signal: AbortSignal | undefined;
    const validator: FieldValidator = ({ signal: nextSignal }) => {
      signal = nextSignal;
      return new Promise(() => undefined);
    };
    const runtime = createFormValidationRuntime([{ name: 'query', label: 'Arama', validators: [validator] }]);
    void runtime.validateField('query');
    runtime.dispose();
    expect(signal?.aborted).toBe(true);
    expect(() => runtime.getValues()).toThrow('disposed');
  });

  it('throws for unknown field names', () => {
    const runtime = createFormValidationRuntime([{ name: 'query', label: 'Arama' }]);
    expect(() => runtime.getField('missing')).toThrow('Unknown field');
    expect(() => runtime.setValue('missing', 'x')).toThrow('Unknown field');
  });
});
