import React, { useEffect, useImperativeHandle, useState } from "react";
import { Form } from "react-bootstrap";
import { RiCloseCircleFill } from "react-icons/ri";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { DebugHelper } from "../../../Toolbox/DebugHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import "./NumberingQueryWindow.css";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";

export const NumberingQueryWindow = React.forwardRef((props, ref) => {

    useImperativeHandle(ref, () => ({
        id: props.id,visible:false, minimized:false,
        OnShow:()=>{
            props.windowManager.ShowWindow("sidebar")
            
        },
        OnClose: () => {
            if(highlightGraphic!=null){
                GisGraphicsHelper.RemoveGraphics(mapView, highlightGraphic);
                setHighlightGraphic(null);
            }
    
        }
    }));

    const [mapView, setMapView] = useState(null);

    const [districtList, setDistrictList] = useState(null);
    useEffect(() => {

        props.windowManager.RegisterWindow(ref);
        
        const _mapView = MapManager.GetMapView();
        setMapView(_mapView);

        //Window Manager register window
        ;

        NumberingQueryBusiness.GetDistricts().then(_result => {

            if (_result.type == Constants_ServiceResultType.Success) {
                setDistrictList(_result.data);
            }
        });

    }, []);

    const [query, setQuery] = useState({ district: null, districtName: null, nbhood: null, nbhoodName: null, street: null, streetName:null, door: null });
    const setQueryField = (_field, _value) => {
        setQuery( query => {
            return { ...query,[_field]: _value}
         })
    }

    const [nbhoodList, setNbhoodList] = useState(null);
    const cmbDistrict_OnChange = (e) => {

        const districtId = e.target.value;
        const districtName= e.target.selectedOptions[0].text;

        setQueryField("district", districtId);
        setQueryField("districtName", districtName);


        NumberingQueryBusiness.GetDistrictById(districtId).then((_districtResult)=>{
            
            if(_districtResult.type==Constants_ServiceResultType.Success){
            
                const _district=_districtResult.data[0];
                
                zoomToObject([_district.geometry], null)
            }
        });

        setNbhoodList(null);
        setStreetList(null);
        setDoorList(null);

        NumberingQueryBusiness.GetNeighborhoodsOfDistrict(districtId).then((_result) => {
            if (_result.type == Constants_ServiceResultType.Success) {
                setNbhoodList(_result.data);
            }
        });
    }


    const [highlightGraphic, setHighlightGraphic]=useState(null);
    const zoomToObject=(_geometries, _zoomLevel)=>{

        if(highlightGraphic!=null){
            GisGraphicsHelper.RemoveGraphics(mapView, highlightGraphic);
        }

        let _projectPromises=[];
        _geometries.forEach(_geometry => {
            _projectPromises.push(GisGraphicsHelper.ProjectGeometry(_geometry, "4326"));
        });
        
        let _graphicPromises=[];
        Promise.all(_projectPromises).then((_projectedGeometries)=>{


            GisGraphicsHelper.ZoomToGeometry(mapView, _projectedGeometries, _zoomLevel);

            _projectedGeometries.forEach(_geometry=> {
                _graphicPromises.push(GisGraphicsHelper.CreateGraphicFromGeometry(_geometry));
            });

            Promise.all(_graphicPromises).then(_graphics=>{
                setHighlightGraphic(_graphics);
                GisGraphicsHelper.AddGraphics(mapView, _graphics);
            });
        });

    
    }


    const [streetList, setStreetList] = useState(null);
    const cmbNbhood_OnChange = (e) => {
        
        const nbhoodId = e.target.value;
        const nbhoodName= e.target.selectedOptions[0].text;

        NumberingQueryBusiness.GetNeighborhoodById(nbhoodId).then((_nbhoodResult)=>{
            if(_nbhoodResult.type==Constants_ServiceResultType.Success){
                const _nbhood=_nbhoodResult.data[0];
                zoomToObject([_nbhood.geometry],null);
            }
        });


        setQueryField("nbhood", nbhoodId);
        setQueryField("nbhoodName", nbhoodName);

        setStreetList(null);
        setDoorList(null);

        NumberingQueryBusiness.GetStreets(nbhoodId).then((_result) => {
            setStreetList(_result.data);
        });
    }

    const [doorList, setDoorList] = useState(null);
    const cmbStreet_OnChange = (e) => {
        
        const streetId = e.target.value;
        const streetName= e.target.selectedOptions[0].text;

        setQueryField("street", streetId);
        setQueryField("streetName", streetName);


        NumberingQueryBusiness.GetStreetCenterLines(streetId).then((_centerLines)=>{
            
            const _geometries=[];
            _centerLines.forEach(_centerLine => {
                _geometries.push(_centerLine.geometry);
            });
            zoomToObject(_geometries);
        })

        setDoorList(null);

        NumberingQueryBusiness.GetDoors(streetId).then((_result) => {
            setDoorList(_result.data);
        });
    }

    const [door, setDoor] = useState(null);
    const cmbDoor_OnChange = (e) => {

        const doorId = e.target.value;

        setQueryField("door", doorId);

        LoggingBusiness.CreateClientLog("Numarataj/Sorgu", query.districtName+"/"+query.nbhoodName+"/"+query.streetName+"/"+query.door );

        NumberingQueryBusiness.GetDoorById(doorId).then((_result) => {

            if (_result.type == Constants_ServiceResultType.Success) {
                
                const door=_result?.data[0];
                setDoor(door);
                zoomToObject([door.geometry], 18);

            }
        });
    }


    return (
    <div className="common-query-window common-query-window-right"
        style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
        <div className="common-query-window-header">
            <img className="common-query-window-header-icon" src="images/icons/toolbar/adresarama.png"></img>
            <span>Adres Arama</span>
            <CommonQueryWindowTools
                windowManager={props.windowManager}
                windowId={props.id}
                showNearbySearch={false}
                showMapSelect={false}
                setQueryField={(e) => { }}
                query={null} />
        </div>

         <div className="common-query-window-body">
                <Form>
                    <Form.Group>
                        <label className="form-label form-label-white">İlçe</label>
                        <select className="form-select" onChange={((e) => cmbDistrict_OnChange(e))}>
                            <option>Seçiniz..</option>
                            {
                                districtList?.map(_item => {
                                    return <option value={_item.attr.id}>{_item.attr.ad}</option>
                                })
                            }
                        </select>
                    </Form.Group>
                    <Form.Group>
                        <label className="form-label form-label-white">Mahalle</label>
                        <select className="form-select" onChange={((e) => cmbNbhood_OnChange(e))}>
                            <option>Seçiniz..</option>
                            {
                                nbhoodList?.map(_item => {
                                    return <option value={_item.attr.id}>{_item.attr.ad}</option>
                                })
                            }
                        </select>
                    </Form.Group>

                    <Form.Group>
                        <label className="form-label form-label-white">Cadde/Sokak</label>
                        <select className="form-select" onChange={((e) => cmbStreet_OnChange(e))}>
                            <option>Seçiniz..</option>
                            {
                                streetList?.map(_item => {
                                    return <option value={_item.attr.yolid}>{_item.attr.ad}</option>
                                })
                            }
                        </select>
                    </Form.Group>

                    <Form.Group>
                        <label className="form-label form-label-white">Bina No</label>
                        <select className="form-select" onChange={((e) => cmbDoor_OnChange(e))}>
                            <option>Seçiniz..</option>
                            {
                                doorList?.map(_item => {
                                    return <option value={_item.attr.id}>{_item.attr.kapino}</option>
                                })
                            }
                        </select>
                    </Form.Group>
                </Form>

            </div>

    </div>);



    
});