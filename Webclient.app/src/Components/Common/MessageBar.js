import React, { useEffect, useState } from "react";
import { faCheckCircle, faExclamationCircle, faExclamationTriangle, faInfoCircle } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Toast } from "react-bootstrap";
import MapManager from "../../Store/Managers/MapManager";
import "./MessageBar.css";
import { Constants_MessageType } from "../../Core/Constants";
import { BiAlarmExclamation, BiBadgeCheck, BiError, BiInfoCircle } from "react-icons/bi";

export function MessageBar(props) {

    const [message, setMessage] = useState(null);
    useEffect(() => {

        var _message = props?.message;

        if (_message != null) {

            let currentDate = new Date();
            _message.hours = currentDate.getHours();
            _message.minutes = currentDate.getMinutes();
            _message.seconds = currentDate.getSeconds();

            switch (_message?.messageType) {
                case Constants_MessageType.Error:
                    _message.typeIcon = <BiError className="message-bar-icon" style={{ color: 'red' }}></BiError>;
                    break;
                case Constants_MessageType.Warning:
                    _message.typeIcon = <BiAlarmExclamation  className="message-bar-icon" style={{ color: 'orange' }}></BiAlarmExclamation>;
                    break;
                case Constants_MessageType.Success:
                    _message.typeIcon = <BiBadgeCheck  className="message-bar-icon" style={{ color: 'green' }}></BiBadgeCheck>;
                    break;
                case Constants_MessageType.Info:
                    _message.typeIcon = <BiInfoCircle  className="message-bar-icon" style={{ color: 'blue' }}></BiInfoCircle>;
                    break;
                default:
                    _message.typeIcon = <BiInfoCircle  className="message-bar-icon" style={{ color: '#444' }}></BiInfoCircle>;
                    break;
            }

            setMessage(_message);

        }
        else {
            setMessage(null);
        }


    }, [props]);


    const dismissMessage = () => {
        MapManager.RemoveMessage();
    }

    return (

        message && <div className="message-bar">
            {message.typeIcon}
            &nbsp;&nbsp;
            {message.messageText}
        </div>
    );
}