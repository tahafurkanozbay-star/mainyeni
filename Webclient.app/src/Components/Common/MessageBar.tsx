import { useMemo } from 'react';
import { BiAlarmExclamation, BiBadgeCheck, BiError, BiInfoCircle } from 'react-icons/bi';
import './MessageBar.css';
import { createMessageViewModel, type LegacyMessageInput, type UiMessageSeverity } from './messageModel';

export interface MessageBarProps {
  readonly message?: LegacyMessageInput | string | null;
}

const MessageIcon = ({ severity }: { readonly severity: UiMessageSeverity }) => {
  if (severity === 'error') return <BiError className="message-bar-icon" aria-hidden="true" />;
  if (severity === 'warning') return <BiAlarmExclamation className="message-bar-icon" aria-hidden="true" />;
  if (severity === 'success') return <BiBadgeCheck className="message-bar-icon" aria-hidden="true" />;
  return <BiInfoCircle className="message-bar-icon" aria-hidden="true" />;
};

export function MessageBar({ message }: MessageBarProps) {
  const model = useMemo(
    () => message === null || message === undefined ? null : createMessageViewModel(message),
    [message],
  );
  if (!model) return null;
  return <div
    className={`message-bar message-bar--${model.severity}`}
    role={model.severity === 'error' ? 'alert' : 'status'}
    aria-live={model.severity === 'error' ? 'assertive' : 'polite'}
  >
    <MessageIcon severity={model.severity} />
    <span>{model.message}</span>
  </div>;
}
