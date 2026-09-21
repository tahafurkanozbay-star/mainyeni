import { useEffect, useState } from "react"
import { Constants } from "../Core/Constants";
import { Message } from "../Components/Message";
import { ContainerLoading } from "../Components/Loading";
import { FileUpload } from "../Components/FileUpload";
import { MdOutlineApps } from "react-icons/md";
import { Button, Modal } from "react-bootstrap";
import { ConfigServicesBusiness } from "../Business/ConfigServicesBusiness";

export const ImportSettingsPage = (props) => {

  useEffect(() => {

  }, [props]);


  const [loading, setLoading] = useState(Constants.LoadingStatus.NONE);
  const [message, setMessage] = useState(null);

  const btnClose_OnClick = () => {
    props.close();
  };


  const [files, setFiles] = useState(null);

  const btnSubmit_OnClick = () => {

    setLoading(Constants.LoadingStatus.LOADING);
   
    ConfigServicesBusiness.Import(files).then(_result => {

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

      setLoading(Constants.LoadingStatus.NONE);
    });
  }

  return (
    <Modal show={true} onHide={() => btnClose_OnClick()} dialogClassName="big-modal">
      <Modal.Header closeButton>
        <Modal.Title>
          <MdOutlineApps></MdOutlineApps>
          <span>
            <strong>İçeri Aktar</strong>
          </span>
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Message message={message}></Message>
        {loading == Constants.LoadingStatus.LOADING ? <ContainerLoading></ContainerLoading> :
          <FileUpload setFiles={setFiles}></FileUpload>
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

}