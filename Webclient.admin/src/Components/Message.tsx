import { useEffect, useState } from 'react';
import { Alert } from 'react-bootstrap';
import { BiError } from 'react-icons/bi';
import { BsInfoCircle } from 'react-icons/bs';
import { IoWarningOutline } from 'react-icons/io5';
import { MdCancel } from 'react-icons/md';
import { TiTickOutline } from 'react-icons/ti';

import { Constants } from '../Core/Constants';
import './Message.css';

interface MessageValue {
  readonly type?: number;
  readonly text?: string;
}

interface MessageProps {
  readonly message?: MessageValue | null;
}

export const Message = ({ message: nextMessage }: MessageProps) => {
  const [message, setMessage] = useState<MessageValue | null>(nextMessage ?? null);

  useEffect(() => {
    setMessage(nextMessage ?? null);
    if (!nextMessage) return undefined;

    const timeout = window.setTimeout(() => setMessage(null), 5_000);
    return () => window.clearTimeout(timeout);
  }, [nextMessage]);

  useEffect(() => {
    document.getElementById('root')?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [message]);

  if (!message) return null;

  const icon = (() => {
    switch (message.type) {
      case Constants.MessageTypes.Error:
        return <BiError className="Message_Container_Icon" style={{ color: 'red' }} aria-hidden="true" />;
      case Constants.MessageTypes.Success:
        return <TiTickOutline className="Message_Container_Icon" style={{ color: 'green' }} aria-hidden="true" />;
      case Constants.MessageTypes.Warning:
        return <IoWarningOutline className="Message_Container_Icon" style={{ color: 'yellowgreen' }} aria-hidden="true" />;
      default:
        return <BsInfoCircle className="Message_Container_Icon" style={{ color: 'blue' }} aria-hidden="true" />;
    }
  })();

  return (
    <Alert className="Message_Container" variant="secondary" role="status">
      {icon}
      <span className="Message_Container_Text">{message.text ?? ''}</span>
      <button
        type="button"
        className="Message_Dismiss_Button float-end btn btn-link p-0"
        onClick={() => setMessage(null)}
        aria-label="Mesajı kapat"
      >
        <MdCancel aria-hidden="true" />
      </button>
    </Alert>
  );
};
