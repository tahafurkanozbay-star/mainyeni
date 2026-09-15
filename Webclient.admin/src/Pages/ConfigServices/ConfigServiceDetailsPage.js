import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Form, Modal } from "react-bootstrap";
import { BsCheckSquare, BsSquare } from "react-icons/bs";
import { ConfigServicesBusiness } from "../../Business/ConfigServicesBusiness";
import { Constants } from "../../Core/Constants";
import { Message } from "../../Components/Message";
import { ContainerLoading } from "../../Components/Loading";
import { MdOutlineApps } from "react-icons/md";

export const ConfigServiceDetailsPage = (props) => {
  const [itemDetails, setItemDetails] = useState(null);
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

    var validationMessage = ConfigServicesBusiness.Validate(itemDetails);

    if (validationMessage.type == Constants.MessageTypes.Error) {

      setMessage(validationMessage);

      return false;

    }
    else {

      setLoading(Constants.LoadingStatus.LOADING);
      ConfigServicesBusiness.Save(itemDetails).then((_result) => {

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
        {loading == Constants.LoadingStatus.LOADING ? <ContainerLoading></ContainerLoading> :
          <Form onSubmit={() => btnSubmit_OnClick()}>
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
              <Form.Label>Kategori</Form.Label>
              <Form.Control
                type="text"
                placeholder="Kategori adı giriniz"
                defaultValue={itemDetails?.category}
                onInput={(e) => setField("category", e.target.value)}
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Tanım</Form.Label>
              <Form.Control
                type="text"
                placeholder="Tanım giriniz"
                defaultValue={itemDetails?.description}
                onInput={(e) => setField("description", e.target.value)}
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Url</Form.Label>
              <Form.Control
                type="text"
                placeholder="Url giriniz"
                defaultValue={itemDetails?.url}
                onInput={(e) => setField("url", e.target.value)}
              />
            </Form.Group>

            <div className="form-section">
              <Form.Group className="mb-3">
                <div
                  onClick={() => setField("requiresSC", !itemDetails?.requiresSC)}
                >
                  {itemDetails?.requiresSC ? (
                    <BsCheckSquare></BsCheckSquare>
                  ) : (
                    <BsSquare></BsSquare>
                  )}
                  <span> Güvenli Bağlantı Gerekiyor</span>
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


            <div className="form-section">
              <Form.Group className="mb-3">
                <div
                  onClick={() => setField("isIdentifiable", !itemDetails?.isIdentifiable)}
                >
                  {itemDetails?.isIdentifiable ? (
                    <BsCheckSquare></BsCheckSquare>
                  ) : (
                    <BsSquare></BsSquare>
                  )}
                  <span> Bilgi alınabilir</span>
                </div>
              </Form.Group>
              {itemDetails?.isIdentifiable && (
                <>
                  <Form.Group className="mb-3">
                    <Form.Label>Bilgi alınabilen katmanlar</Form.Label>
                    <Form.Control
                      type="text"
                      placeholder="Noktalı virgül ile ayırarak giriniz (örn. 1;3;5)"
                      defaultValue={itemDetails?.identifyLayers}
                      onInput={(e) => setField("identifyLayers", e.target.value)}
                    />
                  </Form.Group>
                </>
              )}

            </div>

            <div className="form-section">

              <Form.Group className="mb-3">
                <div
                  onClick={() => setField("showInSearch", !itemDetails?.showInSearch)}
                >
                  {itemDetails?.showInSearch ? (
                    <BsCheckSquare></BsCheckSquare>
                  ) : (
                    <BsSquare></BsSquare>
                  )}
                  <span> Genel aramada göster</span>
                </div>
              </Form.Group>

              {itemDetails?.showInSearch && (
                <>
                  <Form.Group className="mb-3">
                    <Form.Label>Genel arama kategori başlığı</Form.Label>
                    <Form.Control
                      type="text"
                      placeholder="Kategori başlığı giriniz..."
                      defaultValue={itemDetails?.searchCategoryTitle}
                      onInput={(e) => setField("searchCategoryTitle", e.target.value)}
                    />
                  </Form.Group>
                </>
              )}
            </div>
          </Form>
        }
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={() => btnClose_OnClick()}>
          Kapat
        </Button>
        <Button variant="primary" onClick={() => btnSubmit_OnClick()}>
          Kaydet
        </Button>
      </Modal.Footer>
    </Modal>
  );
};
