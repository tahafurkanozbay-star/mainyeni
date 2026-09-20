import { Button, Modal } from "react-bootstrap";
import { ImWarning } from "react-icons/im";

export interface ConfirmDialogProps {
  readonly text: string;
  readonly CancelCallBack: () => void;
  readonly AcceptCallBack: () => void;
  readonly title?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
}

export const ConfirmDialog = ({
  text,
  CancelCallBack,
  AcceptCallBack,
  title = "Onay",
  confirmLabel = "Evet",
  cancelLabel = "Vazgeç",
}: ConfirmDialogProps) => (
  <Modal
    show
    onHide={CancelCallBack}
    centered
    aria-labelledby="admin-confirm-dialog-title"
  >
    <Modal.Header closeButton closeLabel="Kapat">
      <Modal.Title id="admin-confirm-dialog-title">{title}</Modal.Title>
    </Modal.Header>
    <Modal.Body>
      <div className="confirm-dialog-container">
        <div className="row align-items-center">
          <div className="col-2">
            <ImWarning className="icon-8x" aria-hidden="true" />
          </div>
          <div className="col-10">{text}</div>
        </div>
      </div>
    </Modal.Body>
    <Modal.Footer>
      <Button type="button" variant="secondary" onClick={CancelCallBack}>
        {cancelLabel}
      </Button>
      <Button type="button" variant="danger" onClick={AcceptCallBack}>
        {confirmLabel}
      </Button>
    </Modal.Footer>
  </Modal>
);
