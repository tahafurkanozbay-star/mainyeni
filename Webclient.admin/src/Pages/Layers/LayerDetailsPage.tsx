import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Form, InputGroup, Modal } from "react-bootstrap";
import { Checkbox } from "../../Components/Checkbox";
import { BiSave } from "react-icons/bi";
import { BsCheckSquare, BsSquare } from "react-icons/bs";
import { LayerGroupBusiness } from "../../Business/LayerGroupBusiness";
import { LayerBusiness } from "../../Business/LayerBusiness";
import { Constants } from "../../Core/Constants";
import { Message } from "../../Components/Message";
import { ContainerLoading } from "../../Components/Loading";
import { MdOutlineApps } from "react-icons/md";

export const LayerDetailsPage = (props) => {
  const [itemDetails, setItemDetails] = useState(null);
  const [layerGroups, setLayerGroups] = useState(null);

  useEffect(() => {
    LayerGroupBusiness.List().then((_result) => {
      setLayerGroups(_result.data);
    });

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
    var validationMessage = LayerBusiness.Validate(itemDetails);

    if (validationMessage.type == Constants.MessageTypes.Error) {
      
      setMessage(validationMessage);

      
      return false;

    } else {
      setLoading(Constants.LoadingStatus.LOADING);
      LayerBusiness.Save(itemDetails).then((_result) => {

        if(_result.type == Constants.MessageTypes.Success){

          props.setMessage({
            type: _result.type,
            text: _result.message,
          });
  
          props.close();
        }
        else{
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
                  <Form.Label>Katman Grubu</Form.Label>
                  <select
                    className="form-control"
                    value={itemDetails?.gisLayerGroupId}
                    onChange={(e) =>
                      setField("gisLayerGroupId", e.target.value)
                    }
                  >
                    <option value={null}>Seçiniz...</option>
                    {layerGroups?.map((x) => {
                      return <option value={x.id}>{x.title}</option>;
                    })}
                  </select>
                </Form.Group>
                <Form.Group className="mb-3">
                  <Form.Label>Katman Tipi</Form.Label>
                  <select
                    className="form-control"
                    value={itemDetails?.layerType}
                    onChange={(e) => setField("layerType", parseInt(e.target.value))}
                  >
                    <option value={null}>Seçiniz...</option>
                    {Constants.LayerTypes?.map((x) => {
                      return <option value={x[1]}>{x[0]}</option>;
                    })}
                  </select>
                </Form.Group>

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
                    placeholder="url giriniz"
                    defaultValue={itemDetails?.url}
                    onInput={(e) => setField("url", e.target.value)}
                  />
                </Form.Group>
              </div>
              <div className="col-6">
                <Form.Group className="mb-3">
                  <Form.Label>Öncelik</Form.Label>
                  <Form.Control
                    type="text"
                    placeholder="Katman sırasını giriniz"
                    defaultValue={itemDetails?.orderPriority}
                    onInput={(e) => setField("orderPriority", parseInt(e.target.value))}
                  />
                </Form.Group>

                <Form.Group className="mb-3">
                  <div
                    onClick={() =>
                      setField(
                        "visibleAtStartup",
                        !itemDetails?.visibleAtStartup
                      )
                    }
                  >
                    {itemDetails?.visibleAtStartup ? (
                      <BsCheckSquare></BsCheckSquare>
                    ) : (
                      <BsSquare></BsSquare>
                    )}
                    &nbsp;
                    <span className="checkbox-label">Başlangıçta Göster</span>
                  </div>
                </Form.Group>

                <Form.Group className="mb-3">
                  <Form.Label>Başlangıç Saydamlığı - {itemDetails?.startupOpacity}</Form.Label>
                  
                  <Form.Range
                    title=""
                    value={itemDetails?.startupOpacity}
                    onInput={(e) => setField("startupOpacity", parseInt(e.target.value))}
                  />
                  
                </Form.Group>

                <Form.Group className="mb-3">
                  <div
                    onClick={() =>
                      setField("isSwipeLayer", !itemDetails?.isSwipeLayer)
                    }
                  >
                    {itemDetails?.isSwipeLayer ? (
                      <BsCheckSquare></BsCheckSquare>
                    ) : (
                      <BsSquare></BsSquare>
                    )}
                    &nbsp;<span className="checkbox-label">Swipe Katmanı</span>
                  </div>
                </Form.Group>
                <Form.Group className="mb-3">
                  <div
                    onClick={() =>
                      setField("isTimelineLayer", !itemDetails?.isTimelineLayer)
                    }
                  >
                    {itemDetails?.isTimelineLayer ? (
                      <BsCheckSquare></BsCheckSquare>
                    ) : (
                      <BsSquare></BsSquare>
                    )}
                    &nbsp;
                    <span className="checkbox-label">Zamansal Katman</span>
                  </div>
                </Form.Group>
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
