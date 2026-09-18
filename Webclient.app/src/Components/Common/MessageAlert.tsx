import { Alert } from 'react-bootstrap';
import { BiAlarmExclamation, BiBadgeCheck, BiError, BiInfoCircle } from 'react-icons/bi';
import type { ReactNode } from 'react';
import { createMessageViewModel, type UiMessageSeverity } from './messageModel';

export interface MessageAlertProps {
  readonly message?: string;
  readonly type?: UiMessageSeverity | 'danger';
  readonly dismissMessage?: () => void;
}

const icon = (severity: UiMessageSeverity): ReactNode => {
  if (severity === 'error') return <BiError aria-hidden="true" />;
  if (severity === 'warning') return <BiAlarmExclamation aria-hidden="true" />;
  if (severity === 'success') return <BiBadgeCheck aria-hidden="true" />;
  return <BiInfoCircle aria-hidden="true" />;
};

export function MessageAlert({ message = 'Mesaj içeriği bulunamadı.', type = 'info', dismissMessage }: MessageAlertProps) {
  const model = createMessageViewModel({ message, type });
  const closeProps = typeof dismissMessage === 'function' ? { onClose: dismissMessage } : {};
  return <Alert {...closeProps} variant={model.variant} dismissible={typeof dismissMessage === 'function'} role="alert">
    <Alert.Heading>{model.heading}</Alert.Heading>
    <p>{icon(model.severity)}<span className="ms-2">{model.message}</span></p>
  </Alert>;
}
