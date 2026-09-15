import React, { useEffect, useState } from "react";
import { Accordion, InputGroup } from "react-bootstrap";
import { Constants_ServiceResultType } from "../../../Core/Constants";
import { BiSearch } from "react-icons/bi";
import { ContainerLoading, NoResultsFound } from "../../Common/Loading";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { EgoQueryBusiness } from "../../../Business/EgoQueryBusiness";
import { IsNull } from "../../../Toolbox/ObjectHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import MapManager from "../../../Store/Managers/MapManager";
import { TextHelper } from "../../../Toolbox/TextHelper";
import { EgoStopsQuery } from "./EgoStopsQuery";

export const EgoLinesQuery = ({ lines, showAll }) => {
    const [filteredList, setFilteredList] = useState(null);
    const [stopsList, setStopsList] = useState(null);

    useEffect(() => {
        if (!Array.isArray(lines)) {
            setFilteredList(null);
            return;
        }
        setFilteredList(showAll ? [...lines] : []);
    }, [lines, showAll]);

    const showDetails = async line => {
        LoggingBusiness.CreateClientLog("EGO/Hat/Detay Göster", `${line.haT_NO}/${line.haT_ADI}`);
        const response = await EgoQueryBusiness.GetLineInfo(line.haT_NO);
        if (response?.type !== Constants_ServiceResultType.Success) return;

        const details = response.data;
        setStopsList(details?.duraklar || []);
        const coordinates = String(details?.guzergah || "").trim().split(/\s+/);
        const points = [];
        for (let index = 0; index + 1 < coordinates.length; index += 2) {
            const lat = Number.parseFloat(coordinates[index].replace(",", "."));
            const lng = Number.parseFloat(coordinates[index + 1].replace(",", "."));
            if (Number.isFinite(lat) && Number.isFinite(lng)) points.push([lng, lat]);
        }
        if (points.length < 2) return;

        const mapView = MapManager.GetMapView();
        const polyline = await GisGraphicsHelper.CreatePolylineFromXYPoints([points]);
        const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(polyline);
        MapManager.AddGraphics(graphic, true);
        GisGraphicsHelper.ZoomToGeometryExtent(mapView, polyline, 1.5);
    };

    const search = event => {
        const text = event.target.value;
        if (IsNull(text) || text.length <= 2) {
            setFilteredList(showAll ? [...(lines || [])] : []);
            return;
        }
        const needle = TextHelper.TurkishToUpper(text.trim());
        setFilteredList((lines || []).filter(line =>
            String(line.haT_ADI || "").includes(needle) || String(line.haT_NO || "").includes(needle)
        ));
    };

    if (lines === null || lines === undefined) return <ContainerLoading />;
    if (lines.length === 0) return <NoResultsFound />;

    return (
        <div className="ego-query-window-items-container">
            <div className="ego-query-window-items-search">
                <InputGroup className="fulltextsearch-text-group ego-query-window-items-search-group">
                    <input autoFocus type="search" className="fulltextsearch-text-input" placeholder="Hat adıyla ya da numarasıyla arayın" onChange={search} aria-label="EGO hattı ara" />
                    <InputGroup.Text className="fulltextsearch-text-icon"><BiSearch size="2rem" aria-hidden="true" /></InputGroup.Text>
                </InputGroup>
            </div>
            {filteredList?.length === 0 ? <NoResultsFound /> : (
                <Accordion>
                    {filteredList?.slice(0, 20).map((line, index) => {
                        const key = `${line.haT_NO || "line"}-${index}`;
                        return (
                            <Accordion.Item eventKey={String(index)} key={key}>
                                <Accordion.Header onClick={() => showDetails(line)}>
                                    <div className="ego-query-window-item">
                                        <div className="ego-query-window-item-no">{line.haT_NO}</div>
                                        <div className="ego-query-window-item-name">{line.haT_ADI}</div>
                                        <div className="ego-query-window-item-type">{line.haT_TIPI}</div>
                                    </div>
                                </Accordion.Header>
                                <Accordion.Body>
                                    <div className="ego-query-window-item-details">
                                        <div className="ego-query-window-item-details-header">Hattın geçtiği duraklar</div>
                                        {stopsList === null ? <ContainerLoading /> : stopsList.length === 0 ? <NoResultsFound /> : <EgoStopsQuery stops={stopsList} showAll />}
                                    </div>
                                </Accordion.Body>
                            </Accordion.Item>
                        );
                    })}
                </Accordion>
            )}
        </div>
    );
};
