/**
 * @author bekir
 * Burada genel bileşenler (yükleniyor, kayıt bulunamadı) bulunur
 * Uygulama içerisindeki bu tür bileşenlere ait kodlar buraya konulmalıdır
 */
import { useEffect, useState } from "react";

import { Form, Button, Row, Col } from "react-bootstrap";
import {ImTable} from "react-icons/im";
import "./Loading.css";

const loadinggif="images/ajax-loader.gif";

export const ButtonLoading=(props)=>{
    return (<Button className="w-100 ButtonLoading"
    disabled={true}>
        <img src={loadinggif}></img>
        &nbsp;&nbsp;&nbsp;{props?.text}
    </Button>);
}

export const ContainerLoading=(props)=>{
    return (<div className="w-100 h-100 ContainerLoading">
        <img src={loadinggif}></img>
        &nbsp;&nbsp;&nbsp;
        {props?.text} 
    </div>);
}

export const FullScreenLoading=(props)=>{
    return (<div className="FullScreenLoading">
        
        <div><img src="logo.png" className="FullScreenLoading_Logo"></img></div>
        
        <img src={loadinggif}></img>
        &nbsp;&nbsp;&nbsp;{props?.text} 
    </div>);
}

export const NoResultsFound=(props)=>{
    return (
      <div className="NoResultsFound">
        {props?.text ?? "Sonuç bulunamadı"}
      </div>
    );
}

export const ImageNotFound=()=>{
    return (<div className="imageNotFound"><img src='images/imagenotfound.png' style={{width:'100%'}}></img></div>)
}
