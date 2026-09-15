import React, { useEffect, useState } from "react";
import { faCheckCircle, faExclamationCircle, faExclamationTriangle, faInfoCircle } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Toast } from "react-bootstrap";
import MapManager from "../../Store/Managers/MapManager";

export function MessageToast(props) {

  const [message, setMessage] = useState(null);
  useEffect(() => {
    
    var _message = props?.message;
    
    if(_message!=null){

      let currentDate = new Date();
      _message.hours = currentDate.getHours();
      _message.minutes = currentDate.getMinutes();
      _message.seconds = currentDate.getSeconds();

      switch (_message?.messageType) {
        case "error":
          _message.typeIcon = <FontAwesomeIcon style={{ color: 'red' }} icon={faExclamationCircle}></FontAwesomeIcon>;
          break;
        case "warning":
          _message.typeIcon = <FontAwesomeIcon style={{ color: 'orange' }} icon={faExclamationTriangle}></FontAwesomeIcon>;
          break;
        case "success":
          _message.typeIcon = <FontAwesomeIcon style={{ color: 'green' }} icon={faCheckCircle}></FontAwesomeIcon>;
          break;
        case "info":
          _message.typeIcon = <FontAwesomeIcon style={{ color: 'blue' }} icon={faInfoCircle}></FontAwesomeIcon>;
          break;
        default:
          _message.typeIcon = <FontAwesomeIcon style={{ color: '#444' }} icon={faInfoCircle}></FontAwesomeIcon>;
          break;
      }
  
      setMessage(_message);

    }
    else{
      setMessage(null);
    }

   
  },[props]);


  const dismissMessage = () => {
    MapManager.RemoveMessage();
  }

  return (
  
    message && <Toast onClose={dismissMessage}
      delay={5000} autohide
      style={{
        position: 'relative',
        top: 10,
        margin: 'auto'
      }}
    >
      <Toast.Header>
        <img src="holder.js/20x20?text=%20" className="rounded mr-2" alt="" />
        <strong className="mr-auto">
          Mesaj</strong>
        &nbsp;
        <small>{message.hours < 10 ? "0" + message.hours : message.hours}:{message.minutes < 10 ? "0" + message.minutes : message.minutes}:{message.seconds < 10 ? "0" + message.seconds : message.seconds}</small>
      </Toast.Header>
      <Toast.Body>
        {message.typeIcon}
        &nbsp;&nbsp;&nbsp;
        {message.messageText}</Toast.Body>
    </Toast>
  );
}