import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { Modal, Button, Form } from 'react-bootstrap';
import { BiCheckCircle, BiError, BiUpload } from 'react-icons/bi';
import { FeedbackBusiness } from '../../../Business/FeedbackBusiness';
import { ContainerLoading, ButtonLoading } from '../../Common/Loading';
import { MessageAlert } from '../../Common/MessageAlert';
import { normalizeWidgetError } from '../_shared/MapWidgetRuntime';

type SubmitStatus = 'idle' | 'loading' | 'submitted' | 'error';

interface FeedbackType {
  readonly id: string | number;
  readonly name: string;
}

interface FeedbackFormData {
  readonly CaptchaValue: string;
  readonly FeedbackType: string | number;
  readonly country: number;
  readonly Description: string;
  readonly FullName: string;
  readonly City: string;
  readonly Email: string;
  readonly Address: string;
}

interface FeedbackMessage {
  readonly Text: string;
  readonly Type: 'error' | 'warning';
}

export interface FeedbackFormProps {
  readonly show: boolean;
  readonly closeWindow: () => void;
}

const INITIAL_FORM_DATA: FeedbackFormData = Object.freeze({
  CaptchaValue: '',
  FeedbackType: 1,
  country: -1,
  Description: '',
  FullName: '',
  City: '',
  Email: '',
  Address: '',
});

const normalizeFeedbackTypes = (value: unknown): readonly FeedbackType[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): FeedbackType[] => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as { id?: unknown; name?: unknown };
    if (
      (typeof candidate.id !== 'string' && typeof candidate.id !== 'number')
      || typeof candidate.name !== 'string'
      || !candidate.name.trim()
    ) return [];
    return [{ id: candidate.id, name: candidate.name.trim().slice(0, 120) }];
  });
};

const validate = (formData: FeedbackFormData): FeedbackMessage | null => {
  const required: ReadonlyArray<readonly [keyof FeedbackFormData, string]> = [
    ['FeedbackType', 'Lütfen başvuru türünü seçiniz.'],
    ['Description', 'Lütfen açıklama giriniz.'],
    ['FullName', 'Lütfen adınızı giriniz.'],
    ['City', 'Lütfen şehir giriniz.'],
    ['Email', 'Lütfen e-posta giriniz.'],
    ['Address', 'Lütfen adresinizi giriniz.'],
  ];

  for (const [key, message] of required) {
    if (!String(formData[key] ?? '').trim()) return { Text: message, Type: 'warning' };
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(formData.Email.trim())) {
    return { Text: 'Lütfen geçerli bir e-posta adresi giriniz.', Type: 'warning' };
  }

  return null;
};

