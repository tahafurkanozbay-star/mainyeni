import { type ReactNode } from 'react';
import { Constants_MessageType, type MessageType } from '../../Core/Constants';
import type { MessageState } from '../../Store/contracts';
import './MessageBar.css';

export interface MessageBarProps {
  readonly message?: MessageState | null;
}

type MessagePresentation = {
  readonly tone: MessageType;
  readonly label: string;
  readonly symbol: string;
};

const resolvePresentation = (type: unknown): MessagePresentation => {
  switch (type) {
    case Constants_MessageType.Error:
      return { tone: Constants_MessageType.Error, label: 'Hata', symbol: '!' };
    case Constants_MessageType.Warning:
      return { tone: Constants_MessageType.Warning, label: 'Uyarı', symbol: '!' };
    case Constants_MessageType.Success:
      return { tone: Constants_MessageType.Success, label: 'Başarılı', symbol: '✓' };
    case Constants_MessageType.Info:
    default:
      return { tone: Constants_MessageType.Info, label: 'Bilgi', symbol: 'i' };
  }
};

const readMessageText = (message: MessageState): string =>
  String(message.messageText ?? message.Message ?? message.message ?? '').trim();

const readMessageType = (message: MessageState): unknown =>
  message.messageType ?? message.Type ?? message.type;

export function MessageBar({ message }: MessageBarProps): ReactNode {
  if (!message) return null;
  const text = readMessageText(message);
  if (!text) return null;
  const presentation = resolvePresentation(readMessageType(message));
  const assertive = presentation.tone === Constants_MessageType.Error;
  return (
    <div
      className={`message-bar message-bar--${presentation.tone}`}
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <span className="message-bar-icon" aria-hidden="true">{presentation.symbol}</span>
      <span className="experience-sr-only">{presentation.label}: </span>
      <span className="message-bar__text">{text}</span>
    </div>
  );
}

export default MessageBar;
