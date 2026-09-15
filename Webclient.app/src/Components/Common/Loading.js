import React from "react";
import { Button } from "react-bootstrap";
import { AppConfig } from "../../Core/AppConfig";
import "./Loading.css";
import "./Loading-CircleLoader.css";

export const CircleLoading = ({ label = "Yükleniyor" }) => (
    <div className="circle-loader-container" role="status" aria-label={label} aria-live="polite">
        <div className="lds-ring" aria-hidden="true"><div></div><div></div><div></div><div></div></div>
    </div>
);

export const MiniLoading = ({ label = "Yükleniyor" }) => (
    <span className="MiniLoading" role="status" aria-label={label}><span className="experience-spinner" aria-hidden="true" /></span>
);

export const ButtonLoading = (props) => (
    <Button className="loading-button" disabled aria-busy="true">
        <span className="experience-spinner experience-spinner--small" aria-hidden="true" />
        <span>{props.message ?? "Lütfen bekleyin..."}</span>
    </Button>
);

export const ContainerLoading = (props) => (
    <div className="w-100 h-100 full-screen-div experience-container-loading" role="status" aria-live="polite" aria-busy="true">
        <span className="experience-spinner" aria-hidden="true" />
        <span>{props.message ?? "Lütfen bekleyin..."}</span>
    </div>
);

export const FullScreenLoading = (props) => (
    <div className="FullScreenLoading" role="status" aria-live="polite" aria-busy="true">
        <div className="fullscreenloading-container">
            <div className="spinner-loading-container" aria-hidden="true"><div className="spinner-loading" /></div>
            <img src="images/logo.png" className="fullscreenloading-logo" alt="Ankara Büyükşehir Belediyesi" />
            <span className="fullscreenloading-app-title">{AppConfig.App.Title1} | {AppConfig.App.Title2}</span>
            <span className="fullscreenloading-spinner-text">{props.message ?? "Lütfen bekleyin..."}</span>
        </div>
    </div>
);

export const NoResultsFound = (props) => (
    <div className="NoResultsFound" role="status">{props.message || "Sonuç bulunamadı"}</div>
);

export const ImageNotFound = () => (
    <div className="imageNotFound" role="img" aria-label="Görsel bulunamadı"><img src="images/imagenotfound.png" alt="" style={{ width: "100%" }} /></div>
);
