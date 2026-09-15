import { useEffect, useState } from "react";
import { Breadcrumb, Button, Form } from "react-bootstrap";
import { MdOutlineApps } from "react-icons/md";
import { SettingsBusiness } from "../../Business/SettingsBusiness";
import { Message } from "../../Components/Message";
import { Constants } from "../../Core/Constants";

export const TakbisSettingsPage = () => {

    useEffect(() => {

        getSettings();

    }, []);

    const configKey = "GisTakbisConfig";


    const [loading, setLoading] = useState(Constants.LoadingStatus.NONE)
    const [message, setMessage] = useState(null);

    const [itemDetails, setItemDetails] = useState({});
    const getSettings = () => {

        SettingsBusiness.Get("GisTakbisConfig").then((_result) => {


            if (_result.type == Constants.MessageTypes.Success) {

                setLoading(Constants.LoadingStatus.NONE);
                const settings = JSON.parse(_result.data.configValue);

                setItemDetails(settings);
            }
        });
    }

    const setField = (_field, _value) => {

        setMessage(null);
    
        const _itemDetails = { ...itemDetails };
        _itemDetails[_field] = _value;
        setItemDetails(_itemDetails);
    }

    const btnSubmit_OnClick = () => {

        if (loading != Constants.LoadingStatus.LOADING) {

            setLoading(Constants.LoadingStatus.LOADING);

            var validationMessage = SettingsBusiness.ValidateGisTakbisConfig(itemDetails);

            if (validationMessage.type == Constants.MessageTypes.Error) {

                setMessage(validationMessage);
                setLoading(Constants.LoadingStatus.SUBMITTED);
                return false;

            }
            else {
                let config = {
                    ConfigKey: configKey,
                    ConfigValue: JSON.stringify(itemDetails)
                }

                SettingsBusiness.Save(config).then((_result) => {
                    setMessage({
                        type: _result.type,
                        text: _result.message
                    });
                    setLoading(Constants.LoadingStatus.SUBMITTED);
                
                });
            }
        }

    }


    return (<>
        <div className="page">
            <div className="page-title">
                <MdOutlineApps></MdOutlineApps>
                <span>Takbis Ayarları</span>
            </div>
            {
                <Message message={message}></Message>
            }
            <div className="page-body">
                <div className="row">
                    <div className="col-12">
                        <Form onSubmit={(e) => { e.preventDefault(); btnSubmit_OnClick() }}>
                            <Form.Group className="mb-3" >
                                <Form.Label>Servis Adresi</Form.Label>
                                <Form.Control type="text"
                                    placeholder="Servis adresi giriniz"
                                    defaultValue={itemDetails?.ServiceUrl}
                                    onInput={(e) => setField("ServiceUrl", e.target.value)} />
                            </Form.Group>
                            <Form.Group className="mb-3" >
                                <Form.Label>Şehir Id</Form.Label>
                                <Form.Control type="text"
                                    placeholder="Şehir id giriniz (örn. 21)"
                                    defaultValue={itemDetails?.CityId}
                                    onInput={(e) => setField("CityId", e.target.value)} />
                            </Form.Group>

                            <Form.Group className="mb-3" >
                                <Form.Label>Kullanıcı Adı</Form.Label>
                                <Form.Control type="text"
                                    placeholder="Kullanıcı adı giriniz"
                                    defaultValue={itemDetails?.ClientUserName}
                                    onInput={(e) => setField("ClientUserName", e.target.value)} />
                            </Form.Group>


                            <Form.Group className="mb-3" >
                                <Form.Label>Şifre</Form.Label>
                                <Form.Control type="text"
                                    placeholder="Şifre giriniz"
                                    defaultValue={itemDetails?.ClientPassword}
                                    onInput={(e) => setField("ClientPassword", e.target.value)} />
                            </Form.Group>


                            <Form.Group className="mb-3" >
                                <Form.Label>Host</Form.Label>
                                <Form.Control type="text"
                                    placeholder="Host giriniz"
                                    defaultValue={itemDetails?.Host}
                                    onInput={(e) => setField("Host", e.target.value)} />
                            </Form.Group>


                            <Form.Group className="mb-3" >
                                <Form.Label>Token</Form.Label>
                                <Form.Control type="text"
                                    placeholder="Token giriniz"
                                    defaultValue={itemDetails?.Token}
                                    onInput={(e) => setField("Token", e.target.value)} />
                            </Form.Group>


                            <Button variant="primary" type="submit">
                                Kaydet
                            </Button>
                        </Form>

                    </div>
                </div>

            </div>
        </div>

    </>);
}