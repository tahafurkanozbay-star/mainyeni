import { React, Component } from "react";
import { loadModules } from "esri-loader";

export class OverviewMapWidget extends Component {

    constructor(props) {
        super(props);
    }

    componentDidMount() {
        this.props.registerWindow(this, true, "");
    }

    setup = (Graphic, watchUtils) => {

        let self = this;
        const extentgraphic = new Graphic({
            geometry: null,
            symbol: {
                type: "simple-fill",
                color: [0, 0, 0, 0.5],
                outline: null
            }
        });
        self.mapView.graphics.add(extentgraphic);

        watchUtils.init(self.props.mainView, "extent", function (extent) {

            self.mapView.goTo({
                center: self.props.mainView.center,
                scale: self.props.mainView.scale *
                    2 * Math.max(self.props.mainView.width / self.mapView.width, self.props.mainView.height / self.mapView.height)
            }).catch(function (error) {
                // ignore goto-interrupted errors
                if (error.name != "view:goto-interrupted") {
                    console.error(error);
                }
            });


            extentgraphic.geometry = extent;
        });
    }

    loadMap = (container) => {
        let self = this;
        return loadModules(
            ["esri/Map", "esri/views/MapView", "esri/Graphic",
                "esri/core/watchUtils"]).then(([Map, MapView, Graphic, watchUtils]) => {
                    self.initialized = true;

                    //create map
                    const map = new Map({
                        basemap: "topo-vector"
                    });

                    //create map view
                    const view = new MapView({
                        container,
                        map,
                        ui: {
                            components: []
                        },
                        constraints: {
                            rotationEnabled: false
                        }
                    });

                    view.on("key-down", function (event) {
                        let prohibitedKeys = ["+", "-", "Shift", "_", "="];
                        let keyPressed = event.key;
                        if (prohibitedKeys.indexOf(keyPressed) !== -1) {
                            event.stopPropagation();
                        }
                    });


                    view.on("mouse-wheel", function (event) {
                        event.stopPropagation();
                    });

                    view.on("double-click", function (event) {
                        event.stopPropagation();
                    });

                    view.on("double-click", ["Control"], function (event) {
                        event.stopPropagation();
                    });

                    view.on("drag", function (event) {
                        event.stopPropagation();
                    });


                    //set map view
                    self.mapView = view;

                    //connect views together
                    self.mapView.when(function () {
                        self.props.mainView.when(function () {
                            self.setup(Graphic, watchUtils);
                        });
                    });

                    return self.mapView;
                });
    }

    componentDidUpdate() {
        if (!this.initialized) {
            this.loadMap("overviewMapDiv");
        }

    }

    render() {
        return (<div id="overviewMapDiv" className="overviewMapDiv"
            style={{ visibility: this.props.getWindowVisibility(this.props.windowid) ? 'visible' : 'hidden' }}>
            <div id="overviewMap_extentDiv" className="overviewMap_extentDiv"></div></div>)
    }

}