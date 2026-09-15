import React, { useEffect, useImperativeHandle, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { TkgmQueryBusiness } from "../../../Business/TkgmQueryBusiness";
import { AppConfig } from "../../../Core/AppConfig";
import MapManager from "../../../Store/Managers/MapManager";
import { IsNull } from "../../../Toolbox/ObjectHelper";
import "./CityBlockParcelQueryWindow.css";
import { BiSearch } from "react-icons/bi";
import { Constants_MessageType } from "../../../Core/Constants";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { RiCloseCircleFill } from "react-icons/ri";
import { ButtonLoading } from "../../Common/Loading";
import { TextHelper } from "../../../Toolbox/TextHelper";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";

export const CityBlockParcelQueryWindow = React.forwardRef((props, ref) => {

    useImperativeHandle(ref, () => ({
        id: props.id, visible: false, minimized: false,
        OnShow: () => {
            props.windowManager.ShowWindow("sidebar")
            
        },
        OnClose: () => {
            
        }
    }));

    const [mapView, setMapView] = useState(null);
    const [districtList, setDistrictList] = useState(null);

    useEffect(() => {

        props.windowManager.RegisterWindow(ref);
        
        const _mapView = MapManager.GetMapView();
        setMapView(_mapView);


        TkgmQueryBusiness.GetDistricts(AppConfig.Api.TkgmCityId).then((_result) => {

            var list = [];
            if (Array.isArray(_result)) {
                _result.forEach(_resultItem => {
                    list.push({
                        id: _resultItem.properties.id,
                        title: _resultItem.properties.text,
                    });
                });

                setDistrictList(list);
            }
            else {
                props.windowManager.ShowMessage(Constants_MessageType.Error, "Tkgm ilçe listesi alınamadı");
            }

        });
    }, []);




    const [nbhoodList, setNbhoodList] = useState(null);
    const cmbDistrict_OnChange = (e) => {

        if (!IsNull(e.target.value)) {

            const _districtId=e.target.value;
            const _districtName=e.target.selectedOptions[0].text;

            TkgmQueryBusiness.GetNeighborhoodsOfDistrict(e.target.value).then((_result) => {

                var list = [];
                _result.forEach(_resultItem => {
                    list.push({
                        id: _resultItem.properties.id,
                        title: _resultItem.properties.text,
                    });
                });
                setNbhoodList(list);
                setQueryField("district", _districtId);
                setQueryField("districtName", _districtName);
            });
        }
        else {
            setNbhoodList(null);
        }
    }

    const cmbNbhood_OnChange = (e) => {
        
        const nbhoodId = e.target.value;
        const nbhoodName= e.target.selectedOptions[0].text;

        setQueryField("nbhood", e.target.value);
        setQueryField("nbhoodName", nbhoodName);
    }

    const [query, setQuery] = useState({ district: 0, nbhood: 0, cityblock: 0, parcel: 0 });
    const setQueryField = (_field, _value) => {
        setQuery( query => {
            return { ...query,[_field]: _value}
         })
    }

    const [loading, setLoading] = useState(false);
    const btnSubmit_OnClick = () => {

        if (validateQuery()) {

            setLoading(true);

            LoggingBusiness.CreateClientLog("Ada Parsel/Sorgu", query.districtName+"/"+query.nbhoodName+"/"+query.cityblock+"/"+query.parcel);

            TkgmQueryBusiness.GetParcels(query).then((_result) => {

                if (_result.geometry != null) {
                    gotoParcel(_result);
                }
                else {
                    props.windowManager.ShowMessage(Constants_MessageType.Error, "Parsel bulunamadı");
                }

                setLoading(false);
                
            }).catch(error => {
                props.windowManager.ShowMessage(Constants_MessageType.Error, error.message);
                setLoading(false);
            });
        }
    }

    /*Business*/
    const gotoParcel = (item) => {

        LoggingBusiness.CreateClientLog("Ada Parsel/Detay Göster", query.districtName+"/"+query.nbhoodName+"/"+query.cityblock+"/"+query.parcel);

        //self.removeLatestGraphics();
        GisGraphicsHelper.CreatePolygonFromXYPoints(item.geometry.coordinates).then(_geometry => {

            GisGraphicsHelper.CreateGraphicFromGeometry(_geometry).then(_graphic => {

                GisGraphicsHelper.AddGraphics(mapView, _graphic);
                GisGraphicsHelper.ZoomToGeometryExtent(mapView, _geometry, 3);
                
            });

        });

    }

    const validateQuery = () => {

        var message = "";
        if (query.parcel == 0) { message = "Lütfen parsel no giriniz..."; }
        if (query.cityblock == 0) { message = "Lütfen ada no giriniz..."; }
        if (query.nbhood == 0) { message = "Lütfen mahalle seçiniz..."; }
        if (query.district == 0) { message = "Lütfen ilçe seçiniz..."; }
        if (!IsNull(message)) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, message);
        }
        return IsNull(message);
    }


    return (<>

<div className="common-query-window common-query-window-right"
        style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
        <div className="common-query-window-header">
            <img className="common-query-window-header-icon" src="images/icons/toolbar/adaparsel.png"></img>
            <span>Ada-Parsel Arama</span>
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
                        <select className="form-select" onChange={(e) => cmbDistrict_OnChange(e)} value={query.district}>
                            <option value="">Seçiniz..</option>
                            {
                                districtList?.map(_item => {
                                    return <option key={TextHelper.CreateRandomNumber()} value={_item.id}>{_item.title}</option>
                                })
                            }
                        </select>
                    </Form.Group>
                    <Form.Group>
                        <label className="form-label form-label-white">Mahalle</label>
                        <select className="form-select" value={query.nbhood}
                            onChange={(e) => cmbNbhood_OnChange(e)}>
                            <option value="">Seçiniz..</option>
                            {
                                nbhoodList?.map(_item => {
                                    return <option key={TextHelper.CreateRandomNumber()} value={_item.id}>{_item.title}</option>
                                })
                            }
                        </select>
                    </Form.Group>

                    <Form.Group>
                        <label className="form-label form-label-white">Ada</label>
                        <input type="text" className="form-control" onChange={(e) => setQueryField("cityblock", e.target.value)} />
                    </Form.Group>

                    <Form.Group>
                        <label className="form-label form-label-white">Parsel</label>
                        <input type="text" className="form-control" onChange={(e) => setQueryField("parcel", e.target.value)} />
                    </Form.Group>

                    <Form.Group>
                        {
                            loading ? <ButtonLoading />
                                : <Button type="button" className="form-button" onClick={(e) => btnSubmit_OnClick()}>
                                    <BiSearch className="form-button-icon" /><span>Sorgula</span>
                                </Button>
                        }

                    </Form.Group>
                </Form>

            </div>
            </div>
       
    </>);
});