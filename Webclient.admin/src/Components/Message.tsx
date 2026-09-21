import { useEffect, useState } from "react";
import { Alert } from "react-bootstrap";
import { Constants } from "../Core/Constants";
import "./Message.css";
import { BiError } from "react-icons/bi";
import { IoWarningOutline } from "react-icons/io5";
import { TiTickOutline } from "react-icons/ti";
import { BsInfoCircle } from "react-icons/bs";
import {MdCancel} from "react-icons/md";

export const Message = (props) => {

  const [message,setMessage]=useState(null);

  const [currentTimeout,setCurrentTimeout]=useState(null);

  useEffect(()=>{

    setMessage(props.message);
    
    if(currentTimeout){
      clearTimeout(currentTimeout);
    }

    const timeout=setTimeout(() => {
      setMessage(null);
    }, 5000);
    setTimeout(timeout);

  },[props]);


  const dismissMessage=()=>{

    if(currentTimeout){
      clearTimeout(currentTimeout);
    }
    setMessage(null);
  }

  
  var currentDate = new Date();
  var hours = currentDate.getHours();
  var minutes = currentDate.getMinutes();
  var seconds = currentDate.getSeconds();

  var typeIcon = "";
  var variant = "";
  switch (message?.type) {
    case Constants.MessageTypes.Error:
      typeIcon = <BiError className="Message_Container_Icon" style={{ color: 'red' }}></BiError>;
      variant = "danger";
      break;

    case Constants.MessageTypes.Success:
      typeIcon = <TiTickOutline className="Message_Container_Icon" style={{ color: 'green' }}></TiTickOutline>;
      variant = "success";
      break;

    case Constants.MessageTypes.Warning:
      typeIcon = <IoWarningOutline className="Message_Container_Icon" style={{ color: 'yellowgreen' }}></IoWarningOutline>;
      variant = "warning";
      break;
    default:
    case Constants.MessageTypes.Info:
      typeIcon = <BsInfoCircle className="Message_Container_Icon" style={{ color: 'blue' }}></BsInfoCircle>;
      variant = "outline-secondary";
      break;
  }

  document.querySelector('#root').scrollTo(0, 0);

  return (
    message && <Alert className="Message_Container" variant="outline-secondary">
      {typeIcon}
      <span className="Message_Container_Text" dangerouslySetInnerHTML={{ __html: message?.text }}></span>
      <MdCancel className="Message_Dismiss_Button float-end" onClick={()=>dismissMessage()}></MdCancel>
    </Alert>
  );
}