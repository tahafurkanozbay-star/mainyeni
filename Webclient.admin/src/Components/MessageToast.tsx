import { useMemo } from "react";
import { Toast } from "react-bootstrap";
import { BsInfoCircle, BsShieldExclamation } from "react-icons/bs";
import { ImWarning } from "react-icons/im";

export type ToastMessageType = "error" | "warning" | "info" | "success";

export interface MessageToastProps {
  readonly dismissMessage: () => void;
  readonly message: string;
  readonly type?: ToastMessageType | string | null;
}

const currentTime = (): string =>
  new Intl.DateTimeFormat("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());

export function MessageToast({
  dismissMessage,
  message,
  type = "info",
}: MessageToastProps) {
  const timestamp = useMemo(currentTime, []);

  const icon = type === "error"
    ? <BsShieldExclamation aria-hidden="true" />
    : type === "warning"
      ? <ImWarning aria-hidden="true" />
      : <BsInfoCircle aria-hidden="true" />;

  return (
    <Toast
      onClose={dismissMessage}
      delay={4_000}
      autohide
      style={{ position: "relative", top: 10, margin: "auto" }}
      role={type === "error" ? "alert" : "status"}
      aria-live={type === "error" ? "assertive" : "polite"}
    >
      <Toast.Header closeLabel="Mesajı kapat">
        <strong className="me-auto">Mesaj</strong>
        <small>{timestamp}</small>
      </Toast.Header>
      <Toast.Body>
        <span aria-hidden="true">{icon}</span>
        <span className="ms-2">{message}</span>
      </Toast.Body>
    </Toast>
  );
}
