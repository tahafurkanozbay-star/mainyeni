import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faTimes, faLayerGroup, faChevronDown, faChevronUp, faCheckSquare, faMinusSquare, faSquare } from "@fortawesome/free-solid-svg-icons";
import { LayerBusiness } from "../../../Business/LayerBusiness";
import { Constants_ServiceResultType } from "../../../Core/Constants";
import { MapManager } from "../../../Store/Managers/MapManager";
import { loadModules } from "esri-loader";
import { Accordion, Form, Tab, Tabs } from "react-bootstrap";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { ContainerLoading, NoResultsFound } from "../../Common/Loading";
import { DynamicLayerManager } from "../../../Store/Managers/DynamicLayerManager";
import { TextHelper } from "../../../Toolbox/TextHelper";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import "./LayerListWidget.css";
import { BiCheckCircle, BiCircle, BiMinusCircle } from "react-icons/bi";

export const LayerListWidget = React.forwardRef((props, ref) => {

    useImperativeHandle(ref, () => ({
        id: props.id,visible:false, minimized:false,
        OnShow:()=>{
            props.windowManager.ShowWindow("sidebar"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
            const _mapView = MapManager.GetMapView();
            _mapView.map.removeAll();
            fetchQueryResults();
        },
        OnClose: () => {
          
            
        }
    }));

    const [LayerGroups, setLayerGroups] = useState(null);
    const [mapView, setMapView] = useState(null);

    const [activeGroup, setActiveGroup] = useState(null);
    const [legend, setLegend] = useState(null);






    useEffect(() => {

        props.windowManager.RegisterWindow(ref);  
        fetchQueryResults();      
      

    }, []);

    const fetchQueryResults = () => {
        
        const _mapView = MapManager.GetMapView();       
        setMapView(_mapView);
        _mapView.map.removeAll();

        LayerBusiness.GetLayers().then((_result) => {

            if (_result?.type == Constants_ServiceResultType.Success) {

                const layerGroups = _result?.data ?? [];
                const _layerObjs = [];
                
                if (layerGroups.length > 0) {
                    // İlk dizini (birinci eleman) al
                    const firstGroup = layerGroups[2];
                    console.log("First Layer Group:", firstGroup);
                
                    let layerCount = 0;
                    firstGroup?.layers.forEach(_layerItem => { layerCount++; });
                
                    firstGroup?.layers.forEach(_layerItem => {
                
                        CommonBusiness.AddProxyRule(CommonBusiness.GenerateUrl(_layerItem), "LayerListWidget");
                        CommonBusiness.CreateLayer(_layerItem).then((_layerObj) => {
                
                            if (_layerObj != null) {
                
                                _layerItem.priority = layerCount - parseInt(_layerItem.priority);
                                _layerItem.layerObj = _layerObj;
                
                                _mapView.map.add(_layerObj, _layerItem.priority);
                
                                _layerObjs.push(_layerObj);
                
                                _layerObj.when(() => {
                                    //refreshLegend();
                                });
                            }
                        });
                    });
                    setLayerGroups(layerGroups);
                
            }
            else {
                setLayerGroups([]);
            }
        }

        });
    }

    const toggleGroupVisibility = (e, _groupIndex) => {

        e.stopPropagation();

        const _LayerGroups = [...LayerGroups];
        const _visible = !_LayerGroups[_groupIndex].visible;

        _LayerGroups[_groupIndex].layers.forEach(_layer => {

            const layerObj = _layer.layerObj;//mapView.map.findLayerById(layer.id);

            _layer.visible = _visible;
            layerObj.visible = _visible;
        });

        _LayerGroups[_groupIndex].visible = _visible;
        _LayerGroups[_groupIndex].semiVisible = false;

        setLayerGroups(_LayerGroups);

    };

    const toggleLayerVisibility = (e, layer, _groupIndex, _layerIndex) => {

        const layerObj = layer.layerObj;//mapView.map.findLayerById(layer.id);
        
        if(layerObj!=null){

            layerObj.visible = !layerObj.visible;

            const _LayerGroups = [...LayerGroups];
    
            const _LayerGroup = _LayerGroups[_groupIndex];
            _LayerGroup.layers[_layerIndex].visible = layerObj.visible;
    
            const _layerGroup = evaluateGroupVisibility(_LayerGroup);
            _LayerGroups[_groupIndex] = _layerGroup;
    
            setLayerGroups(_LayerGroups);
            
        }
       
    };

    const evaluateGroupVisibility = (_layerGroup) => {

        let visibleLayersCount = 0;
        _layerGroup?.layers.forEach(_layer => {
            if (_layer.visible) {
                visibleLayersCount++;
            }
        });

        if (visibleLayersCount == 0) {
            _layerGroup.visible = false;
            _layerGroup.semiVisible = false;
        }
        if (visibleLayersCount == _layerGroup.layers.length) {
            _layerGroup.visible = true;
            _layerGroup.semiVisible = false;
        }
        if (visibleLayersCount < _layerGroup.layers.length && visibleLayersCount > 0) {
            _layerGroup.visible = false;
            _layerGroup.semiVisible = true;
        }
        return _layerGroup;
    }

    const changeLayerOpacity = (e, layer, _groupIndex, _layerIndex) => {


        let opacity = e.target.value;

        //const layerObj = mapView.map.findLayerById(layer.id);
        const layerObj = layer.layerObj;//mapView.map.findLayerById(layer.id);

        layerObj.opacity = opacity / 100;

        const _LayerGroups = [...LayerGroups];

        const _layerGroup = _LayerGroups[_groupIndex];
        _layerGroup.layers[_layerIndex].opacity = opacity;
        _LayerGroups[_groupIndex] = _layerGroup;

        setLayerGroups(_LayerGroups);
    };


    const refreshLegend = () => {

        if (legend==null) {

            loadModules(["esri/widgets/Legend"])
                .then(([Legend]) => {

                    let legend = new Legend({
                        view: mapView,
                        container: "legendDiv"
                    });

                    setLegend(legend);
                });
        }
        
    }

    return (
        <div className="common-query-window common-query-window-right"
            style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/katmanyonetimi.png"></img>
                <span>Katmanlar</span>
                <CommonQueryWindowTools 
                    windowManager={props.windowManager}
                    windowId={props.id}
                    showNearbySearch={false}
                    showMapSelect={false}
                    setQueryField={(e)=>{}}
                    query={null}/>
            </div>
            <div className="common-query-window-body layer-list-window-body">
                {
                    LayerGroups == null ? <ContainerLoading /> :
                        props.windowManager.IsMinimized(props.id) ? <div></div> :
                            <Tabs defaultActiveKey="layers" onSelect={((e) => refreshLegend())} >
                                <Tab eventKey="layers" title="Katmanlar">
                                    <div>
                                        {
                                            DynamicLayerManager.List?.length > 0 ?
                                                <Accordion defaultActiveKey="dynamiclayers">
                                                    <Accordion.Item eventKey="dynamiclayers">
                                                        <Accordion.Header>
                                                            <div className="row w-100">
                                                                <div className="col-1">
                                                                    <FontAwesomeIcon icon={faLayerGroup} className="layer-list-group-title-icon"></FontAwesomeIcon>
                                                                </div>
                                                                <div className="col-11 layer-list-group-title">
                                                                    <span>Özel Katmanlar</span>
                                                                </div>
                                                            </div>
                                                        </Accordion.Header>
                                                        <Accordion.Body>
                                                            {
                                                                DynamicLayerManager.List?.map((layer, _layerIndex) => {
                                                                    return (
                                                                        <div className="layer-list-item"
                                                                            eventKey={TextHelper.CreateGuid()}
                                                                            key={TextHelper.CreateGuid()}>
                                                                            <div className="col-1">
                                                                                <FontAwesomeIcon icon={faLayerGroup} size="1x"></FontAwesomeIcon>
                                                                            </div>
                                                                            <div className="col-8 layer-list-item-title">
                                                                                {layer.title}
                                                                            </div>
                                                                            <div className="col-3">

                                                                            </div>
                                                                        </div>);
                                                                })
                                                            }
                                                        </Accordion.Body>
                                                    </Accordion.Item>
                                                </Accordion> : null
                                        }


                                        <Accordion defaultActiveKey={activeGroup}>
                                            {
                                                LayerGroups == null ? <ContainerLoading></ContainerLoading> :
                                                    LayerGroups?.length == 0 ? <NoResultsFound message="Gösterilecek katman bulunmuyor"></NoResultsFound> :
                                                        LayerGroups?.map((_group, _groupIndex) => {

                                                            let _groupKey = _group.id;
                                                            return (<Accordion.Item
                                                                key={_groupKey}
                                                                eventKey={_groupKey}
                                                                className="layer-list-group-accordion-item">
                                                                <Accordion.Header className="layer-list-group-accordion-item-header">
                                                                    <div className="row w-100">
                                                                        <div className="col-1"
                                                                            onClick={(e) => { toggleGroupVisibility(e, _groupIndex) }}>
                                                                            {
                                                                                _group.visible ?
                                                                                    <BiCheckCircle className="layer-list-group-title-icon"/>
                                                                                    : _group.semiVisible ?
                                                                                        <BiMinusCircle className="layer-list-group-title-icon"/>
                                                                                        : <BiCircle className="layer-list-group-title-icon"/>
                                                                            }
                                                                        </div>
                                                                        <div className="col-11 s layer-list-group-title" onClick={() => { setActiveGroup(_groupKey) }}>
                                                                            <span>{_group.title}</span>
                                                                        </div>
                                                                    </div>
                                                                </Accordion.Header>
                                                                <Accordion.Body>
                                                                    {
                                                                        _group.layers.map((layer, _layerIndex) => {
                                                                            return (
                                                                                <div className="layer-list-item row"
                                                                                    key={TextHelper.CreateGuid()} >
                                                                                    <div className="col-1" onClick={(e) => { toggleLayerVisibility(e, layer, _groupIndex, _layerIndex) }}>
                                                                                        {
                                                                                            layer.visible ?
                                                                                                <BiCheckCircle size="2rem" />
                                                                                                : <BiCircle size="2rem" />}
                                                                                    </div>
                                                                                    <div className="col-8 layer-list-item-title" onClick={(e) => { toggleLayerVisibility(e, layer, _groupIndex, _layerIndex) }}>
                                                                                        {layer.title}
                                                                                    </div>
                                                                                    <div className="col-3">
                                                                                        <Form>
                                                                                            <Form.Group>
                                                                                                <Form.Range
                                                                                                    value={layer.opacity}
                                                                                                    onInput={(e) => { changeLayerOpacity(e, layer, _groupIndex, _layerIndex) }} />
                                                                                            </Form.Group>
                                                                                        </Form>
                                                                                    </div>
                                                                                </div>);
                                                                        })
                                                                    }
                                                                </Accordion.Body>
                                                            </Accordion.Item>);
                                                        })
                                            }
                                        </Accordion>
                                    </div>
                                </Tab>

                                <Tab eventKey="legend" title="Lejant">
                                    <div className="legend-container">
                                        
                                        <div id="legendDiv"></div>
                                    </div>

                                </Tab>
                            </Tabs>

                }

            </div>
        </div>)
});