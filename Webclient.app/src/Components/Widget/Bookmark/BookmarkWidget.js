import React, { useEffect, useImperativeHandle, useState } from "react";
import { Form, Button } from "react-bootstrap";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faMap, faTimes, faBookmark } from '@fortawesome/free-solid-svg-icons';
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

    useImperativeHandle(ref, () => ({

        id: props.id, visible: false, minimized: false,
        OnShow: () => {
            
            getBookmarks();
            props.windowManager.ShowWindow("sidebar")
        },
        OnClose: () => {
            
        }
    }));

    const [mapView, setMapView] = useState(null);
    useEffect(() => {
       //Window Manager register window
       props.windowManager.RegisterWindow(ref);
       
        const _mapView = MapManager.GetMapView();
        setMapView(_mapView);

    }, []);


    const [list, setList] = useState([]);
    const getBookmarks = () => {
        const bkList = LocalStorageHelper.Get(Constants_ConfigKeys.BOOKMARKS);
        if (bkList != null) {
            setList(bkList);
        }
        else {
            setList([]);
        }
    }


    const deleteBookmark = (e, index) => {

      
        e.preventDefault();
        e.stopPropagation();
        var _list = [...list];
        _list.splice(index,1);

        setList(_list);
        LocalStorageHelper.Set(Constants_ConfigKeys.BOOKMARKS, _list);
    }

    const gotoBookmark = (index) => {
        
        var _bookmark = list[index];

        mapView.goTo({
            center: [_bookmark.Lng,_bookmark.Lat],
            zoom: _bookmark.Zoom
        });
    }

    const [newBookmark, setNewBookmark] = useState({ Title: "", Location: null });
    const txtBookmarkTitle_OnChange = (e) => {
        const _newBookmark = { ...newBookmark };
        _newBookmark.Title = TextHelper.SanitizeString(e.target.value);
        setNewBookmark(_newBookmark);
    }

    const form_OnSubmit = (e) => {
        e.preventDefault();
        btnSubmit_OnClick();
    }


    const btnSubmit_OnClick = (e) => {

        if (IsNull(newBookmark.Title)) {
            props.windowManager.ShowMessage(Constants_MessageType.Warning ,"Lütfen yer işareti adını doldurunuz");
            return;
        }
        else {

            var sameObjList = ArrayHelper.Find(list, "Title", newBookmark.Title);

            if (sameObjList != null) {
                props.windowManager.ShowMessage("Aynı yer işaretinden bulunuyor, lütfen farklı bir isim giriniz", "warning");
                return;
            }
            else {

                var bookmark = {
                    Title: newBookmark.Title,
                    Lat: mapView.center.latitude,
                    Lng: mapView.center.longitude,
                    Zoom: mapView.zoom
                };

                var bkList = LocalStorageHelper.Get(Constants_ConfigKeys.BOOKMARKS);
                if (bkList == null) {
                    bkList = [];
                }
                bkList.push(bookmark);
                LocalStorageHelper.Set(Constants_ConfigKeys.BOOKMARKS, bkList);
                setList(bkList);
                setNewBookmark({Title:""});
            }
        }
    }

    return (
        <>
            <div className="common-query-window common-query-window-right"
                style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
                <div className="common-query-window-header">
                    <img className="common-query-window-header-icon" src="images/icons/toolbar/bookmark.png"></img>
                    <span>Yer İşaretleri</span>
                    <CommonQueryWindowTools
                        windowManager={props.windowManager}
                        windowId={props.id}
                        showNearbySearch={false}
                        showMapSelect={false}
                        setQueryField={(e) => { }}
                        query={null} />
                </div>
                <div className="common-query-window-body">
                    <Form onSubmit={(e) => form_OnSubmit(e)}>
                        <Form.Group controlId="txtBookmarkTitle">
                            <Form.Label>Yer işareti adı</Form.Label>
                            <Form.Control type="text"
                                value={newBookmark.Title}
                                onChange={(e) => txtBookmarkTitle_OnChange(e)}
                                placeholder="Yer işareti adı giriniz" />
                        </Form.Group>

                        <Form.Group>
                            <Button type="button" className="form-button" onClick={(e) => btnSubmit_OnClick()}>
                                <BiBookAdd className="form-button-icon" /><span>Kaydet</span>
                            </Button>
                        </Form.Group>
                    </Form>

                </div>
                <div className="common-query-window-body">
                    {
                        list?.length == 0 ? <NoResultsFound />
                            : list.map((_item, _index) => {
                                return (
                                    <>
                                        <div className="result-item-container" onClick={(e) => gotoBookmark(_index)}>
                                            <div className="result-item-info">
                                                <div className="result-item-info-title">
                                                    {_item.Title}
                                                </div>
                                                <div className="result-item-info-address">
                                                    <FiMapPin />&nbsp;
                                                    {_item.Lat.toFixed(3)} , {_item.Lng.toFixed(3)}
                                                </div>
                                            </div>
                                            <div className="result-item-tools-container">
                                                <div className="result-item-tool-button" onClick={(e) => gotoBookmark(_index)}>
                                                    <BiZoomIn className="result-item-tool-button-icon" title="Haritada Göster" />
                                                </div>
                                                <div className="result-item-tool-button" onClick={(e) => deleteBookmark(e, _index)}>
                                                    <BiTrash className="result-item-tool-button-icon" title="Sil" />
                                                </div>
                                            </div>
                                        </div>

                                    </>

                                );
                            })
                    }
                </div>
            </div>

        </>);

});