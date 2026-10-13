import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Modal, Button } from 'react-bootstrap';
import { FeedbackBusiness } from '../../../Business/FeedbackBusiness';
import { withTimeout } from '../../../platform/runtime/resilience';

export interface FeedbackFormProps { readonly show: boolean; readonly closeWindow: () => void; }
type SubmitStatus = 'idle' | 'loading' | 'submitted' | 'error';
interface FeedbackFormData { readonly FeedbackType: number; readonly FullName: string; readonly Country: string; readonly City: string; readonly Email: string; readonly Address: string; readonly Description: string; }
type TextField = Exclude<keyof FeedbackFormData, 'FeedbackType'>;
interface FeedbackType { readonly id: number; readonly name: string; }
type FieldErrors = Partial<Record<keyof FeedbackFormData, string>>;
const SUBMISSION_POLICY = Object.freeze({ timeoutMs: 15_000 });
const INITIAL_FORM_DATA: FeedbackFormData = Object.freeze({ FeedbackType: 1, FullName: '', Country: 'Türkiye', City: '', Email: '', Address: '', Description: '' });
const FIELDS: readonly { key: TextField; label: string; autocomplete: string; multiline?: boolean }[] = [
  { key: 'FullName', label: 'Ad Soyad', autocomplete: 'name' },
  { key: 'Country', label: 'Ülke', autocomplete: 'country-name' },
  { key: 'City', label: 'Şehir', autocomplete: 'address-level2' },
  { key: 'Email', label: 'E-posta', autocomplete: 'email' },
  { key: 'Address', label: 'Adres', autocomplete: 'street-address', multiline: true },
  { key: 'Description', label: 'Açıklama', autocomplete: 'off', multiline: true },
];

const normalizeFeedbackTypes = (value: unknown): readonly FeedbackType[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  return value.slice(0, 32).flatMap((item): FeedbackType[] => {
    if (!item || typeof item !== 'object') return [];
    const { id, name } = item as { id?: unknown; name?: unknown };
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId) || numericId < 1 || seen.has(numericId) || typeof name !== 'string' || !name.trim()) return [];
    seen.add(numericId);
    return [{ id: numericId, name: name.trim().slice(0, 120) }];
  });
};

const validate = (data: FeedbackFormData, types: readonly FeedbackType[]): FieldErrors => {
  const errors: FieldErrors = {};
  for (const field of FIELDS) if (!data[field.key].trim()) errors[field.key] = `${field.label} alanını doldurun.`;
  if (data.Email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(data.Email.trim())) errors.Email = 'Geçerli bir e-posta adresi girin.';
  if (!types.some(type => type.id === data.FeedbackType)) errors.FeedbackType = 'Geçerli bir başvuru türü seçin.';
  return errors;
};

const confirmedSuccess = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as { Type?: unknown; type?: unknown; IsSuccess?: unknown; isSuccess?: unknown };
  const codes = [result.type, result.Type].filter(code => code !== undefined);
  const flags = [result.isSuccess, result.IsSuccess].filter(flag => flag !== undefined);
  return codes.length > 0 && codes.every(code => code === 10 || code === '10') && flags.every(flag => flag === true);
};

