import React, { useState, useEffect } from "react";
import { BiRectangle, BiShapePolygon } from "react-icons/bi";
import { HiOutlineArrowTrendingUp } from "react-icons/hi2";
import { BsCircle } from "react-icons/bs";
import { GrCursor } from "react-icons/gr";
import { TbPoint } from "react-icons/tb";
import { AiOutlineClear } from "react-icons/ai";

import "./AdvancedSketchWidgetMain.css";

import ColorPicker from "./colorpicker";
import { Form, Tab, Tabs } from "react-bootstrap";
import mainbarCollapse from "react-bootstrap/esm/mainbarCollapse";
import { loadModules } from "esri-loader";
import MapManager from "../../../Store/Managers/MapManager";

export const AdvancedSketchWidgetMain = (props) => {
  const ToolTypes = {
    POINT: "point",
    POLYLINE: "polyline",
    FREEDRAW: "freehand",
    POLYGON: "polygon",
    CIRCLE: "circle",
    RECTANGLE: "rectangle",
    TEXT: "text",

    SELECT: "move",
    CLEAR: "clear"
  };

  const PointStyles = {
    CIRCLE: "circle",
    CROSS: "cross",
    DIAMOND: "diamond",
    SQUARE: "square"
  };

  const FillStyles = {
    BACKWARD_DIAGONAL: "backward-diagonal",
    FORWARD_DIAGONAL: "forward-diagonal",
    CROSS: "cross",
    DIAGONAL_CROSS: "diagonal-cross",
    HORIZONTAL: "horizontal",
    VERTICAL: "vertical",
    NONE: "none",
    SOLID: "solid"
  };

  const LineStyles = {
    DASH: "dash",
    DASH_DOT: "dash-dot",
    DOT: "dot",
    LONG_DASH: "long-dash",
    LONG_DASH_DOT: "long-dash-dot",
    LONG_DASH_DOT_DOT: "long-dash-dot-dot",
    NONE: "none",
    SHORT_DASH: "short-dash",
    SHORT_DASH_DOT: "short-dash-dot",
    SHORT_DASH_DOT_DOT: "short-dash-dot-dot",
    SHORT_DOT: "short-dot",
    SOLID: "solid"
  };

  const defaultPointSymbol = {};

  const defaultLineSymbol = {
    type: "simple-line",
    color: [130, 130, 130],
    width: 2
  };

  const defaultPolygonSymbol = {
    type: "simple-fill",
    style: "cross",
    color: "#EFC8B1",
    outline: {
      width: 3,
      style: "solid",
      color: "#514644"
    }
  };

  const [selectedTool, setSelectedTool] = useState(ToolTypes.SELECT);

  const [pointSymbol, setPointSymbol] = useState(defaultPointSymbol);
  const [lineSymbol, setLineSymbol] = useState(defaultLineSymbol);
  const [polygonSymbol, setPolygonSymbol] = useState(defaultPolygonSymbol);

  const changeTool = (_tool) => {
    
    setSelectedTool(_tool);    
    sketchVM.create(_tool, {mode: "click"});
  };

  const updateVM=()=>{

    sketchVM.polygonSymbol=polygonSymbol;
    sketchVM.polylineSymbol=lineSymbol;
    sketchVM.pointSymbol=pointSymbol;
    sketchVM.create(selectedTool, {mode: "click"});
  }

  const changeFillColor = (_color) => {
    polygonSymbol.color=_color.hex;
    setPolygonSymbol(polygonSymbol);
    updateVM();
  };

  const changeFillStyle = (_style) => {
    polygonSymbol.style=_style;
    setPolygonSymbol(polygonSymbol);
    updateVM();
  };

  const changeLineColor = (_color) => {
    lineSymbol.color=_color.hex;
    polygonSymbol.outline.color=_color.hex;
    setLineSymbol(lineSymbol);
    setPolygonSymbol(polygonSymbol);
    updateVM();
  };

  const changeLineStyle = (_style) => {
    lineSymbol.type=_style;
    polygonSymbol.outline.style=_style
    setLineSymbol(lineSymbol);
    setPolygonSymbol(polygonSymbol);
    updateVM();
  };
  const changeLineWeight = (_weight) => {
    lineSymbol.width=_weight;
    polygonSymbol.outline.width=_weight;
    setLineSymbol(lineSymbol);
    setPolygonSymbol(polygonSymbol);
    updateVM();
  };
  const changePointStyle = (_style) => {};


  const [sketchVM, setSketchVM]=useState(null);

  useEffect(() => {

    const mapView=MapManager.GetMapView();

    loadModules(["esri/widgets/Sketch/SketchViewModel", "esri/layers/GraphicsLayer"]).then(([SketchViewModel, GraphicsLayer])=>{

      let _graphicsLayer=new GraphicsLayer();
      mapView.map.add(_graphicsLayer);

      let _sketchVM = new SketchViewModel({
        layer: _graphicsLayer,
        view: mapView
      });

      setSketchVM(_sketchVM);

    });

  }, []);

  return (
    <Form>
      <div className="drawing-tools-container">
        <div className="drawing-tools-body">
          <Tabs activeKey={selectedTool}  onSelect={(k) => changeTool(k)}>
            <Tab eventKey={ToolTypes.SELECT} title={<div><GrCursor className="drawing-tool-button-icon" /><span className="drawing-tool-button-text">&nbsp;Seç</span></div>}></Tab>
            <Tab eventKey={ToolTypes.POINT} title={<div><TbPoint className="drawing-tool-button-icon" /><span className="drawing-tool-button-text">&nbsp;Nokta</span></div>}></Tab>
            <Tab eventKey={ToolTypes.POLYLINE} title={<div><HiOutlineArrowTrendingUp className="drawing-tool-button-icon" /><span className="drawing-tool-button-text">&nbsp;Çizgi</span></div>}></Tab>
            <Tab eventKey={ToolTypes.POLYGON} title={<div><BiShapePolygon className="drawing-tool-button-icon" /><span className="drawing-tool-button-text">&nbsp;Poligon</span></div>}></Tab>
            <Tab eventKey={ToolTypes.RECTANGLE} title={<div><BiRectangle className="drawing-tool-button-icon" /><span className="drawing-tool-button-text">&nbsp;Dikdörtgen</span></div>}></Tab>
            <Tab eventKey={ToolTypes.CIRCLE} title={<div><BsCircle className="drawing-tool-button-icon" /><span className="drawing-tool-button-text">&nbsp;Daire</span></div>}></Tab>
            <Tab eventKey={ToolTypes.CLEAR} title={<div><AiOutlineClear className="drawing-tool-button-icon" /><span className="drawing-tool-button-text">&nbsp;Temizle</span></div>}></Tab>
          </Tabs>
        </div>
      </div>
      {selectedTool !== ToolTypes.SELECT && selectedTool !== ToolTypes.CLEAR && (
        <div className="drawing-tools-container container">
          {selectedTool === ToolTypes.POINT && (
            <div className="row drawing-tools-options-row">
              <div className="col-md-4">
                <strong className="form-label" >Nokta Stili</strong>
              </div>
              <div className="col-md-8">
                <select className="form-control" onChange={(e) => changePointStyle(e.target.value)}>
                  <option value={PointStyles.CIRCLE}>Daire</option>
                  <option value={PointStyles.CROSS}>Carpi</option>
                  <option value={PointStyles.DIAMOND}>Diamond</option>
                  <option value={PointStyles.SQUARE}>Kare</option>
                </select>
              </div>
            </div>
          )}

          {(selectedTool === ToolTypes.POLYLINE ||
            selectedTool === ToolTypes.POLYGON ||
            selectedTool === ToolTypes.CIRCLE ||
            selectedTool === ToolTypes.RECTANGLE) && (
            <div>
              <div className="row drawing-tools-options-row">
                <div className="col-md-4">
                  <strong className="form-label" >Cizgi/Kenarlik Kalinligi</strong>
                </div>
                <div className="col-md-8">
                  <select className="form-control" onChange={(e) => changeLineWeight(e.target.value)}>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((x) => {
                      return <option value={x}>{x}</option>;
                    })}
                  </select>
                </div>
              </div>

              <div className="row drawing-tools-options-row">
                <div className="col-md-4">
                  <strong className="form-label" >Cizgi/Kenarlik Rengi</strong>
                </div>
                <div className="col-md-8">
                  <ColorPicker onChange={(e) => changeLineColor(e)} />
                </div>
              </div>

              <div className="row drawing-tools-options-row">
                <div className="col-md-4">
                  <strong className="form-label" >Cizgi/Kenarlik Stili</strong>
                </div>
                <div className="col-md-8">
                  <select className="form-control" onChange={(e) => changeLineStyle(e.target.value)}>
                    <option value={LineStyles.SOLID}>Normal</option>

                    <option value={LineStyles.DASH}>Cizgi</option>
                    <option value={LineStyles.DASH_DOT}>Cizgi-Nokta</option>
                    <option value={LineStyles.DOT}>Nokta</option>
                    <option value={LineStyles.LONG_DASH}>Uzun Cizgi</option>
                    <option value={LineStyles.LONG_DASH_DOT}>
                      Uzun Cizgi-Nokta
                    </option>
                    <option value={LineStyles.LONG_DASH_DOT_DOT}>
                      Uzun Cizgi-Nokta-Nokta
                    </option>
                    <option value={LineStyles.SHORT_DASH}>Kisa Cizgi</option>
                    <option value={LineStyles.SHORT_DASH_DOT}>
                      Kisa Cizgi-Nokta
                    </option>
                    <option value={LineStyles.SHORT_DASH_DOT_DOT}>
                      Kisa Cizgi-Nokta-Nokta
                    </option>
                    <option value={LineStyles.SHORT_DOT}>Kisa Nokta</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {(selectedTool === ToolTypes.POLYGON ||
            selectedTool === ToolTypes.CIRCLE ||
            selectedTool === ToolTypes.RECTANGLE) && (
            <div>
              <div className="row drawing-tools-options-row">
                <div className="col-md-4">
                  <strong className="form-label" >Doldurma Rengi</strong>
                </div>
                <div
                  className="col-md-8"
                >
                  <ColorPicker onChange={(e) => changeFillColor(e)} />
                </div>
              </div>

              <div className="row drawing-tools-options-row">
                <div className="col-md-4">
                  <strong className="form-label" >Doldurma Stili</strong>
                </div>
                <div className="col-md-8">
                  <select className="form-control" onChange={(e) => changeFillStyle(e.target.value)}>
                    <option value={FillStyles.SOLID}>Normal</option>
                    <option value={FillStyles.HORIZONTAL}>Yatay</option>
                    <option value={FillStyles.VERTICAL}>Dikey</option>
                    <option value={FillStyles.CROSS}>Capraz</option>
                    <option value={FillStyles.FORWARD_DIAGONAL}>
                      Diagonal
                    </option>
                    <option value={FillStyles.BACKWARD_DIAGONAL}>
                      Ters Diagonal
                    </option>
                    <option value={FillStyles.DIAGONAL_CROSS}>
                      Diagonal ve Capraz
                    </option>
                    <option value={FillStyles.NONE}>Yok</option>
                  </select>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </Form>
  );
};

/*
const sketchVM = new SketchViewModel({
  view: view,
  layer: graphicsLayer,
  polygonSymbol: {
    type: "simple-fill",
    style: "cross"
    color: "#EFC8B1",
    outline: {
      width: 3,
      style: "solid",
      color: "#514644"
    }
  }
});
*/
export default AdvancedSketchWidgetMain;
