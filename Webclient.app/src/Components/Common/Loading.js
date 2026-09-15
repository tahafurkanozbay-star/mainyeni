import React from "react";
import { Button } from "react-bootstrap";
import { AppConfig } from "../../Core/AppConfig";
import "./Loading.css";
import "./Loading-CircleLoader.css";

export const CircleLoading = () => {
    return (<div className="circle-loader-container"><div className="lds-ring"><div></div><div></div><div></div><div></div></div></div>);
}

export const MiniLoading = () => {
    return (<div className="MiniLoading">
        <img src="images/ajax-loader.gif"></img></div>);
}

export const ButtonLoading = (props) => {
    return (<Button className="loading-button"
        disabled={true}>
        
            <div class="mini-spinner">
            </div>
        &nbsp;&nbsp;&nbsp;
        {
            props.message ?? "Lütfen bekleyin..."
        }
    </Button>);
}

export const ContainerLoading = (props) => {
    return (<div className="w-100 h-100 full-screen-div">
        <img src="images/ajax-loader.gif"></img>
        &nbsp;&nbsp;&nbsp;
        {props.message ?? "Lütfen bekleyin..."}
    </div>);
}

export const FullScreenLoading = (props) => {
    return (<div className="FullScreenLoading">

        <div className="fullscreenloading-container">
        <div class="spinner-loading-container">
                <div class="spinner-loading">
                    <div></div>
                    <div></div>
                    <div></div>
                    <div></div>
                </div>
            </div>
            
            <img src="images/logo.png" className="fullscreenloading-logo">
            </img>

            <span className="fullscreenloading-app-title">{AppConfig.App.Title1} | {AppConfig.App.Title2}

            </span>
            <span className="fullscreenloading-spinner-text">&nbsp;&nbsp;&nbsp;{props.message ?? "Lütfen bekleyin..."}</span>
        </div>


    </div>);
}


export const NoResultsFound = (props) => {
    return (<div className="NoResultsFound">
        {props.message || "Sonuç bulunamadı"}</div>)
}

export const ImageNotFound = () => {
    return (<div className="imageNotFound"><img src='images/imagenotfound.png' style={{ width: '100%' }}></img></div>)
}
