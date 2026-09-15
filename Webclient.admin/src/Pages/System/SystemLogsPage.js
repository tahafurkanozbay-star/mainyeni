import { useEffect, useState } from "react";
import { Breadcrumb, Button, Form, Tab, Tabs } from "react-bootstrap";
import { MdOutlineApps } from "react-icons/md";
import { SettingsBusiness } from "../../Business/SettingsBusiness";
import { Message } from "../../Components/Message";
import { Constants } from "../../Core/Constants";

export const SystemLogsPage = () => {

    useEffect(() => {


    }, []);


    const [loading, setLoading] = useState(Constants.LoadingStatus.NONE)
    const [message, setMessage] = useState(null);

    const [itemDetails, setItemDetails] = useState({});

    const [tabKey, setTabKey] = useState('status');
    return (<>
        <div className="page">
            <div className="page-title">
                <MdOutlineApps></MdOutlineApps>
                <span>Sistem Kayıtları</span>
            </div>
            {
                <Message message={message}></Message>
            }
            <div className="page-body">
                <div className="row">
                    <div className="col-12">
                        <Tabs
                            activeKey={tabKey}
                            onSelect={(k) => setTabKey(k)}
                            className="mb-3"
                        >
                            <Tab eventKey="status" title="Sistem Durumu">
                            </Tab>
                            <Tab eventKey="exceptions" title="Hata Kayıtları">
                            </Tab>
                            <Tab eventKey="userlogs" title="Kullanıcı Hareketleri">
                            </Tab>
                        </Tabs>
                    </div>
                </div>

            </div>
        </div>

    </>);
}