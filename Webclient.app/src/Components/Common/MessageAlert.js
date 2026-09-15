import React from "react";
import { faCheckCircle, faExclamationCircle, faExclamationTriangle, faInfoCircle } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Alert } from "react-bootstrap";

export function MessageAlert(props) {

  let typeIcon = "";
  switch (props.type) {
    case "error":
      typeIcon = <FontAwesomeIcon style={{ color: 'red' }} icon={faExclamationCircle}></FontAwesomeIcon>;
      break;
    case "warning":
      typeIcon = <FontAwesomeIcon style={{ color: 'orange' }} icon={faExclamationTriangle}></FontAwesomeIcon>;
      break;
    case "success":
      typeIcon = <FontAwesomeIcon style={{ color: 'green' }} icon={faCheckCircle}></FontAwesomeIcon>;
      break;
    case "info":
    default:

      typeIcon = <FontAwesomeIcon style={{ color: 'blue' }} icon={faInfoCircle}></FontAwesomeIcon>;
      break;


  }

  return (
    <Alert onClose={props.dismissMessage}
      delay={5000} autohide variant="danger" dismissible
    >
      <Alert.Heading>
        Hata
      </Alert.Heading>
      <p>
        {typeIcon}
        &nbsp;&nbsp;&nbsp;
        {props.message}</p>
    </Alert>

  );
}