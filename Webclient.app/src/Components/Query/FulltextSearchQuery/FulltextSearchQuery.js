import React, { useEffect, useImperativeHandle, useState } from 'react';
import { NumberingQueryBusiness } from '../../../Business/NumberingQueryBusiness';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { TextHelper } from '../../../Toolbox/TextHelper';
import './FulltextSearchQuery.css';
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { DebugHelper } from '../../../Toolbox/DebugHelper';
import { InputGroup } from 'react-bootstrap';
import { BiSearch, BiXCircle } from 'react-icons/bi';
import MapManager from '../../../Store/Managers/MapManager';
import { FulltextSearchQueryBusiness } from '../../../Business/FulltextSearchQueryBusiness';
import { useDebounce } from 'use-debounce';
import { BiNavigation } from "react-icons/bi";
import { Constants_MessageType, Constants_ServiceResultType } from '../../../Core/Constants';
import { ArrayHelper } from '../../../Toolbox/ArrayHelper';
import {MiniLoading} from "../../Common/Loading";

export const FulltextSearchQuery = React.forwardRef((props, ref) => {

  useImperativeHandle(ref, () => ({

    id: props.id, visible: false, minimized: false,
    OnShow: () => {
      DebugHelper.Log("show " + props.id);
    },
    OnClose: () => {
      DebugHelper.Log("closing " + props.id);
      //setQuery(defaultQuery);
      //setActiveTab("query");
      //removeLastClusterLayer();
      //commonToolsComponentRef.current.OnClose();
    }
  }));

  const maxSubOptionsLength = 10;

  const scrollContainerRef = React.createRef();

  const [optionCount, setOptionCount] = useState(0);
  const [activeOption, setActiveOption] = useState(0);
  const [filteredOptions, setFilteredOptions] = useState([]);
  const [showOptions, setShowOptions] = useState(false);

  const [placeholderInput, setPlaceholderInput] = useState('');
  const [userInput, setUserInput] = useState('');
  const [searchText] = useDebounce(userInput, 500);

  const [neighborhoodList, setNeighborhoodList] = useState(null);
  const [flatArray, setFlatArray] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {

    NumberingQueryBusiness.GetAllNeighborhoods().then((_results) => {
      setNeighborhoodList(_results.data);
    });


    if (searchText?.length >= 2) {

      setLoading(true);

      let searchText = userInput?.trim();

      FulltextSearchQueryBusiness.Search({ searchText }, false).then((_result) => {

        if (_result.type == Constants_ServiceResultType.Success) {

          const searchOptions = ArrayHelper.GroupBy(_result.data, "kategori", true);

          setActiveOption(0);
          setOptionCount(_result.data.length);
          setFlatArray(_result.data);
          setFilteredOptions(searchOptions);
          setShowOptions(true);
        }

        setLoading(false);
      });

    }

  }, [searchText]);



  const onChange = (e) => {
    const _userInput = e.target.value.trim();
    setUserInput(e.target.value);
    setPlaceholderInput(null);
    setActiveOption(0);
    setFilteredOptions(null);
    setShowOptions(false);
    setOptionCount(0);
    setFlatArray(null);

    if (userInput?.length == 0) { return; }

  };


  const showRoute = (e, _item) => {

    e.preventDefault();
    e.stopPropagation();
    if (_item == null) { return; }
    else {
      LoggingBusiness.CreateClientLog("Genel Arama/Yol Tarifi", _item.attr.ADI ?? _item.attr.adi);
      FulltextSearchQueryBusiness.Search({ Id: _item.attr.id ?? _item.attr.id}, true).then(_itemResult => {

        if (_itemResult.type == Constants_ServiceResultType.Success) {

          const item=_itemResult.data[0];
          let lat = item.geometry.latitude;
          let lng = item.geometry.longitude;
      
          //http://maps.google.com/maps?q=&layer=c&cbll=31.33519,-89.28720
          let url = "https://www.google.com.tr/maps/dir//(" + lat + "," + lng + ")";
          window.open(url, "_blank");
        
        }
   
      });
    
    }
  }


  const goToItem = (_item) => {

    if (_item == null) { return; }
    else {
      LoggingBusiness.CreateClientLog("Genel Arama/Detay Göster", _item.attr.ADI ?? _item.attr.adi);
      let mapView = MapManager.GetMapView();
      mapView.graphics.removeAll();

      FulltextSearchQueryBusiness.Search({ Id: _item.attr.id ?? _item.attr.id }, true).then(_itemResult => {

        if (_itemResult.type == Constants_ServiceResultType.Success) {

          const item=_itemResult.data[0];
          GisGraphicsHelper.ProjectGeometry(item.geometry, "4326").then(_projectedGeometry => {

            GisGraphicsHelper.CreateGraphicFromGeometry(_projectedGeometry, null).then(_graphic => {

              GisGraphicsHelper.AddGraphics(mapView, _graphic);

              setTimeout(() => {
                mapView.graphics.remove(_graphic);
              }, 20000);

              props.windowManager.ShowMessage(Constants_MessageType.Info, _item.attr.adi);
              GisGraphicsHelper.ZoomToGeometry(mapView, _projectedGeometry, 15);
            });

          })

        }

      });

    }
  }

  const onClick = (e, _suboption) => {

    goToItem(_suboption);
    setActiveOption(0);
    setFilteredOptions([]);
    setShowOptions(false);

    setUserInput(null);
    setPlaceholderInput(_suboption.Title ?? _suboption.attr["ad"]);
  };

  const onKeyDown = (e) => {

    if (e.keyCode === 13 && flatArray?.length > 0) {

      let obj = flatArray[activeOption];
      if (obj) {
        goToItem(obj);
      }

      setActiveOption(0);
      setShowOptions(false);

      setUserInput(null);
      setPlaceholderInput(obj?.Title);
    }
    else if (e.keyCode === 38) {

      if (activeOption == 0) {
        return;
      }
      else {

        scrollContainerRef.current.scrollTop = (activeOption - 1) * 60;
        setActiveOption(activeOption - 1);

      }

    }
    else if (e.keyCode === 40) { //down

      if (activeOption == (optionCount - 1)) {
        return;
      }
      else {

        scrollContainerRef.current.scrollTop = (activeOption - 1) * 60;
        setActiveOption(activeOption + 1);
      }
    }

    else if (e.keyCode == 27) { //esc

     cancelSearch()
    }
  };



  const getOptionList = () => {

    let optionList = null;

    let count = 0;

    if (showOptions) {

      if (Object.keys(filteredOptions).length > 0) {
        optionList = (
          <ul className="options" ref={scrollContainerRef}>
            {Object.keys(filteredOptions).map((_option, _index) => {

              return filteredOptions[_option].length > 0 && <>
                <div className='options-title'>{_option} ({filteredOptions[_option].length})</div>
                <div className='options-container'>
                  {
                    filteredOptions[_option].map((_subOption, _subIndex) => {
                      let className;
                      if (count === activeOption) {
                        className = 'option-active';
                      }
                      if (_subIndex < maxSubOptionsLength) {
                        count++;
                      }

                      return (
                        _subIndex < maxSubOptionsLength && <li className={className} key={TextHelper.CreateRandomNumber()} onClick={e => onClick(e, _subOption)}>
                          <div className='fulltextsearch-option-body'>

                            <div className='fulltextsearch-option-details'>

                              <div className='fulltextsearch-option-title'>{_subOption?.attr.ADI ?? _subOption?.attr.adi}</div>

                              <div className='fulltextsearch-option-description'>{_subOption?.attr.ADRES ?? _subOption?.attr.adres ?? _subOption?.attr._MAHALLE_ADI}
                              </div>
                            </div>
                            {
                              <div className='fulltextsearch-option-route'>
                                <BiNavigation onClick={(e) => showRoute(e, _subOption)} />
                              </div>
                            }
                            {
                              _subOption.Category == "cityblockparcel" &&
                              <div>İmar Durum Belgesi Al</div>
                            }

                            {
                              _subOption.Category == "address" && _subOption.type == "door" &&
                              <div>İmar Durum Belgesi Al</div>
                            }
                          </div>

                        </li>
                      );

                    })
                  }
                </div>
              </>
            })}
          </ul>
        );
      } else {
        optionList = (
          <ul className="options">
            <li><div className="no-options">
              herhangi bir sonuç bulunamadı
            </div></li>
          </ul>
        );
      }

      return optionList;
    }
  }

  
  const cancelSearch=()=>{    
    setActiveOption(0);
    setShowOptions(false);
    setUserInput(null);
    setPlaceholderInput(null);
    setFilteredOptions([]);
    setOptionCount(0);
    setFlatArray(null);
  }

  return (
    <React.Fragment>
      <div className="fulltextsearch-container">
        <InputGroup className="fulltextsearch-text-group">
          <input
            autoFocus
            type="text"
            className="fulltextsearch-text-input"
            placeholder="Ankara'da arayın"
            onChange={onChange}
            onKeyDown={onKeyDown}
            value={userInput}
          />
          {
              loading && <InputGroup.Text className="fulltextsearch-text-icon">
                <MiniLoading/></InputGroup.Text>
          }
          
          <InputGroup.Text className="fulltextsearch-text-icon">{
            
            optionCount>0 ? <BiXCircle size="2rem" onClick={()=>cancelSearch()}/> : <BiSearch size="2rem"/>
            
          }</InputGroup.Text>
        </InputGroup>
        {getOptionList()}
      </div>

    </React.Fragment >
  );
});