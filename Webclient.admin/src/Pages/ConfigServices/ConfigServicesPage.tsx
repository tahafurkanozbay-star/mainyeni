import { useEffect, useState } from "react";
import { Accordion, Breadcrumb, Button, Form, Table } from "react-bootstrap";
import { MdOutlineApps } from "react-icons/md";
import { BiEdit } from "react-icons/bi";
import { TbPackageImport, TbPackageExport } from "react-icons/tb";
import { FiExternalLink } from "react-icons/fi";
import { IoAddCircleOutline } from "react-icons/io5";
import { RiDeleteBin2Fill } from "react-icons/ri";
import { ConfigServicesBusiness } from "../../Business/ConfigServicesBusiness";
import { ContainerLoading, NoResultsFound } from "../../Components/Loading";
import { ConfigServiceDetailsPage } from "./ConfigServiceDetailsPage";
import { ConfirmDialog } from "../../Components/ConfirmDialog";
import { Constants } from "../../Core/Constants";
import { Message } from "../../Components/Message";
import { ImportSettingsPage } from "../../Shared/ImportSettingsPage";

export const ConfigServicesPage = () => {

    useEffect(() => {

        getList();

    }, []);

    const [loading, setLoading] = useState(Constants.LoadingStatus.LOADING);
    const [confirmDeleteMessage, setConfirmDeleteMessage] = useState(null);
    const [selectedItemForDelete, setSelectedItemForDelete] = useState(null);
    const [message, setMessage] = useState(null);
    const [selectedItem, setSelectedItem] = useState(null);
    const [results, setResults] = useState(null);
    const getList = () => {
        ConfigServicesBusiness.List().then((_result) => {
            if (_result.type == Constants.MessageTypes.Success) {
                setLoading(Constants.LoadingStatus.NONE);
                setResults(_result.data);
            }
        });
    }

    const showDetails = (_service) => {
        setSelectedItem(_service);
    }

    const closeDetailsWindow = () => {
        setSelectedItem(null);
        getList(); //refresh list
    }

    const gotoService = (_service) => {
        window.open(_service.url, "_blank");
    }



    //DELETE FUNCTIONS
    const showDeleteConfirm = (_service) => {
        
        setConfirmDeleteMessage(_service.title + " adlı servisi silmek istediğinizden emin misiniz?")
        setSelectedItemForDelete(_service);
    }

    const deleteConfirmed = () => {

        setMessage(null);
        setConfirmDeleteMessage(null);
        setLoading(Constants.LoadingStatus.LOADING);

        ConfigServicesBusiness.Delete(selectedItemForDelete).then((_result) => {
            setLoading(Constants.LoadingStatus.NONE);
            setMessage({
                type: _result.type,
                text: _result.message
            });
            setSelectedItemForDelete(null);
            getList(); //refresh list

        }).catch((_result) => {
            setLoading(Constants.LoadingStatus.NONE);
            setMessage({
                type: Constants.MessageTypes.Error,
                text: "İşlem sırasında bir hata oluştu"
            });
        });
    }
    
    const deleteCancelled = () => {
        setSelectedItemForDelete(null);
        setConfirmDeleteMessage(null);
    }


    const [importPageVisible,setImportPageVisible]=useState(false);
    const showImportPage=()=>{
        setImportPageVisible(true);
    }
    
    const closeImportPage=()=>{
        setImportPageVisible(false);
        getList();
    }

    const exportToCsv=()=>{
        setLoading(Constants.LoadingStatus.LOADING);
        ConfigServicesBusiness.Export(Constants.ExportTypes.CSV).then((_result) => {
            if (_result.type == Constants.MessageTypes.Success) {
                setLoading(Constants.LoadingStatus.NONE);
            }
        });
    }

    return (<>
        <div className="page">
            <div className="page-title">
                <MdOutlineApps></MdOutlineApps>
                <span>Konfigürasyon Servisleri</span>
            </div>
            {
                <Message message={message}></Message>
            }
            <div className="page-tools row">
                <div className="col-6">

                    <Button variant="primary" className="page-tools-button" onClick={(e) => showDetails({})}>
                        <IoAddCircleOutline></IoAddCircleOutline>
                        <span>Yeni Oluştur</span>
                    </Button>

                    <Button variant="outline-secondary" className="page-tools-button" onClick={(e) => showImportPage()}>
                        <TbPackageImport></TbPackageImport>
                        <span>İçeri Aktar</span>
                    </Button>

                    <Button variant="outline-secondary" className="page-tools-button"  onClick={(e) => exportToCsv()}>
                        <TbPackageExport></TbPackageExport>
                        <span>Dışarı Aktar</span>
                    </Button>



                </div>
                <div className="col-6">
                    {
                        /*
                        <Form className="d-flex">
                        <Form.Control
                            type="search"
                            placeholder="Aramak için yazın..."
                            className="me-2"
                            aria-label="Search"
                        />
                    </Form>    
                        */
                    }

                </div>

            </div>
            <div className="page-body">

                {
                    loading == Constants.LoadingStatus.LOADING ? <ContainerLoading /> :
                        results?.length == 0 ? <NoResultsFound text="Herhangi bir konfigürasyon servisi bulunamadı" /> :
                            <Accordion defaultActiveKey="0">
                                {
                                    results?.map((_group, _index) => {
                                        return (<Accordion.Item eventKey={_index}>
                                            <Accordion.Header>{_group.groupTitle}</Accordion.Header>
                                            <Accordion.Body>
                                                <Table striped bordered hover>
                                                    <thead>
                                                        <tr>
                                                            <th>Ad</th>
                                                            <th>Tanım</th>
                                                            <th>Url</th>

                                                            <th>Eylemler</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {
                                                            _group.services?.map(_service => {
                                                                return (<tr>
                                                                    <td>{_service.title}</td>
                                                                    <td>{_service.description}</td>
                                                                    <td>{_service.url}</td>
                                                                    <td className="grid-tools-column">

                                                                        <Button variant="outline-secondary" className="btn-grid"
                                                                            onClick={(e) => showDetails(_service)} 
                                                                            title="Düzenle">
                                                                            <BiEdit className="btn-grid-icon" />
                                                                            <span className="btn-label">Düzenle</span>
                                                                        </Button>
                                                                        <Button variant="outline-secondary" className="btn-grid"
                                                                            onClick={(e) => gotoService(_service)} >
                                                                            <FiExternalLink className="btn-grid-icon" />
                                                                            <span className="btn-label">Git</span>
                                                                        </Button>



                                                                        <Button variant="outline-secondary" className="btn-grid float-end"
                                                                            onClick={(e) => showDeleteConfirm(_service)} >
                                                                            <RiDeleteBin2Fill className="btn-grid-icon btn-danger" />
                                                                            <span className="btn-label">Sil</span>
                                                                        </Button>

                                                                    </td>
                                                                </tr>)
                                                            })
                                                        }
                                                    </tbody>
                                                </Table>

                                            </Accordion.Body>
                                        </Accordion.Item>)
                                    })
                                }
                            </Accordion>

                }


            </div>
        </div>

        {
            selectedItem && <ConfigServiceDetailsPage
                item={selectedItem}
                setMessage={setMessage}
                close={() => closeDetailsWindow()}></ConfigServiceDetailsPage>
        }

        {
            importPageVisible && <ImportSettingsPage
                category="ConfigServices"
                setMessage={setMessage}
                close={() => closeImportPage()}></ImportSettingsPage>
        }

        {
            confirmDeleteMessage && <ConfirmDialog
                text={confirmDeleteMessage}
                CancelCallBack={() => deleteCancelled(null)}
                AcceptCallBack={() => deleteConfirmed(selectedItem)}></ConfirmDialog>
        }



    </>);
}