import "./CommonQueryResultItemTools.css";
import { BiZoomIn } from "react-icons/bi";
import { TbRoute } from "react-icons/tb";

export const CommonQueryResultItemTools = ({ item, zoomCallback, showRouteCallback }) => {
    const invoke = (event, callback) => {
        event.preventDefault();
        event.stopPropagation();
        callback?.(event, item);
    };

    return (
        <div className="result-item-tools-container" aria-label="Sonuç işlemleri">
            <button type="button" className="result-item-tool-button" onClick={event => invoke(event, zoomCallback)} aria-label="Haritada göster">
                <BiZoomIn className="result-item-tool-button-icon" aria-hidden="true" />
            </button>
            <button type="button" className="result-item-tool-button" onClick={event => invoke(event, showRouteCallback)} aria-label="Yol tarifi al">
                <TbRoute className="result-item-tool-button-icon" aria-hidden="true" />
            </button>
        </div>
    );
};