const FeedbackForm = ({ show, closeWindow }: FeedbackFormProps): ReactNode => {
  const [feedbackTypes, setFeedbackTypes] = useState<readonly FeedbackType[]>([]);
  const [message, setMessage] = useState<FeedbackMessage | null>(null);
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>('idle');
  const [formData, setFormData] = useState<FeedbackFormData>(INITIAL_FORM_DATA);
  const generationRef = useRef(0);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    generationRef.current += 1;

    if (!show) return undefined;

    try {
      setFeedbackTypes(normalizeFeedbackTypes(FeedbackBusiness.GetFeedbackTypes()));
      setMessage(null);
    } catch (error) {
      setFeedbackTypes([]);
      setMessage({
        Text: normalizeWidgetError(error, 'Başvuru türleri yüklenemedi.'),
        Type: 'error',
      });
    }
    setFormData(INITIAL_FORM_DATA);
    setSubmitStatus('idle');

    return () => {
      generationRef.current += 1;
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [show]);

  const setField = (
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    key: keyof FeedbackFormData,
  ): void => {
    const limit = key === 'Description' || key === 'Address' ? 2000 : 180;
    setFormData((current) => ({
      ...current,
      [key]: event.target.value.slice(0, limit),
    }));
    setMessage(null);
  };

  const submit = async (): Promise<void> => {
    const validation = validate(formData);
    if (validation) {
      setMessage(validation);
      return;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setMessage(null);
    setSubmitStatus('loading');

    try {
      const result = await FeedbackBusiness.SendFeedBack({
        ...formData,
        Description: formData.Description.trim(),
        FullName: formData.FullName.trim(),
        City: formData.City.trim(),
        Email: formData.Email.trim(),
        Address: formData.Address.trim(),
        CaptchaValue: formData.CaptchaValue.trim(),
      });
      if (generationRef.current !== generation) return;

      const type = result && typeof result === 'object'
        ? Number((result as { Type?: unknown }).Type)
        : Number.NaN;
      if (!result || type === 20) {
        setSubmitStatus('error');
        return;
      }

      setSubmitStatus('submitted');
      closeTimerRef.current = window.setTimeout(() => {
        if (generationRef.current === generation) closeWindow();
      }, 2000);
    } catch (error) {
      if (generationRef.current !== generation) return;
      setMessage({
        Text: normalizeWidgetError(error, 'Mesajınız gönderilemedi. Lütfen daha sonra tekrar deneyin.'),
        Type: 'error',
      });
      setSubmitStatus('error');
    }
  };

  return (
    <Modal
      show={show}
      className="ZoningStatusDocument_ModalContainer"
      onHide={closeWindow}
      aria-labelledby="feedback-dialog-title"
      aria-describedby="feedback-dialog-description"
      backdrop="static"
    >
      <Modal.Header closeButton>
        <div className="feedback-widget-logo">
          <img src="images/logo.png" alt="" aria-hidden="true" decoding="async" />
        </div>
        <div className="feedback-widget-title">
          <span id="feedback-dialog-title">İstek/Öneri ve Şikayetleriniz</span>
          <span id="feedback-dialog-description" className="experience-sr-only">
            Görüşünüzü iletmek için zorunlu alanları doldurun.
          </span>
        </div>
      </Modal.Header>

      <Modal.Body aria-busy={submitStatus === 'loading' || undefined}>
        {submitStatus === 'loading' ? <ContainerLoading message="Başvurunuz gönderiliyor…" /> : null}
        {submitStatus === 'error' ? (
          <div role="alert" className="feedback-modern-status feedback-modern-status--error">
            <BiError aria-hidden="true" /> Mesajınız gönderilirken bir hata oluştu.
          </div>
        ) : null}
        {submitStatus === 'submitted' ? (
          <div role="status" aria-live="polite" className="feedback-modern-status feedback-modern-status--success">
            <BiCheckCircle aria-hidden="true" /> Mesajınız gönderildi.
          </div>
        ) : null}
        {message ? (
          <MessageAlert
            dismissMessage={() => setMessage(null)}
            message={message.Text}
            type={message.Type}
          />
        ) : null}

        <fieldset className="feedback-modern-fieldset" disabled={submitStatus === 'loading'}>
          <legend>Başvuru Türü</legend>
          {feedbackTypes.map((item) => (
            <Form.Check
              key={item.id}
              id={`feedback-type-${item.id}`}
              onChange={(event) => setField(event, 'FeedbackType')}
              value={item.id}
              name="feedbackType"
              type="radio"
              label={item.name}
              checked={String(formData.FeedbackType) === String(item.id)}
            />
          ))}
        </fieldset>

        <div className="feedback-modern-grid">
          <label htmlFor="feedback-full-name">Ad Soyad</label>
          <Form.Control id="feedback-full-name" value={formData.FullName} onChange={(event) => setField(event, 'FullName')} autoComplete="name" />
          <label htmlFor="feedback-city">Şehir</label>
          <Form.Control id="feedback-city" value={formData.City} onChange={(event) => setField(event, 'City')} autoComplete="address-level2" />
          <label htmlFor="feedback-email">E-posta</label>
          <Form.Control id="feedback-email" type="email" value={formData.Email} onChange={(event) => setField(event, 'Email')} autoComplete="email" />
          <label htmlFor="feedback-address">Adres</label>
          <textarea id="feedback-address" value={formData.Address} onChange={(event) => setField(event, 'Address')} autoComplete="street-address" />
          <label htmlFor="feedback-description">Açıklama</label>
          <textarea id="feedback-description" value={formData.Description} onChange={(event) => setField(event, 'Description')} maxLength={2000} />
          <label htmlFor="feedback-captcha">Güvenlik metni</label>
          <Form.Control id="feedback-captcha" value={formData.CaptchaValue} onChange={(event) => setField(event, 'CaptchaValue')} autoComplete="off" />
        </div>
      </Modal.Body>

      <Modal.Footer>
        <Button variant="secondary" onClick={closeWindow} disabled={submitStatus === 'loading'}>
          Vazgeç
        </Button>
        {submitStatus !== 'loading' ? (
          <Button variant="primary" onClick={() => void submit()} disabled={submitStatus === 'submitted'}>
            <BiUpload aria-hidden="true" /> Gönder
          </Button>
        ) : (
          <ButtonLoading message="Gönderiliyor…" />
        )}
      </Modal.Footer>
    </Modal>
  );
};

export default FeedbackForm;
