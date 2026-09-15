import "./CommonQueryResultItemTools.css";

import { BiCaretRightCircle, BiZoomIn } from "react-icons/bi";
import {TbRoute} from "react-icons/tb";
import { useEffect } from "react";

export const CommonQueryResultItemTools = (props) => {

    useEffect(() => {


    }, [props]);

    const handleEventPropagation=(e)=>{
        e.preventDefault();
        e.stopPropagation();
    }

    const showOnMap=(e)=>{
        handleEventPropagation(e);
        props?.zoomCallback(e, props.item)
    }

    const showRoute=(e)=>{
        handleEventPropagation(e);
        props?.showRouteCallback(e, props.item)
    }

    const showStreetView=(e)=>{
        handleEventPropagation(e);
    }

    return (<>
        <div className="result-item-tools-container">
            <div className="result-item-tool-button" onClick={(e)=>showOnMap(e)}>
                <BiZoomIn className="result-item-tool-button-icon" title="Haritada Göster" />
            </div>
            <div className="result-item-tool-button" onClick={(e)=>showRoute(e)}>
                <TbRoute className="result-item-tool-button-icon" title="Yol Tarifi Al" />
            </div>
        </div>
    </>);
}