import React, { useEffect, useImperativeHandle, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import { HalkEkmekQueryBusiness } from "../../../Business/HalkEkmekQueryBusiness";
import { BiSearch } from "react-icons/bi";
import { FiMapPin, FiPhone } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { DebugHelper } from "../../../Toolbox/DebugHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ButtonLoading } from "../../Common/Loading";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { useRef } from "react";

export const ABBQueryWindow = React.forwardRef((props, ref) => {

        // Sidebar'ın görünürlüğünü kontrol eden state
        const [isVisible, setIsVisible] = useState(true);
      
        // onClick olayında çağrılacak fonksiyon
        const handleClick = (e) => {
          // windowManager.ShowWindow fonksiyonunu çağır
          props.windowManager.ShowWindow("halkekmek-query-window");      
          // Sidebar'ı gizle
          setIsVisible(false);
        };
      
        
    return (<>


            <div className="sidebar-container"  style={{ display: isVisible ? 'block' : 'none' }}>               
            <div className="sidebar-button sidebar-button-sub" onClick={handleClick}>
            <img className="sidebar-button-icon" src="images/icons/sidebar/alisveris.png"></img>
               </div>
                </div>
    </>);
});