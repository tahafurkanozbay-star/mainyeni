// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFormAccessibilityController } from './formAccessibilityController';
import { createFormValidationModel } from './formValidationModel';

interface Harness {
  readonly form: HTMLFormElement;
  readonly name: HTMLInputElement;
  readonly district: HTMLSelectElement;
  readonly nameError: HTMLElement;
  readonly nameHint: HTMLElement;
  readonly districtError: HTMLElement;
  readonly summary: HTMLElement;
  readonly status: HTMLElement;
}

const mounted: HTMLElement[] = [];

const createHarness = (): Harness => {
  const host = document.createElement('div');
  host.innerHTML = `
    <form>
      <label for="name">Ad</label>
      <div id="name-hint">En az üç karakter girin.</div>
      <input id="name" name="name" />
      <div id="name-error"></div>
      <label for="district">İlçe</label>
      <select id="district" name="district">
        <option value="">Seçin</option>
        <option value="cankaya">Çankaya</option>
      </select>
      <div id="district-error"></div>
      <div id="summary"></div>
      <div id="status"></div>
      <button type="submit">Kaydet</button>
    </form>`;
  document.body.append(host);
  mounted.push(host);
  const form = host.querySelector('form');
  const name = host.querySelector<HTMLInputElement>('#name');
  const district = host.querySelector<HTMLSelectElement>('#district');
  const nameError = host.querySelector<HTMLElement>('#name-error');
  const nameHint = host.querySelector<HTMLElement>('#name-hint');
  const districtError = host.querySelector<HTMLElement>('#district-error');
  const summary = host.querySelector<HTMLElement>('#summary');
  const status = host.querySelector<HTMLElement>('#status');
  if (!form || !name || !district || !nameError || !nameHint || !districtError || !summary || !status) {
    throw new Error('Test formu oluşturulamadı.');
  }
  return { form, name, district, nameError, nameHint, districtError, summary, status };
};

const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  mounted.splice(0).forEach((element) => element.remove());
  vi.restoreAllMocks();
});

