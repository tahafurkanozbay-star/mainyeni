import { useEffect, useState, useSyncExternalStore } from "react"
import { Button, Form, Modal } from "react-bootstrap";
import { Checkbox } from "../../Components/Checkbox";
import { BiSave } from "react-icons/bi";
import { BsCheckSquare, BsSquare } from "react-icons/bs";
import { LayerGroupBusiness } from "../../Business/LayerGroupBusiness";
import { Constants } from "../../Core/Constants";
import { Message } from "../../Components/Message";
import { ContainerLoading } from "../../Components/Loading";
import { MdOutlineApps } from "react-icons/md";

export const LayerGroupDetailsPage = (props) => {

    const [itemDetails, setItemDetails] = useState(null);
    useEffect(() => {
        setItemDetails(props.item);
    }, []);

    const btnClose_OnClick = () => {

        props.close();
    }


    const setField = (_field, _value) => {

        setMessage(null);
    
        const _itemDetails = { ...itemDetails };
        _itemDetails[_field] = _value;

        setItemDetails(_itemDetails);
    }

    const [loading, setLoading] = useState(Constants.LoadingStatus.NONE)
    const [message, setMessage] = useState(null);
    const btnSubmit_OnClick = () => {

        var validationMessage = LayerGroupBusiness.Validate(itemDetails);

        if (validationMessage.type == Constants.MessageTypes.Error) {
            setMessage(validationMessage);
   
            return false;
        }
        else {
            setLoading(Constants.LoadingStatus.LOADING);
            LayerGroupBusiness.Save(itemDetails).then((_result) => {
                props.setMessage({
                    type: _result.type,
                    text: _result.message
                });
                setLoading(Constants.LoadingStatus.SUBMITTED);
                props.close();
            });
        }
    }

    return (
        <Modal show={props.item != null} onHide={() => btnClose_OnClick()} dialogClassName="big-modal">
            <Modal.Header closeButton>
                <Modal.Title><MdOutlineApps></MdOutlineApps><span><strong>Katman Grubu Detayları</strong> &gt; {itemDetails?.Title}</span></Modal.Title>
            </Modal.Header>
            <Modal.Body>
                <Message message={message}></Message>
                {loading == Constants.LoadingStatus.LOADING ? <ContainerLoading></ContainerLoading> :
                    <Form onSubmit={() => btnSubmit_OnClick()}>
                        <div className="row">
                            <div className="col-12">

                                <Form.Group className="mb-3">
                                    <Form.Label>Başlık</Form.Label>
                                    <Form.Control type="text" placeholder="Başlık giriniz" defaultValue={itemDetails?.title}
                                        onInput={(e) => setField("title", e.target.value)} />
                                </Form.Group>

                            </div>
                        </div>
                    </Form>
                }
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={() => btnClose_OnClick()}>
                    Kapat
                </Button>
                <Button variant="primary" type="submit" onClick={() => btnSubmit_OnClick()}>
                    <BiSave />
                    <span>Kaydet</span>
                </Button>
            </Modal.Footer>
        </Modal>);
}