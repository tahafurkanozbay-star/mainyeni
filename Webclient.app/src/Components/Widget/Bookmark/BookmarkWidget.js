import React, { useEffect, useImperativeHandle, useState } from "react";
import { Form, Button } from "react-bootstrap";
import { NoResultsFound } from "../../Common/Loading";
import { IsNull } from "../../../Toolbox/ObjectHelper";
import { ArrayHelper } from "../../../Toolbox/ArrayHelper";
import { TextHelper } from "../../../Toolbox/TextHelper";
import { LocalStorageHelper } from "../../../Toolbox/LocalStorageHelper";
import { Constants_ConfigKeys, Constants_MessageType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import { BiBookAdd, BiTrash, BiZoomIn } from "react-icons/bi";
import { FiMapPin } from "react-icons/fi";

export const BookmarkWidget = React.forwardRef((props, ref) => {
    const [mapView, setMapView] = useState(null);
    const [list, setList] = useState([]);
    const [newBookmark, setNewBookmark] = useState({ Title: "" });

    const getBookmarks = () => {
        const bookmarks = LocalStorageHelper.Get(Constants_ConfigKeys.BOOKMARKS);
        setList(Array.isArray(bookmarks) ? bookmarks : []);
    };

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => {
            getBookmarks();
            props.windowManager.ShowWindow("sidebar");
        },
        OnClose: () => {}
    }), [props.id, props.windowManager]);

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        setMapView(MapManager.GetMapView());
    }, [props.windowManager, ref]);

    const deleteBookmark = (event, index) => {
        event.preventDefault();
        event.stopPropagation();
        const nextList = list.filter((_, itemIndex) => itemIndex !== index);
        setList(nextList);
        LocalStorageHelper.Set(Constants_ConfigKeys.BOOKMARKS, nextList);
    };

    const gotoBookmark = index => {
        const bookmark = list[index];
        if (!bookmark || !mapView) return;
        mapView.goTo({ center: [bookmark.Lng, bookmark.Lat], zoom: bookmark.Zoom });
    };

    const saveBookmark = event => {
        event?.preventDefault();
        const title = newBookmark.Title?.trim();
        if (IsNull(title)) {
            props.windowManager.ShowMessage(Constants_MessageType.Warning, "Lütfen yer işareti adını doldurunuz");
            return;
        }
        if (ArrayHelper.Find(list, "Title", title) !== null) {
            props.windowManager.ShowMessage(Constants_MessageType.Warning, "Aynı yer işaretinden bulunuyor, lütfen farklı bir isim giriniz");
            return;
        }
        if (!mapView?.center) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, "Harita konumu okunamadı");
            return;
        }

        const bookmark = { Title: title, Lat: mapView.center.latitude, Lng: mapView.center.longitude, Zoom: mapView.zoom };
        const nextList = [...list, bookmark];
        LocalStorageHelper.Set(Constants_ConfigKeys.BOOKMARKS, nextList);
        setList(nextList);
        setNewBookmark({ Title: "" });
    };

    return (
        <div className="common-query-window common-query-window-right" style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/bookmark.png" alt="" aria-hidden="true" />
                <span>Yer İşaretleri</span>
                <CommonQueryWindowTools windowManager={props.windowManager} windowId={props.id} showNearbySearch={false} showMapSelect={false} setQueryField={() => {}} query={null} />
            </div>
            <div className="common-query-window-body">
                <Form onSubmit={saveBookmark}>
                    <Form.Group controlId="txtBookmarkTitle">
                        <Form.Label>Yer işareti adı</Form.Label>
                        <Form.Control type="text" value={newBookmark.Title} onChange={event => setNewBookmark({ Title: TextHelper.SanitizeString(event.target.value) })} placeholder="Yer işareti adı giriniz" />
                    </Form.Group>
                    <Form.Group><Button type="submit" className="form-button"><BiBookAdd className="form-button-icon" aria-hidden="true" /><span>Kaydet</span></Button></Form.Group>
                </Form>
            </div>
            <div className="common-query-window-body">
                {list.length === 0 ? <NoResultsFound /> : list.map((item, index) => (
                    <div className="result-item-container" key={`${item.Title}-${item.Lat}-${item.Lng}`} role="button" tabIndex={0} onClick={() => gotoBookmark(index)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") gotoBookmark(index); }}>
                        <div className="result-item-info"><div className="result-item-info-title">{item.Title}</div><div className="result-item-info-address"><FiMapPin aria-hidden="true" />&nbsp;{Number(item.Lat).toFixed(3)} , {Number(item.Lng).toFixed(3)}</div></div>
                        <div className="result-item-tools-container" aria-label={`${item.Title} işlemleri`}>
                            <button type="button" className="result-item-tool-button" onClick={event => { event.stopPropagation(); gotoBookmark(index); }} aria-label="Haritada göster"><BiZoomIn className="result-item-tool-button-icon" aria-hidden="true" /></button>
                            <button type="button" className="result-item-tool-button" onClick={event => deleteBookmark(event, index)} aria-label="Yer işaretini sil"><BiTrash className="result-item-tool-button-icon" aria-hidden="true" /></button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
});

BookmarkWidget.displayName = "BookmarkWidget";
