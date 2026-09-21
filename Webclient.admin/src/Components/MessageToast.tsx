import { Component } from "react";
import { Container, Row, Col, Toast, Button } from "react-bootstrap";
import {BsShieldExclamation,BsInfoCircle} from "react-icons/bs";
import {ImWarning} from "react-icons/im";

export function MessageToast(props) {

  var currentDate = new Date();
  var hours = currentDate.getHours();
  var minutes = currentDate.getMinutes();
  var seconds = currentDate.getSeconds();

  var typeIcon = "";
  switch (props.type) {
    case "error":
      typeIcon = <BsShieldExclamation style={{ color: 'red' }}></BsShieldExclamation>;
      break;
    case "warning":
      typeIcon = <ImWarning style={{ color: 'orange' }}></ImWarning>;
      break;
    default:
    case "info":
      typeIcon = <BsInfoCircle style={{ color: 'blue' }}></BsInfoCircle>;
      break;
  }

  return (
    <Toast onClose={props.dismissMessage}
      delay={4000} autohide
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
          &nbsp;&nbsp;&nbsp;&nbsp;
        <small>{hours < 10 ? "0" + hours : hours}:{minutes < 10 ? "0" + minutes : minutes}:{seconds < 10 ? "0" + seconds : seconds}</small>
      </Toast.Header>
      <Toast.Body>
        {typeIcon}
          &nbsp;&nbsp;&nbsp;
          {props.message}</Toast.Body>
    </Toast>
  );
}