import { useEffect, useMemo, useState } from "react";
import { Alert, Button } from "react-bootstrap";
import { BiError } from "react-icons/bi";
import { BsInfoCircle } from "react-icons/bs";
import { IoWarningOutline } from "react-icons/io5";
import { MdCancel } from "react-icons/md";
import { TiTickOutline } from "react-icons/ti";
import { Constants, type MessageType } from "../Core/Constants";
import { isRecord, readFiniteNumber, readString } from "../platform/contracts";
import "./Message.css";

export interface MessageValue {
  readonly type: MessageType;
  readonly text: string;
}

export interface MessageProps {
  readonly message?: MessageValue | null | unknown;
  readonly autoHideMs?: number;
}

const parseMessage = (value: unknown): MessageValue | null => {
  if (!isRecord(value)) return null;
  const text = readString(value.text ?? value.message);
  const type = readFiniteNumber(value.type);
  if (!text || type === null) return null;
  if (!Object.values(Constants.MessageTypes).includes(type as MessageType)) return null;
  return Object.freeze({ text, type: type as MessageType });
};

export const Message = ({ message: incoming, autoHideMs = 5_000 }: MessageProps) => {
  const parsed = useMemo(() => parseMessage(incoming), [incoming]);
  const [message, setMessage] = useState<MessageValue | null>(parsed);

  useEffect(() => {
    setMessage(parsed);
    if (!parsed) return undefined;
    const timeout = window.setTimeout(
      () => setMessage(null),
      Math.min(60_000, Math.max(1_000, Math.trunc(autoHideMs))),
    );
    return () => window.clearTimeout(timeout);
  }, [autoHideMs, parsed]);

  useEffect(() => {
    if (!message) return;
    document.getElementById("root")?.scrollTo({ top: 0, behavior: "smooth" });
  }, [message]);

  if (!message) return null;

  const visual = (() => {
    switch (message.type) {
      case Constants.MessageTypes.Error:
        return { icon: <BiError aria-hidden="true" />, variant: "danger", label: "Hata" };
      case Constants.MessageTypes.Success:
        return { icon: <TiTickOutline aria-hidden="true" />, variant: "success", label: "Başarılı" };
      case Constants.MessageTypes.Warning:
        return { icon: <IoWarningOutline aria-hidden="true" />, variant: "warning", label: "Uyarı" };
      default:
        return { icon: <BsInfoCircle aria-hidden="true" />, variant: "info", label: "Bilgi" };
    }
  })();

  return (
    <Alert
      className="Message_Container"
      variant={visual.variant}
      role={message.type === Constants.MessageTypes.Error ? "alert" : "status"}
      aria-live={message.type === Constants.MessageTypes.Error ? "assertive" : "polite"}
    >
      <span className="Message_Container_Icon" aria-hidden="true">
        {visual.icon}
      </span>
      <span className="visually-hidden">{visual.label}: </span>
      <span className="Message_Container_Text">{message.text}</span>
      <Button
        type="button"
        variant="link"
        className="Message_Dismiss_Button float-end p-0"
        onClick={() => setMessage(null)}
        aria-label="Mesajı kapat"
      >
        <MdCancel aria-hidden="true" />
      </Button>
    </Alert>
  );
};
