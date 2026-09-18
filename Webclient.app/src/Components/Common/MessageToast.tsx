import { useMemo } from 'react';
import { Toast } from 'react-bootstrap';
import { BiAlarmExclamation, BiBadgeCheck, BiError, BiInfoCircle } from 'react-icons/bi';
import { createMessageViewModel, formatMessageClock, type LegacyMessageInput, type UiMessageSeverity } from './messageModel';

export interface MessageToastProps {
  readonly message?: LegacyMessageInput | string | null;
  readonly onDismiss?: () => void;
  readonly delayMs?: number;
}

const MessageIcon = ({ severity }: { readonly severity: UiMessageSeverity }) => {
  if (severity === 'error') return <BiError aria-hidden="true" />;
  if (severity === 'warning') return <BiAlarmExclamation aria-hidden="true" />;
  if (severity === 'success') return <BiBadgeCheck aria-hidden="true" />;
  return <BiInfoCircle aria-hidden="true" />;
};

const delay = (value: number | undefined): number =>
  Number.isFinite(value) ? Math.min(60_000, Math.max(500, Math.trunc(value ?? 5_000))) : 5_000;

export function MessageToast({ message, onDismiss, delayMs }: MessageToastProps) {
  const model = useMemo(
    () => message === null || message === undefined ? null : createMessageViewModel(message),
    [message],
  );
  if (!model) return null;
  return <Toast
    onClose={onDismiss}
    delay={delay(delayMs)}
    autohide={typeof onDismiss === 'function'}
    role={model.severity === 'error' ? 'alert' : 'status'}
    aria-live={model.severity === 'error' ? 'assertive' : 'polite'}
    style={{ position: 'relative', top: 10, margin: 'auto' }}
  >
    <Toast.Header closeButton={typeof onDismiss === 'function'}>
      <strong className="me-auto">{model.heading}</strong>
      <small>{formatMessageClock(model.clock)}</small>
    </Toast.Header>
    <Toast.Body><MessageIcon severity={model.severity} /><span className="ms-2">{model.message}</span></Toast.Body>
  </Toast>;
}
