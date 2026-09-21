import { lazy, Suspense, useEffect, useState } from "react";
import { Breadcrumb, Button, Form } from "react-bootstrap";
import { MdOutlineApps } from "react-icons/md";
import { SettingsBusiness } from "../../Business/SettingsBusiness";
import { ContainerLoading } from "../../Components/Loading";
import { Message } from "../../Components/Message";
import { Constants } from "../../Core/Constants";
import { IsNull } from "../../Core/Toolbox/ObjectHelper";

const LazyMap = lazy(async () => ({
    default: (await import("../../Components/Map")).Map,
}));

export const MapSettingsPage = () => {

    useEffect(() => {

        getSettings();

    }, []);

    const configKey="GisMapConfig";

    const [mapLoading, setMapLoading] = useState(Constants.LoadingStatus.LOADING);
    const [loading, setLoading] = useState(Constants.LoadingStatus.LOADING);

    const [message, setMessage] = useState(null);
    
    const [itemDetails, setItemDetails] = useState({
        Centerx:34,
        Centery:40,
        Zoom:5,
        DefaultBasemapTitle:"osm"
    });

    const getSettings=()=>{

        SettingsBusiness.Get(configKey).then((_result) => {
            
            if (_result.type==Constants.MessageTypes.Success) {
                
                if(!IsNull(_result.data.configValue)){
                    const settings=JSON.parse(_result.data.configValue);
                    
                    
                    if(!IsNull(settings.Zoom)){
                        setItemDetails(settings);
                    }
                    
                }

                setLoading(Constants.LoadingStatus.NONE);
                setMapLoading(Constants.LoadingStatus.SUBMITTED);
            }
        });
    }

    const setField = (_field, _value) => {

        setMessage(null);
    
        const _itemDetails = { ...itemDetails };
        _itemDetails[_field] = _value;      
        setItemDetails(_itemDetails);
    }

    const exportCallBack=(_details)=>{
    
        setMessage(null);
        
        const _itemDetails = { ...itemDetails };
        _itemDetails.Zoom=_details.Zoom;
        _itemDetails.Centerx=_details.Center.longitude;
        _itemDetails.Centery=_details.Center.latitude;


        setItemDetails(_itemDetails);
    }


    const btnSubmit_OnClick = () => {

        if (loading != Constants.LoadingStatus.LOADING) {

            setLoading(Constants.LoadingStatus.LOADING);

            var validationMessage = SettingsBusiness.ValidateGisMapConfig(itemDetails);

            if (validationMessage.type == Constants.MessageTypes.Error) {
                
                setMessage(validationMessage);
                setLoading(Constants.LoadingStatus.SUBMITTED);
                return false;
    
            }
            else 
            {
                
                let config={
                    ConfigKey:configKey,
                    ConfigValue:JSON.stringify(itemDetails)
                }
                
                SettingsBusiness.Save(config).then((_result)=>{
                    setMessage({
                        type: _result.type,
                        text: _result.message
                    });
    
                    setLoading(Constants.LoadingStatus.SUBMITTED);
                
                });
            }

        }
       
    }


    return (<>
        <div className="page">
            <div className="page-title">
                <MdOutlineApps></MdOutlineApps>
                <span>Harita Ayarları</span>   
            </div>
            {
               <Message message={message}></Message>
            }
            <div className="page-body">
                <div className="row">
                    <div className="col-6">
                        <Form onSubmit={(e)=>{ e.preventDefault();btnSubmit_OnClick()}}>
                            <Form.Group className="mb-3" controlId="formBasicEmail">
                                <Form.Label>Başlangıç Merkez Noktası X</Form.Label>
                                <Form.Control type="text" 
                                              placeholder="Koordinat giriniz (örn. 29.04859)" 
                                              value={itemDetails.Centerx} 
                                              onInput={(e) => setField("Centerx", e.target.value)} />
                            </Form.Group>
                            <Form.Group className="mb-3" controlId="formBasicEmail">
                                <Form.Label>Başlangıç Merkez Noktası Y</Form.Label>
                                <Form.Control type="text" 
                                              placeholder="Koordinat giriniz (örn. 29.04859)" 
                                              value={itemDetails.Centery} 
                                              onInput={(e) => setField("Centery", e.target.value)} />
                            </Form.Group>

                            <Form.Group className="mb-3" controlId="formBasicEmail">
                                <Form.Label>Başlangıç Zoom</Form.Label>
                                <Form.Control type="text" 
                                              placeholder="Zoom seviyesi giriniz (örn. 12)" 
                                              value={itemDetails.Zoom} 
                                              onInput={(e) => setField("Zoom", e.target.value)} />
                            </Form.Group>

                            <Form.Group className="mb-3" controlId="formBasicEmail">
                                <Form.Label>Varsayılan Atlık Harita</Form.Label>
                                <select className="form-control" defaultValue={itemDetails?.DefaultBasemapTitle} 
                                        onChange={(e) => setField("DefaultBasemapTitle", e.target.value)} >
                                    <option value="topo">topo</option>
                                    <option value="streets">streets</option>
                                    <option value="satellite">satellite</option>
                                    <option value="hybrid">hybrid</option>
                                    <option value="dark-gray">dark-gray</option>
                                    <option value="gray">gray</option>
                                    <option value="national-geographic">national-geographic</option>
                                    <option value="oceans">oceans</option>
                                    <option value="osm">osm</option>
                                    <option value="terrain">terrain</option>
                                    <option value="dark-gray-vector">dark-gray-vector</option>
                                    <option value="gray-vector">gray-vector</option>
                                    <option value="streets-vector">streets-vector</option>
                                    <option value="streets-night-vector">streets-night-vector</option>
                                    <option value="streets-navigation-vector">streets-navigation-vector</option>
                                    <option value="topo-vector">topo-vector</option>
                                    <option value="streets-relief-vector">streets-relief-vector</option>
                                </select>
                            </Form.Group>


                            <Button variant="primary" type="submit">
                                Kaydet
                            </Button>
                        </Form>

                    </div>
                    <div className="col-6">
                        {
                            (mapLoading==Constants.LoadingStatus.SUBMITTED) &&
                            <Suspense fallback={<ContainerLoading text="Harita modülü yükleniyor" />}>
                                <LazyMap config={itemDetails} exportCallBack={exportCallBack} />
                            </Suspense> 
                        }
                    
                    </div>
                </div>

            </div>
        </div>

    </>);
}