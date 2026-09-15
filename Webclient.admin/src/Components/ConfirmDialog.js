import { Button, Modal } from "react-bootstrap";
import { ImWarning } from "react-icons/im";

export const ConfirmDialog = (props) => {


    const btnCancel_OnClick=()=>{
        props.CancelCallBack();
    }

    const btnAccept_OnClick=()=>{
        props.AcceptCallBack();
    }

    return (<>
        <Modal show={true} onHide={() => btnCancel_OnClick()}>
            <Modal.Header closeButton>
                <Modal.Title>Onay</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                <div className="confirm-dialog-container">
                    <div className="row">
                        <div className="col-2"><ImWarning className="icon-8x"></ImWarning></div>
                        <div className="col-10">{props.text}</div>
                    </div>
                    
                </div>
                <Button variant="secondary" onClick={() => btnCancel_OnClick()}>
                    Vazgeç
                </Button>
                
                <Button variant="danger" className="float-end" onClick={() => btnAccept_OnClick()}>
                    Evet
                </Button>
            </Modal.Body>
        </Modal>
    </>
    );
}