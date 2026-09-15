import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Tab, Tabs } from "react-bootstrap";
import { EgoQueryBusiness } from "../../../Business/EgoQueryBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import { ContainerLoading } from "../../Common/Loading";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import { normalizeErrorMessage } from "../_Common/QueryInteractionRuntime";
import "./EgoQueryWindow.css";
import { EgoLinesQuery } from "./EgoLinesQuery";
import { EgoStopsQuery } from "./EgoStopsQuery";

const WINDOW_TITLE = "EGO / Otobüs Durakları";
const WINDOW_LOGO = "images/icons/sidebar/ulasimaglari.png";
const DEFAULT_QUERY = Object.freeze({
    name: "",
    districtId: "",
    nbhoodId: "",
    mapSelect: false,
    showNearby: false
});

const createDefaultQuery = () => ({ ...DEFAULT_QUERY });

export const EgoQueryWindow = React.forwardRef((props, ref) => {
    const { id, windowManager } = props;
    const commonToolsComponentRef = useRef(null);
    const mountedRef = useRef(true);
    const loadSequenceRef = useRef(0);

    const [lineList, setLineList] = useState(null);
    const [stopList, setStopList] = useState(null);
    const [query, setQuery] = useState(createDefaultQuery);
    const [activeTab, setActiveTab] = useState("activeLines");
    const [errorMessage, setErrorMessage] = useState("");

    const setQueryField = useCallback((field, value) => {
        setQuery(current => ({ ...current, [field]: value }));
    }, []);

    const resetWindow = useCallback(() => {
        loadSequenceRef.current += 1;
        setQuery(createDefaultQuery());
        setActiveTab("activeLines");
        setErrorMessage("");
        commonToolsComponentRef.current?.OnClose?.();
    }, []);

    useImperativeHandle(ref, () => ({
        id,
        visible: false,
        minimized: false,
        OnShow: () => {},
        OnClose: resetWindow
    }), [id, resetWindow]);

    useEffect(() => {
        mountedRef.current = true;
        windowManager.RegisterWindow(ref);
        const sequence = ++loadSequenceRef.current;

        const load = async () => {
            const [linesResponse, stopsResponse] = await Promise.allSettled([
                EgoQueryBusiness.GetActiveLines(),
                EgoQueryBusiness.GetActiveStops()
            ]);
            if (!mountedRef.current || sequence !== loadSequenceRef.current) return;

            const linesSucceeded = linesResponse.status === "fulfilled"
                && linesResponse.value?.type === Constants_ServiceResultType.Success;
            const stopsSucceeded = stopsResponse.status === "fulfilled"
                && stopsResponse.value?.type === Constants_ServiceResultType.Success;

            setLineList(linesSucceeded && Array.isArray(linesResponse.value.data) ? linesResponse.value.data : []);
            setStopList(stopsSucceeded && Array.isArray(stopsResponse.value.data) ? stopsResponse.value.data : []);

            if (!linesSucceeded && !stopsSucceeded) {
                const rejectedReason = linesResponse.status === "rejected"
                    ? linesResponse.reason
                    : stopsResponse.status === "rejected"
                        ? stopsResponse.reason
                        : null;
                const message = normalizeErrorMessage(rejectedReason, "EGO hat ve durak bilgileri alınamadı.");
                setErrorMessage(message);
                windowManager.ShowMessage(Constants_MessageType.Error, message);
            } else if (!linesSucceeded || !stopsSucceeded) {
                setErrorMessage("EGO verilerinin bir bölümü şu anda kullanılamıyor; erişilebilen kayıtlar gösteriliyor.");
            }
        };

        load();
        return () => {
            mountedRef.current = false;
            loadSequenceRef.current += 1;
            commonToolsComponentRef.current?.OnClose?.();
        };
    }, [ref, windowManager]);

    const loading = lineList === null || stopList === null;

    return (
        <section
            className="common-query-window ego-query-window"
            aria-label={WINDOW_TITLE}
            style={{ visibility: windowManager.IsVisible(id) ? "visible" : "hidden" }}
        >
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src={WINDOW_LOGO} alt="" aria-hidden="true" />
                <span>{WINDOW_TITLE}</span>
                <CommonQueryWindowTools
                    ref={commonToolsComponentRef}
                    windowManager={windowManager}
                    windowId={id}
                    setQueryField={setQueryField}
                    query={query}
                    showNearbySearch={false}
                    showMapSelect={false}
                />
            </header>

            <div className={`common-query-window-body ${windowManager.IsMinimized(id) ? "common-query-window-body-collapsed" : ""}`}>
                {errorMessage && (
                    <div className="kr-status-banner kr-status-banner--warning" role="status">
                        {errorMessage}
                    </div>
                )}

                {loading ? (
                    <ContainerLoading />
                ) : (
                    <Tabs
                        activeKey={activeTab}
                        onSelect={key => setActiveTab(key || "activeLines")}
                        className="ego-query-window-tabs"
                        aria-label="EGO sorgu türü"
                    >
                        <Tab title={`Hatlar (${lineList.length})`} eventKey="activeLines">
                            <EgoLinesQuery lines={lineList} showAll={false} />
                        </Tab>
                        <Tab title={`Duraklar (${stopList.length})`} eventKey="activeStops">
                            <EgoStopsQuery stops={stopList} showAll={false} />
                        </Tab>
                    </Tabs>
                )}
            </div>
        </section>
    );
});

EgoQueryWindow.displayName = "EgoQueryWindow";
