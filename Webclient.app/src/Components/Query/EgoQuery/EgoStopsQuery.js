import React, { useEffect, useState } from "react";
import { InputGroup } from "react-bootstrap";
import { BiSearch } from "react-icons/bi";
import { ContainerLoading, NoResultsFound } from "../../Common/Loading";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { IsNull } from "../../../Toolbox/ObjectHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import MapManager from "../../../Store/Managers/MapManager";
import { TextHelper } from "../../../Toolbox/TextHelper";

export const EgoStopsQuery = ({ stops, showAll }) => {
    const [filteredList, setFilteredList] = useState(null);

    useEffect(() => {
        if (!Array.isArray(stops)) {
            setFilteredList(null);
            return;
        }
        setFilteredList(showAll ? [...stops] : []);
    }, [showAll, stops]);

    const showDetails = async stop => {
        LoggingBusiness.CreateClientLog("EGO/Durak/Detay Göster", `${stop.duraK_NO}/${stop.duraK_ADI}`);
        const lat = Number.parseFloat(String(stop.lat || "").replace(",", "."));
        const lng = Number.parseFloat(String(stop.lng || "").replace(",", "."));
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

        const mapView = MapManager.GetMapView();
        const point = await GisGraphicsHelper.CreatePoint({ latitude: lat, longitude: lng });
        const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(point);
        MapManager.AddGraphics(graphic, true);
        GisGraphicsHelper.ZoomToGeometry(mapView, point, 17);
    };

    const search = event => {
        const text = event.target.value;
        if (IsNull(text) || text.length <= 2) {
            setFilteredList(showAll ? [...(stops || [])] : []);
            return;
        }
        const needle = TextHelper.TurkishToUpper(text.trim());
        setFilteredList((stops || []).filter(stop =>
            String(stop.duraK_ADI || "").includes(needle) || String(stop.duraK_NO || "").includes(needle)
        ));
    };

    if (stops === null || stops === undefined) return <ContainerLoading />;
    if (stops.length === 0) return <NoResultsFound />;

    return (
        <div className="ego-query-window-items-container">
            <div className="ego-query-window-items-search">
                <InputGroup className="fulltextsearch-text-group ego-query-window-items-search-group">
                    <input autoFocus type="search" className="fulltextsearch-text-input" placeholder="Durak adıyla ya da numarasıyla arayın" onChange={search} aria-label="EGO durağı ara" />
                    <InputGroup.Text className="fulltextsearch-text-icon"><BiSearch size="2rem" aria-hidden="true" /></InputGroup.Text>
                </InputGroup>
            </div>
            {filteredList?.length === 0 ? <NoResultsFound /> : filteredList?.map((stop, index) => (
                <button type="button" key={`${stop.duraK_NO || "stop"}-${index}`} className="ego-query-window-item" onClick={() => showDetails(stop)}>
                    <span className="ego-query-window-item-no">{stop.duraK_NO}</span>
                    <span className="ego-query-window-item-name">{stop.duraK_ADI}</span>
                    <span className="ego-query-window-item-type">{stop.haT_TIPI}</span>
                </button>
            ))}
        </div>
    );
};
