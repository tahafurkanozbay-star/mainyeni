import React, { useEffect, useImperativeHandle, useState } from "react";
import { loadModules } from "esri-loader";
import { faChevronDown, faChevronUp, faLayerGroup, faTimes } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";

export const BasemapWidget = React.forwardRef((props, ref) => {

    useImperativeHandle(ref, () => ({
        id: props.id,visible:false, minimized:false,
        OnShow:()=>{
            props.windowManager.ShowWindow("sidebar")
        },
        OnClose: () => {
            
        }
    }));

    const [basemapGallery, setBasemapGallery] = useState(null);

    useEffect(() => {

        //Window Manager register window
        props.windowManager.RegisterWindow(ref);

        loadModules(["esri/config", "esri/widgets/BasemapGallery", "esri/Basemap", "esri/layers/MapImageLayer"])
            .then(([esriConfig, BasemapGallery, Basemap, MapImageLayer]) => {

                let basemapLayers = [];

                /*
                self.state.layerList.forEach(layerItem => {
    
                    let basemap = new Basemap({
                        baseLayers: [
                            new MapImageLayer({
                                url: layerItem.Url,
                                title: layerItem.Title
                            })
                        ],
                        title: layerItem.Title,
                        id: layerItem.Title
                    });
    
                    basemapLayers.push(basemap);
    
                });
                */

                let basemapLayerIds = ["topo",
                    "streets",
                    "satellite",
                    "hybrid",
                    "dark-gray",
                    "gray",
                    "national-geographic",
                    "oceans",
                    "osm",
                    "terrain",
                    "dark-gray-vector",
                    "gray-vector",
                    "streets-vector",
                    "streets-night-vector",
                    "streets-navigation-vector",
                    "topo-vector",
                    "streets-relief-vector"];

                basemapLayerIds.forEach(basemapLayerId => {
                    basemapLayers.push(Basemap.fromId(basemapLayerId));
                });


                const basemapGallery = new BasemapGallery({
                    view: MapManager.GetMapView(),
                    container: "basemapGallery",
                    source: basemapLayers
                });

                setBasemapGallery(basemapGallery);

                return;
            });

    }, []);


    return (
        <div className="common-query-window common-query-window-right"
            style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/basemap.png"></img>
                <span>Altlık Haritalar</span>
                <CommonQueryWindowTools 
                    windowManager={props.windowManager}
                    windowId={props.id}
                    showNearbySearch={false}
                    showMapSelect={false}
                    setQueryField={(e)=>{}}
                    query={null}/>
            </div>
            <div className="common-query-window-body">
                <div id="basemapGallery"></div>
            </div>
        </div>
        );
});