describe('FormAccessibilityController', () => {
  it('native form doğrulamasını kapatır ve ipucu ilişkisini korur', () => {
    const view = createHarness();
    const model = createFormValidationModel();
    model.register({ id: 'name', label: 'Ad', required: true }, '');
    const controller = createFormAccessibilityController({
      form: view.form,
      model,
      fields: [{ id: 'name', element: view.name, errorElement: view.nameError, hintElement: view.nameHint }],
    });

    expect(view.form.noValidate).toBe(true);
    expect(view.name.getAttribute('aria-describedby')).toBe('name-hint');
    expect(view.name.getAttribute('aria-invalid')).toBe('false');
    expect(view.form.getAttribute('aria-busy')).toBe('false');
    controller.dispose();
    model.dispose();
  });

  it('input olayını modele aktarır ve dirty durumunu yansıtır', () => {
    const view = createHarness();
    const model = createFormValidationModel();
    model.register({ id: 'name', label: 'Ad' }, '');
    const controller = createFormAccessibilityController({
      form: view.form,
      model,
      fields: [{ id: 'name', element: view.name }],
    });

    view.name.value = 'Ankara';
    view.name.dispatchEvent(new Event('input', { bubbles: true }));
    expect(model.snapshot().fields.name?.value).toBe('Ankara');
    expect(controller.snapshot().dirtyFieldIds).toEqual(['name']);
    controller.dispose();
    model.dispose();
  });

  it('change olayını select değerine uygular', () => {
    const view = createHarness();
    const model = createFormValidationModel();
    model.register({ id: 'district', label: 'İlçe' }, '');
    const controller = createFormAccessibilityController({
      form: view.form,
      model,
      fields: [{ id: 'district', element: view.district }],
    });

    view.district.value = 'cankaya';
    view.district.dispatchEvent(new Event('change', { bubbles: true }));
    expect(model.snapshot().fields.district?.value).toBe('cankaya');
    controller.dispose();
    model.dispose();
  });

  it('blur sonrasında required hatasını görünür ve ilişkili yapar', async () => {
    const view = createHarness();
    const model = createFormValidationModel({ mode: 'blur' });
    model.register({ id: 'name', label: 'Ad', required: true }, '');
    const controller = createFormAccessibilityController({
      form: view.form,
      model,
      fields: [{ id: 'name', element: view.name, errorElement: view.nameError, hintElement: view.nameHint }],
    });

    view.name.dispatchEvent(new FocusEvent('blur'));
    await tick();
    expect(view.name.getAttribute('aria-invalid')).toBe('true');
    expect(view.name.getAttribute('aria-describedby')).toContain('name-hint');
    expect(view.name.getAttribute('aria-describedby')).toContain('name-error');
    expect(view.nameError.hidden).toBe(false);
    expect(view.nameError.textContent).toContain('zorunludur');
    controller.dispose();
    model.dispose();
  });

  it('hata temizlenince error tokenını kaldırır fakat hint tokenını bırakır', async () => {
    const view = createHarness();
    const model = createFormValidationModel({ mode: 'blur' });
    model.register({ id: 'name', label: 'Ad', required: true }, '');
    const controller = createFormAccessibilityController({
      form: view.form,
      model,
      fields: [{ id: 'name', element: view.name, errorElement: view.nameError, hintElement: view.nameHint }],
    });

    await model.blur('name');
    view.name.value = 'Ankara';
    view.name.dispatchEvent(new Event('input', { bubbles: true }));
    await model.blur('name');
    expect(view.name.getAttribute('aria-invalid')).toBe('false');
    expect(view.name.getAttribute('aria-describedby')).toBe('name-hint');
    expect(view.nameError.hidden).toBe(true);
    controller.dispose();
    model.dispose();
  });

  it('tek hata için özet metni ve alert rolü üretir', async () => {
    const view = createHarness();
    const model = createFormValidationModel();
    model.register({ id: 'name', label: 'Ad', required: true }, '');
    const controller = createFormAccessibilityController({
      form: view.form,
      model,
      fields: [{ id: 'name', element: view.name, errorElement: view.nameError }],
      summary: view.summary,
    });

    await model.validateAll();
    expect(view.summary.hidden).toBe(false);
    expect(view.summary.getAttribute('role')).toBe('alert');
    expect(view.summary.textContent).toBe('1 alanın düzeltilmesi gerekiyor.');
    controller.dispose();
    model.dispose();
  });

  it('çoklu hata için sayısal özet üretir', async () => {
    const view = createHarness();
    const model = createFormValidationModel();
    model.register({ id: 'name', label: 'Ad', required: true }, '');
    model.register({ id: 'district', label: 'İlçe', required: true }, '');
    const controller = createFormAccessibilityController({
      form: view.form,
      model,
      fields: [
        { id: 'name', element: view.name, errorElement: view.nameError },
        { id: 'district', element: view.district, errorElement: view.districtError },
      ],
      summary: view.summary,
    });

    await model.validateAll();
    expect(view.summary.textContent).toBe('2 alanın düzeltilmesi gerekiyor.');
    expect(controller.snapshot().invalidFieldIds).toEqual(['name', 'district']);
    controller.dispose();
    model.dispose();
  });

  it('geçerli formda özeti gizler', async () => {
    const view = createHarness();
    const model = createFormValidationModel();
    model.register({ id: 'name', label: 'Ad', required: true }, 'Ankara');
    const controller = createFormAccessibilityController({
      form: view.form,
      model,
      fields: [{ id: 'name', element: view.name }],
      summary: view.summary,
    });

    await model.validateAll();
    expect(view.summary.hidden).toBe(true);
    expect(view.summary.textContent).toBe('');
    controller.dispose();
    model.dispose();
  });

  it('focusFirstInvalid ilk hatalı alana odaklanır', async () => {
    const view = createHarness();
    const model = createFormValidationModel();
    model.register({ id: 'name', label: 'Ad', required: true }, '');
    const controller = createFormAccessibilityController({
      form: view.form,
      model,
      fields: [{ id: 'name', element: view.name }],
    });
    await model.validateAll();

    expect(controller.focusFirstInvalid()).toBe(true);
    expect(document.activeElement).toBe(view.name);
    controller.dispose();
    model.dispose();
  });

  it('hatalı submit varsayılan olarak ilk hatalı alana odaklanır', async () => {
    const view = createHarness();
    const model = createFormValidationModel();
    model.register({ id: 'name', label: 'Ad', required: true }, '');
    const controller = createFormAccessibilityController({
      form: view.form,
      model,
      fields: [{ id: 'name', element: view.name }],
      status: view.status,
    });

    view.form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await tick();
    expect(document.activeElement).toBe(view.name);
    expect(view.status.textContent).toBe('Formda düzeltilmesi gereken 1 alan var.');
    controller.dispose();
    model.dispose();
  });

  it('focusInvalidOnSubmit false olduğunda odağı zorlamaz', async () => {
    const view = createHarness();
    const model = createFormValidationModel();
    model.register({ id: 'name', label: 'Ad', required: true }, '');
    const controller = createFormAccessibilityController({
      form: view.form,
      model,
      fields: [{ id: 'name', element: view.name }],
      focusInvalidOnSubmit: false,
    });

    view.form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await tick();
    expect(document.activeElement).not.toBe(view.name);
    controller.dispose();
    model.dispose();
  });

  it('geçerli submit callbackini çağırır ve submitting durumunu sonlandırır', async () => {
    const view = createHarness();
    const model = createFormValidationModel();
    model.register({ id: 'name', label: 'Ad', required: true }, 'Ankara');
    const onSubmit = vi.fn();
    const controller = createFormAccessibilityController({
      form: view.form,
      model,
      fields: [{ id: 'name', element: view.name }],
      status: view.status,
      onSubmit,
    });

    view.form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await tick();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(model.snapshot().submitting).toBe(false);
    expect(view.form.getAttribute('aria-busy')).toBe('false');
    expect(view.status.textContent).toBe('Form doğrulandı ve gönderim tamamlandı.');
    controller.dispose();
    model.dispose();
  });

  it('async submit sürerken aria-busy true kalır', async () => {
    const view = createHarness();
    const model = createFormValidationModel();
    model.register({ id: 'name', label: 'Ad', required: true }, 'Ankara');
    let resolveSubmit: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { resolveSubmit = resolve; });
    const controller = createFormAccessibilityController({
      form: view.form,
      model,
      fields: [{ id: 'name', element: view.name }],
      onSubmit: () => pending,
    });

    view.form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await tick();
    expect(view.form.getAttribute('aria-busy')).toBe('true');
    resolveSubmit?.();
    await tick();
    expect(view.form.getAttribute('aria-busy')).toBe('false');
    controller.dispose();
    model.dispose();
  });

  it('submit hatasını diagnostics ve live status üzerinden raporlar', async () => {
    const view = createHarness();
    const model = createFormValidationModel();
    model.register({ id: 'name', label: 'Ad' }, 'Ankara');
    const error = new Error('network-free injected failure');
    const onObserverError = vi.fn();
    const controller = createFormAccessibilityController({
      form: view.form,
      model,
      fields: [{ id: 'name', element: view.name }],
      status: view.status,
      onSubmit: () => { throw error; },
      onObserverError,
    });

    view.form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await tick();
    expect(onObserverError).toHaveBeenCalledWith(error);
    expect(view.status.textContent).toBe('Form gönderilemedi. Lütfen tekrar deneyin.');
    expect(model.snapshot().submitting).toBe(false);
    controller.dispose();
    model.dispose();
  });

  it('live status semantiğini announce sırasında kurar', () => {
    const view = createHarness();
    const model = createFormValidationModel();
    const controller = createFormAccessibilityController({ form: view.form, model, fields: [], status: view.status });

    controller.announce('Kaydedildi');
    expect(view.status.getAttribute('role')).toBe('status');
    expect(view.status.getAttribute('aria-live')).toBe('polite');
    expect(view.status.getAttribute('aria-atomic')).toBe('true');
    expect(view.status.textContent).toBe('Kaydedildi');
    controller.dispose();
    model.dispose();
  });

  it('subscriber ilk snapshotı hemen alır', () => {
    const view = createHarness();
    const model = createFormValidationModel();
    const controller = createFormAccessibilityController({ form: view.form, model, fields: [] });
    const listener = vi.fn();

    controller.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ valid: true, submitting: false });
    controller.dispose();
    model.dispose();
  });

  it('subscriber hatasını diagnostics kanalına izole eder', () => {
    const view = createHarness();
    const model = createFormValidationModel();
    const onObserverError = vi.fn();
    const controller = createFormAccessibilityController({
      form: view.form,
      model,
      fields: [],
      onObserverError,
    });
    const error = new Error('observer failed');

    expect(() => controller.subscribe(() => { throw error; })).not.toThrow();
    expect(onObserverError).toHaveBeenCalledWith(error);
    controller.dispose();
    model.dispose();
  });

  it('diagnostics reporter hatasını kullanıcı etkileşiminden izole eder', () => {
    const view = createHarness();
    const model = createFormValidationModel();
    const controller = createFormAccessibilityController({
      form: view.form,
      model,
      fields: [],
      onObserverError: () => { throw new Error('secondary diagnostics failure'); },
    });

    expect(() => controller.subscribe(() => { throw new Error('observer failure'); })).not.toThrow();
    controller.dispose();
    model.dispose();
  });

  it('reset announcement ve alan durumlarını temizler', async () => {
    const view = createHarness();
    const model = createFormValidationModel();
    model.register({ id: 'name', label: 'Ad', required: true }, '');
    const controller = createFormAccessibilityController({ form: view.form, model, fields: [{ id: 'name', element: view.name }] });
    await model.validateAll();
    controller.announce('Özel mesaj');

    controller.reset();
    expect(controller.snapshot().announcement).toBe('');
    expect(controller.snapshot().invalidFieldIds).toEqual([]);
    expect(controller.snapshot().dirtyFieldIds).toEqual([]);
    controller.dispose();
    model.dispose();
  });

  it('dispose listenerları ve controller-owned aria durumlarını temizler', () => {
    const view = createHarness();
    const model = createFormValidationModel();
    model.register({ id: 'name', label: 'Ad' }, '');
    const controller = createFormAccessibilityController({
      form: view.form,
      model,
      fields: [{ id: 'name', element: view.name, errorElement: view.nameError, hintElement: view.nameHint }],
    });

    controller.dispose();
    expect(view.form.hasAttribute('aria-busy')).toBe(false);
    expect(view.name.hasAttribute('aria-invalid')).toBe(false);
    expect(view.name.hasAttribute('aria-describedby')).toBe(false);
    view.name.value = 'değişti';
    view.name.dispatchEvent(new Event('input', { bubbles: true }));
    expect(model.snapshot().fields.name?.value).toBe('');
    model.dispose();
  });

  it('dispose sonrasında public mutation API fail-fast davranır', () => {
    const view = createHarness();
    const model = createFormValidationModel();
    const controller = createFormAccessibilityController({ form: view.form, model, fields: [] });
    controller.dispose();

    expect(() => controller.announce('x')).toThrow(/dispose/);
    expect(() => controller.reset()).toThrow(/dispose/);
    expect(() => controller.subscribe(() => undefined)).toThrow(/dispose/);
    model.dispose();
  });
});