import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Form, Modal } from "react-bootstrap";
import { BiSave } from "react-icons/bi";
import { BsCheckSquare, BsSquare } from "react-icons/bs";
import { Constants } from "../../Core/Constants";
import { Message } from "../../Components/Message";
import { ContainerLoading } from "../../Components/Loading";
import { MdOutlineApps } from "react-icons/md";
import { BasemapLayerBusiness } from "../../Business/BasemapLayerBusiness";

export const BasemapLayerDetailsPage = (props) => {
  const [itemDetails, setItemDetails] = useState(null);
  const [layerGroups, setLayerGroups] = useState(null);

  useEffect(() => {
    setItemDetails(props.item);

  }, []);

  const btnClose_OnClick = () => {
    props.close();
  };

  const setField = (_field, _value) => {
    
    setMessage(null);
    
    const _itemDetails = { ...itemDetails };
    _itemDetails[_field] = _value;

    setItemDetails(_itemDetails);
  };

  const [loading, setLoading] = useState(Constants.LoadingStatus.NONE);
  const [message, setMessage] = useState(null);
  const btnSubmit_OnClick = () => {
    var validationMessage = BasemapLayerBusiness.Validate(itemDetails);

    if (validationMessage.type == Constants.MessageTypes.Error) {
      setMessage(validationMessage);
      return false;
    } else {
      setLoading(Constants.LoadingStatus.LOADING);
      BasemapLayerBusiness.Save(itemDetails).then((_result) => {

        if (_result.type == Constants.MessageTypes.Success) {

          props.setMessage({
            type: _result.type,
            text: _result.message,
          });

          props.close();
        }
        else {
          setMessage({
            type: _result.type,
            text: _result.message,
          });


        }


        setLoading(Constants.LoadingStatus.SUBMITTED);

      });
    }
  };

  return (
    <Modal
      show={props.item != null}
      onHide={() => btnClose_OnClick()}
      dialogClassName="big-modal"
    >
      <Modal.Header closeButton>
        <Modal.Title>
          <MdOutlineApps></MdOutlineApps>
          <span>
            <strong>Detaylar</strong> &gt; {itemDetails?.title}
          </span>
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Message message={message}></Message>
        {loading == Constants.LoadingStatus.LOADING ? (
          <ContainerLoading></ContainerLoading>
        ) : (
          <Form onSubmit={() => btnSubmit_OnClick()}>
            <div className="row">
              <div className="col-6">
                <Form.Group className="mb-3">
                  <Form.Label>Başlık</Form.Label>
                  <Form.Control
                    type="text"
                    placeholder="Başlık giriniz"
                    defaultValue={itemDetails?.title}
                    onInput={(e) => setField("title", e.target.value)}
                  />
                </Form.Group>

                <Form.Group className="mb-3">
                  <Form.Label>Tanım</Form.Label>
                  <textarea
                    className="form-control"
                    placeholder="Tanım giriniz"
                    onInput={(e) => setField("description", e.target.value)}
                    defaultValue={itemDetails?.description}
                  />
                </Form.Group>
                <Form.Group className="mb-3">
                  <Form.Label>URL</Form.Label>
                  <Form.Control
                    type="text"
                    placeholder="Url giriniz"
                    defaultValue={itemDetails?.url}
                    onInput={(e) => setField("url", e.target.value)}
                  />
                </Form.Group>
              </div>
              <div className="col-6">
                <Form.Group className="mb-3">
                  <div
                    onClick={() =>
                      setField("requiresSC", !itemDetails?.requiresSC)
                    }
                  >
                    {itemDetails?.requiresSC ? (
                      <BsCheckSquare></BsCheckSquare>
                    ) : (
                      <BsSquare></BsSquare>
                    )}
                    &nbsp;
                    <span className="checkbox-label">
                      Güvenli Bağlantı Gerekiyor
                    </span>
                  </div>
                </Form.Group>
                {itemDetails?.requiresSC && (
                  <>
                    <Form.Group className="mb-3">
                      <Form.Label>Kullanıcı adı</Form.Label>
                      <Form.Control
                        type="text"
                        placeholder="Kullanıcı adı giriniz"
                        defaultValue={itemDetails?.scUserName}
                        onInput={(e) => setField("scUserName", e.target.value)}
                      />
                    </Form.Group>
                    <Form.Group className="mb-3">
                      <Form.Label>Şifre</Form.Label>
                      <Form.Control
                        type="text"
                        placeholder="Şifre giriniz"
                        defaultValue={itemDetails?.scPassword}
                        onInput={(e) => setField("scPassword", e.target.value)}
                      />
                    </Form.Group>
                  </>
                )}
              </div>
            </div>
          </Form>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={() => btnClose_OnClick()}>
          Kapat
        </Button>
        <Button
          variant="primary"
          type="submit"
          onClick={() => btnSubmit_OnClick()}
        >
          <BiSave />
          <span>Kaydet</span>
        </Button>
      </Modal.Footer>
    </Modal>
  );
};