const FeedbackForm = ({ show, closeWindow }: FeedbackFormProps): ReactNode => {
  const id = `feedback-${useId()}`;
  const formRef = useRef<HTMLFormElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const [feedbackTypes, setFeedbackTypes] = useState<readonly FeedbackType[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [formData, setFormData] = useState<FeedbackFormData>(INITIAL_FORM_DATA);

  const cancelSubmission = (): void => {
    generationRef.current += 1;
    abortRef.current?.abort(); abortRef.current = null;
    pendingRef.current = false;
  };
  useEffect(() => {
    cancelSubmission();
    if (!show) return undefined;
    let types: readonly FeedbackType[] = [];
    try { types = normalizeFeedbackTypes(FeedbackBusiness.GetFeedbackTypes()); }
    catch { setMessage('Başvuru türleri hazırlanamadı. Pencereyi yeniden açarak deneyin.'); }
    setFeedbackTypes(types);
    setFormData({ ...INITIAL_FORM_DATA, FeedbackType: types[0]?.id ?? 0 });
    setSubmitStatus('idle'); setErrors({});
    setMessage(types.length ? null : 'Başvuru türleri hazırlanamadı. Pencereyi yeniden açarak deneyin.');
    return cancelSubmission;
  }, [show]);

  useEffect(() => {
    if (submitStatus === 'submitted') statusRef.current?.focus({ preventScroll: true });
  }, [submitStatus]);

  const handleClose = (): void => { cancelSubmission(); closeWindow(); };
  const setField = (key: TextField, value: string): void => {
    setFormData(current => ({ ...current, [key]: value.slice(0, key === 'Address' || key === 'Description' ? 2000 : 180) }));
    setErrors(current => ({ ...current, [key]: undefined }));
  };
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pendingRef.current || !show || submitStatus === 'submitted') return;
    const validation = validate(formData, feedbackTypes);
    setErrors(validation); setMessage(null);
    const firstInvalid = FIELDS.find(field => validation[field.key]);
    if (Object.keys(validation).length) {
      const field = firstInvalid ? formRef.current?.elements.namedItem(firstInvalid.key) : document.getElementById(`${id}-types`);
      if (field instanceof HTMLElement) field.focus();
      return;
    }
    pendingRef.current = true;
    const generation = ++generationRef.current;
    const owner = new AbortController(); abortRef.current = owner;
    const payload: FeedbackFormData = {
      FeedbackType: formData.FeedbackType, FullName: formData.FullName.trim(),
      Country: formData.Country.trim(), City: formData.City.trim(), Email: formData.Email.trim(),
      Address: formData.Address.trim(), Description: formData.Description.trim(),
    };
    setSubmitStatus('loading');
    try {
      const result = await withTimeout(signal => FeedbackBusiness.SendFeedBack(payload, { signal }), SUBMISSION_POLICY.timeoutMs, owner.signal);
      if (generation !== generationRef.current) return;
      if (!confirmedSuccess(result)) {
        setSubmitStatus('error');
        setMessage('Başvurunuzun kaydedildiği doğrulanamadı. Yeniden göndermeden önce durumunu kontrol edin.');
        return;
      }
      setSubmitStatus('submitted');
    } catch {
      if (generation !== generationRef.current) return;
      setSubmitStatus('error');
      setMessage('Gönderim sonucu doğrulanamadı. Bilgileriniz bu pencerede korunuyor; yeniden göndermeden önce durumunu kontrol edin.');
    } finally {
      if (generation === generationRef.current) { pendingRef.current = false; abortRef.current = null; }
    }
  };
  const busy = submitStatus === 'loading';
  return (
    <Modal show={show} onHide={handleClose} className="feedback-modal" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} scrollable centered backdrop="static" onEntered={() => formRef.current?.querySelector<HTMLInputElement>('input[name="FullName"]')?.focus()}>
      <Modal.Header closeButton closeLabel="Başvuru penceresini kapat">
        <img className="feedback-modal__logo" src="images/logo.png" alt="" aria-hidden="true" />
        <Modal.Title as="h2" id={`${id}-title`}>İstek, öneri ve şikayet</Modal.Title>
      </Modal.Header>
      <Modal.Body aria-busy={busy || undefined}>
        <p id={`${id}-description`} className="feedback-form__intro">Görüşünüzü iletmek için aşağıdaki bilgileri doldurun. Yıldızlı alanlar zorunludur.</p>
        {submitStatus === 'submitted' ? (
          <div ref={statusRef} className="feedback-form__success" role="status" tabIndex={-1}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z m-4 9 3 3 5-6" /></svg>
            <h3>Başvurunuz gönderildi</h3><p>Pencereyi kapatabilirsiniz. Başvurunuz yeniden gönderilmeyecektir.</p>
          </div>
        ) : (
          <form id={`${id}-form`} ref={formRef} onSubmit={event => void submit(event)} noValidate>
            {Object.values(errors).some(Boolean) ? <p className="feedback-form__error" role="alert">Zorunlu alanları kontrol edin. Eksik bilgiler alanların altında gösteriliyor.</p> : null}
            {message ? <p className="feedback-form__error" role="alert">{message}</p> : null}
            {busy ? <p role="status" className="feedback-form__sending"><span className="experience-spinner experience-spinner--small" aria-hidden="true" /> Başvurunuz gönderiliyor…</p> : null}
            <fieldset disabled={busy} className="feedback-form__fieldset">
              <legend>Başvuru bilgileri</legend>
              <fieldset id={`${id}-types`} className="feedback-form__types" tabIndex={-1}>
                <legend>Başvuru türü <span aria-hidden="true">*</span></legend>
                {feedbackTypes.map(type => <label key={type.id}><input type="radio" name="FeedbackType" value={type.id} checked={formData.FeedbackType === type.id} onChange={() => setFormData(current => ({ ...current, FeedbackType: type.id }))} required /><span>{type.name}</span></label>)}
              </fieldset>
              <div className="feedback-form__fields">
                {FIELDS.map(field => {
                  const fieldId = `${id}-${field.key}`;
                  const fieldError = errors[field.key];
                  const props = { id: fieldId, name: field.key, value: formData[field.key], autoComplete: field.autocomplete, required: true, maxLength: field.multiline ? 2000 : 180, 'aria-invalid': Boolean(fieldError), 'aria-describedby': fieldError ? `${fieldId}-error` : field.key === 'Description' ? `${fieldId}-hint` : undefined };
                  return <div className="feedback-form__field" key={field.key}>
                    <label htmlFor={fieldId}>{field.label} <span aria-hidden="true">*</span></label>
                    {field.multiline ? <textarea {...props} rows={field.key === 'Description' ? 4 : 2} onChange={event => setField(field.key, event.currentTarget.value)} /> : <input {...props} type={field.key === 'Email' ? 'email' : 'text'} onChange={event => setField(field.key, event.currentTarget.value)} />}
                    {fieldError ? <p id={`${fieldId}-error`} className="feedback-form__field-error">{fieldError}</p> : null}
                    {field.key === 'Description' ? <p id={`${fieldId}-hint`} className="feedback-form__hint">{formData.Description.length} / 2.000 karakter</p> : null}
                  </div>;
                })}
              </div>
            </fieldset>
          </form>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="secondary" onClick={handleClose}>{submitStatus === 'submitted' ? 'Kapat' : 'Vazgeç'}</Button>
        {submitStatus !== 'submitted' ? <Button type="submit" form={`${id}-form`} disabled={busy || !feedbackTypes.length} variant="primary">{busy ? 'Gönderiliyor…' : 'Gönder'}</Button> : null}
      </Modal.Footer>
    </Modal>
  );
};
export default FeedbackForm;
