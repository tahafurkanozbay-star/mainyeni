import { createFormFieldModel, type FieldValidator } from './formFieldModel';

const error = (code: string, message: string) => ({ code, message, severity: 'error' as const });
const warning = (code: string, message: string) => ({ code, message, severity: 'warning' as const });

describe('formFieldModel', () => {
  test('starts with immutable deterministic state', () => {
    const model = createFormFieldModel({ id: 'address', label: 'Adres', initialValue: 'Ankara' });
    const state = model.getState();
    expect(state.value).toBe('Ankara');
    expect(state.dirty).toBe(false);
    expect(state.status).toBe('idle');
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.issues)).toBe(true);
  });

  test('tracks dirty and touched independently', async () => {
    const model = createFormFieldModel({ id: 'name', label: 'Ad', initialValue: 'A' });
    await model.setValue('B');
    expect(model.getState().dirty).toBe(true);
    expect(model.getState().touched).toBe(false);
    model.focus();
    await model.blur();
    expect(model.getState().touched).toBe(true);
  });

  test('exposes required validation through accessible metadata', async () => {
    const model = createFormFieldModel({ id: 'district', label: 'İlçe', required: true });
    const state = await model.validate();
    expect(state.status).toBe('invalid');
    expect(state.ariaInvalid).toBe(true);
    expect(state.errorMessage).toBe('İlçe zorunludur.');
    expect(state.describedBy).toEqual(['district-error']);
  });

  test('validates on blur when configured', async () => {
    const validator: FieldValidator = ({ value }) => value.length < 3 ? error('short', 'En az üç karakter girin.') : null;
    const model = createFormFieldModel({ id: 'query', label: 'Arama', validators: [validator], validateOn: ['blur'] });
    await model.setValue('ab');
    expect(model.getState().status).toBe('idle');
    model.focus();
    const state = await model.blur();
    expect(state.status).toBe('invalid');
    expect(state.errorMessage).toBe('En az üç karakter girin.');
  });

  test('validates on change when configured', async () => {
    const validator: FieldValidator = ({ value }) => value === 'ok' ? null : error('value', 'Değer uygun değil.');
    const model = createFormFieldModel({ id: 'code', label: 'Kod', validators: [validator], validateOn: ['change'] });
    expect((await model.setValue('no')).status).toBe('invalid');
    expect((await model.setValue('ok')).status).toBe('valid');
  });

  test('keeps warnings distinct from errors', async () => {
    const model = createFormFieldModel({ id: 'note', label: 'Not', validators: [() => warning('long', 'Bu değer uzun olabilir.')] });
    const state = await model.validate();
    expect(state.status).toBe('valid');
    expect(state.ariaInvalid).toBe(false);
    expect(state.warningMessage).toBe('Bu değer uzun olabilir.');
    expect(state.describedBy).toEqual(['note-warning']);
  });

  test('deduplicates repeated issues', async () => {
    const issue = error('same', 'Aynı hata');
    const model = createFormFieldModel({ id: 'x', label: 'X', validators: [() => [issue, issue], () => issue] });
    expect((await model.validate()).issues).toHaveLength(1);
  });

  test('bounds issue collections', async () => {
    const model = createFormFieldModel({ id: 'x', label: 'X', validators: [() => Array.from({ length: 30 }, (_, index) => error(`e${index}`, `Hata ${index}`))] });
    expect((await model.validate()).issues).toHaveLength(12);
  });

  test('bounds user controlled value length', async () => {
    const model = createFormFieldModel({ id: 'x', label: 'X', maxLength: 5 });
    await model.setValue('123456789');
    expect(model.getState().value).toBe('12345');
  });

  test('ignores writes while disabled', async () => {
    const model = createFormFieldModel({ id: 'x', label: 'X', initialValue: 'a', disabled: true });
    await model.setValue('b');
    expect(model.getState().value).toBe('a');
    expect(model.focus().focused).toBe(false);
  });

  test('ignores writes while read only but permits focus', async () => {
    const model = createFormFieldModel({ id: 'x', label: 'X', initialValue: 'a', readOnly: true });
    await model.setValue('b');
    expect(model.getState().value).toBe('a');
    expect(model.focus().focused).toBe(true);
  });

  test('reset clears interaction and validation state', async () => {
    const model = createFormFieldModel({ id: 'x', label: 'X', initialValue: 'a', required: true });
    await model.setValue('');
    model.focus();
    await model.blur();
    const state = model.reset();
    expect(state.value).toBe('a');
    expect(state.dirty).toBe(false);
    expect(state.touched).toBe(false);
    expect(state.focused).toBe(false);
    expect(state.status).toBe('idle');
    expect(state.issues).toHaveLength(0);
  });

  test('reset can establish a new clean baseline', async () => {
    const model = createFormFieldModel({ id: 'x', label: 'X', initialValue: 'a' });
    await model.setValue('b');
    const state = model.reset('c');
    expect(state.value).toBe('c');
    expect(state.initialValue).toBe('c');
    expect(state.dirty).toBe(false);
  });

  test('disabled transition clears stale errors and focus', async () => {
    const model = createFormFieldModel({ id: 'x', label: 'X', required: true });
    model.focus();
    await model.validate();
    const state = model.setDisabled(true);
    expect(state.focused).toBe(false);
    expect(state.status).toBe('idle');
    expect(state.issues).toHaveLength(0);
    expect(state.ariaInvalid).toBe(false);
  });

  test('read only state can be toggled without losing value', async () => {
    const model = createFormFieldModel({ id: 'x', label: 'X', initialValue: 'a' });
    model.setReadOnly(true);
    await model.setValue('b');
    expect(model.getState().value).toBe('a');
    model.setReadOnly(false);
    await model.setValue('b');
    expect(model.getState().value).toBe('b');
  });

  test('passes trigger and value to validators', async () => {
    const seen: string[] = [];
    const validator: FieldValidator = ({ value, trigger }) => { seen.push(`${trigger}:${value}`); return null; };
    const model = createFormFieldModel({ id: 'x', label: 'X', validators: [validator] });
    await model.setValue('abc');
    await model.validate('submit');
    expect(seen).toEqual(['submit:abc']);
  });

  test('converts validator exceptions into field errors', async () => {
    const model = createFormFieldModel({ id: 'x', label: 'X', validators: [() => { throw new Error('Servis doğrulaması başarısız'); }] });
    const state = await model.validate();
    expect(state.status).toBe('invalid');
    expect(state.errorMessage).toBe('Servis doğrulaması başarısız');
  });

  test('suppresses stale asynchronous validation results', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const validator: FieldValidator = async ({ value }) => { await gate; return value === 'old' ? error('stale', 'Eski sonuç') : null; };
    const model = createFormFieldModel({ id: 'x', label: 'X', validators: [validator], validateOn: ['change'] });
    const first = model.setValue('old');
    const second = model.setValue('new');
    release?.();
    await Promise.all([first, second]);
    expect(model.getState().value).toBe('new');
    expect(model.getState().errorMessage).toBeNull();
  });

  test('aborts previous validation signal when value changes', async () => {
    let signal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const validator: FieldValidator = async (context) => { signal = context.signal; await gate; return null; };
    const model = createFormFieldModel({ id: 'x', label: 'X', validators: [validator] });
    const pending = model.validate();
    await Promise.resolve();
    await model.setValue('new');
    expect(signal?.aborted).toBe(true);
    release?.();
    await pending;
  });

  test('dispose aborts active work and prevents later writes', async () => {
    let signal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const validator: FieldValidator = async (context) => { signal = context.signal; await gate; return null; };
    const model = createFormFieldModel({ id: 'x', label: 'X', validators: [validator], initialValue: 'a' });
    const pending = model.validate();
    await Promise.resolve();
    model.dispose();
    expect(signal?.aborted).toBe(true);
    await model.setValue('b');
    expect(model.getState().value).toBe('a');
    release?.();
    await pending;
  });

  test('rejects missing id and label', () => {
    expect(() => createFormFieldModel({ id: '', label: 'X' })).toThrow(/id is required/);
    expect(() => createFormFieldModel({ id: 'x', label: '' })).toThrow(/label is required/);
  });
});
