import { GisGraphicsHelper } from "../../Toolbox/GisGraphicsHelper";
import { CommonReducer_ActionTypes } from "../Reducers/CommonReducer";
import { MapReducer_ActionTypes } from "../Reducers/MapReducer";
import Store from "../Store";

export const MapManager={

    GetMapView:()=>{
        return Store.getState().Map.MapView;
    },

    GetMapClickEvent:(_event)=>{
        return Store.getState().Map.MapClick;
    },

    SetMapClickEvent:(_event)=>{
        Store.dispatch({
            type: MapReducer_ActionTypes.SetMapClickEvent,
            payload: _event
        });
    },


    SetMobileRightClick:(_value)=>{
        Store.dispatch({
            type: MapReducer_ActionTypes.SetMobileRightClick,
            payload: _value
        });
    },
    GetMobileRightClick:()=>{
        return Store.getState().Map.MobileRightClickEnabled;
    },

    SetConfigurationServices:(_config)=>{
        Store.dispatch({
            type: CommonReducer_ActionTypes.SetConfigurationServices,
            payload: _config
        });
    },

    GetConfigurationServices:()=>{
        return Store.getState().Common.ConfigurationServices;
    },

    SetMapConfiguration:(_config)=>{
        Store.dispatch({
            type: CommonReducer_ActionTypes.SetMapConfiguration,
            payload: _config
        });
    },

    GetMapConfiguration:()=>{
        return Store.getState().Common.MapConfiguration;
    },


    AddGraphics:(_graphic, _removePrevious=false)=>{
        
        const mapView= MapManager.GetMapView();
        
        let graphicsList= Store.getState().Map.Graphics;
            
        if(_removePrevious){
            GisGraphicsHelper.RemoveGraphics(mapView, graphicsList);

            graphicsList=[];    
        }
        graphicsList.push(_graphic);

        GisGraphicsHelper.AddGraphics(mapView, _graphic);
        
        Store.dispatch({
            type: MapReducer_ActionTypes.SetGraphics,
            payload: graphicsList
        });
    },

    RemoveGraphics:(_graphics)=>{
        const mapView= MapManager.GetMapView();
        GisGraphicsHelper.RemoveGraphics(mapView, _graphics);
    },

    RemoveAllGraphics:()=>{
        const mapView= MapManager.GetMapView();
        GisGraphicsHelper.RemoveAllGraphics(mapView);
    }

};

export default MapManager;