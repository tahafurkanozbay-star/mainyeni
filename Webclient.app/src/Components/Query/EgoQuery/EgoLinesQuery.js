import React, { useEffect, useImperativeHandle, useState } from "react";
import { Accordion, Button, Form, InputGroup, Tab, Tabs } from "react-bootstrap";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import { BiSearch } from "react-icons/bi";
import { ButtonLoading, ContainerLoading, NoResultsFound } from "../../Common/Loading";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { EgoQueryBusiness } from "../../../Business/EgoQueryBusiness";
import { IsNull } from "../../../Toolbox/ObjectHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import MapManager from "../../../Store/Managers/MapManager";
import { TextHelper } from "../../../Toolbox/TextHelper";
import { EgoStopsQuery } from "./EgoStopsQuery";

export const EgoLinesQuery = ({ lines , showAll }) => {

    useEffect(() => {

        if(showAll){
            setfilteredList([...lines]);
        }
    }, [lines]);


    const [activeLineDetails, setActiveLineDetails] = useState(null);
    const [filteredList, setfilteredList] = useState(null);
    const [stopsList, setStopsList] = useState(null);


    const showDetails = async (_line) => {

        LoggingBusiness.CreateClientLog("EGO/Hat/Detay Göster", _line.haT_NO + "/" + _line.haT_ADI);

        const response = await EgoQueryBusiness.GetLineInfo(_line.haT_NO);

        if (response.type == Constants_ServiceResultType.Success) {

            const _details = response.data;

            const _stopsList = _details.duraklar;
            setStopsList(_stopsList);

            const _coordinates = _details.guzergah.split(" ");
            const _points = [];
            for (let index = 0; index < _coordinates.length; index = index + 2) {

                const lat = parseFloat(_coordinates[index].replace(",", ""));
                const lng = parseFloat(_coordinates[index + 1]);

                if (!isNaN(lat) && !isNaN(lng)) {
                    _points.push([lng, lat]);
                }

            }

            const _mapView = MapManager.GetMapView();
            GisGraphicsHelper.CreatePolylineFromXYPoints([_points]).then(_polygon => {

                GisGraphicsHelper.CreateGraphicFromGeometry(_polygon).then(_graphic => {
                    MapManager.AddGraphics(_graphic, true);
                    GisGraphicsHelper.ZoomToGeometryExtent(_mapView, _polygon, 1.5)
                });
            });


            setActiveLineDetails(_details);

        }
    }


    const showStop = (_stop) => {

        const _mapView = MapManager.GetMapView();

        const _lat = parseFloat(_stop.lat.replace(",", "."));
        const _lng = parseFloat(_stop.lng.replace(",", "."));

        GisGraphicsHelper.CreatePoint({ latitude: _lat, longitude: _lng }).then(_point => {

            GisGraphicsHelper.CreateGraphicFromGeometry(_point).then(_graphic => {
                MapManager.AddGraphics(_graphic, false);
                GisGraphicsHelper.ZoomToGeometry(_mapView, _point, 17)
            });

        });

    }


    const search = (e) => {

        const text = e.target.value;

        if (!IsNull(text) && text.length > 2) {
            const filtered = lines.filter(line => line.haT_ADI.includes(TextHelper.TurkishToUpper(text.trim())) || line.haT_NO.includes(TextHelper.TurkishToUpper(text.trim())));
            setfilteredList(filtered);
        }
        else {
            setfilteredList([]);
        }

    }

    return (<>
        {
            lines == null ? <ContainerLoading /> :
                lines.length == 0 ? <NoResultsFound /> :
                    <div className="ego-query-window-items-container">
                        <div className="ego-query-window-items-search">
                            <InputGroup className="fulltextsearch-text-group ego-query-window-items-search-group">
                                <input
                                    autoFocus
                                    type="text"
                                    className="fulltextsearch-text-input"
                                    placeholder="Hat adıyla ya da numarasıyla arayın"
                                    onChange={(e) => search(e)}
                                />
                                <InputGroup.Text className="fulltextsearch-text-icon">
                                    <BiSearch size="2rem" />
                                </InputGroup.Text>
                            </InputGroup>


                        </div>
                        {
                            filteredList?.length == 0 ? <NoResultsFound /> :
                                <Accordion>
                                    {
                                        filteredList?.map((line, index) => {
                                            return (index<20) && <Accordion.Item eventKey={index} key={index}>
                                                <Accordion.Header onClick={(e) => { showDetails(line) }}>
                                                    <div key={index} className="ego-query-window-item">
                                                        <div className="ego-query-window-item-no">{line.haT_NO}</div>
                                                        <div className="ego-query-window-item-name">{line.haT_ADI}</div>
                                                        <div className="ego-query-window-item-type">{line.haT_TIPI}</div>
                                                    </div>
                                                </Accordion.Header>
                                                <Accordion.Body>
                                                    <div className="ego-query-window-item-details">
                                                    <div className="ego-query-window-item-details-header">Hattın geçtiği duraklar</div>
                                                        {
                                                            stopsList == null ? <ContainerLoading /> :
                                                                stopsList.length == 0 ? <NoResultsFound /> :
                                                                   <EgoStopsQuery stops={stopsList} showAll={true}/>
                                                        }
                                                    </div>
                                                </Accordion.Body>
                                            </Accordion.Item>
                                        })
                                    }
                                </Accordion>

                        }
                    </div>
        }

    </>);
}