import { useEffect, useState } from "react";
import { Accordion, Breadcrumb, Button, Form, Table } from "react-bootstrap";
import { BasemapLayerBusiness } from "../../Business/BasemapLayerBusiness";
import { Constants } from "../../Core/Constants";
import { MdOutlineApps } from "react-icons/md";
import { BiEdit } from "react-icons/bi";
import { TbPackageImport, TbPackageExport } from "react-icons/tb";
import { FiExternalLink } from "react-icons/fi";
import { IoAddCircleOutline } from "react-icons/io5";
import { RiDeleteBin2Fill } from "react-icons/ri";
import { Message } from "../../Components/Message";
import { ContainerLoading, NoResultsFound } from "../../Components/Loading";
import { ConfirmDialog } from "../../Components/ConfirmDialog";
import { BasemapLayerDetailsPage } from "./BasemapLayerDetailsPage";


export const BasemapLayersPage = () => {

    useEffect(() => {

        getList();

    }, []);

    const [message, setMessage] = useState(null);
    const [loading, setLoading] = useState(Constants.LoadingStatus.LOADING);
    const [confirmDeleteMessage, setConfirmDeleteMessage] = useState(null);
    const [selectedItemForDelete, setSelectedItemForDelete] = useState(null);
    const [layers, setLayers] = useState(null);
    const [selectedItem, setSelectedItem] = useState(null);

    const [selectedGroup, setSelectedGroup] = useState(null);

    const getList = () => {
        BasemapLayerBusiness.List().then((_result) => {
            if (_result.type == Constants.MessageTypes.Success) {
                setLoading(Constants.LoadingStatus.NONE);
                setLayers(_result.data);
            }
        });
    }

    const showGroupDetails = (_layerGroup) => {
        setSelectedGroup(_layerGroup);
    }

    const closeGroupDetailsWindow = () => {
        setSelectedGroup(null);
        getList(); //refresh list
    }


    const showDetails = (_layer) => {
        setSelectedItem(_layer);
    }

    const closeDetailsWindow = () => {
        setSelectedItem(null);
        getList(); //refresh list
    }

    const gotoService = (_layer) => {
        window.open(_layer.url, "_blank");
    }


    //DELETE FUNCTIONS
    const showDeleteConfirm = (_layer) => {
        setConfirmDeleteMessage(_layer.title + " adlı altlık haritayı silmek istediğinizden emin misiniz?")
        setSelectedItemForDelete(_layer);
    }

    const deleteConfirmed = () => {
        setMessage(null);
        setConfirmDeleteMessage(null);
        setLoading(Constants.LoadingStatus.LOADING);

        BasemapLayerBusiness.Delete(selectedItemForDelete).then((_result) => {
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

    return (<>
        <div className="page">
            <div className="page-title">
                <MdOutlineApps></MdOutlineApps>
                <span>Altlık Haritalar</span>
            </div>
            {
                <Message message={message}></Message>
            }
            <div className="page-tools row">
                <div className="col-6">
                    <Button variant="success" className="page-tools-button" onClick={(e) => showDetails({})}>
                        <IoAddCircleOutline></IoAddCircleOutline>
                        <span>Yeni Altlık Harita</span>
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
                        layers?.length == 0 ? <NoResultsFound text="Herhangi bir altlık harita bulunamadı" /> :
                            <Table striped bordered hover>
                                <thead>
                                    <tr>
                                        <th>Ad</th>
                                        <th>Tanım</th>
                                        <th>Url</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {
                                        layers?.map(_layer => {
                                            return (<tr>
                                                <td>{_layer.title}</td>
                                                <td>{_layer.description}</td>
                                                <td>{_layer.url}</td>
                                                
                                                <td className="grid-tools-column">

                                                    <Button variant="outline-secondary" className="btn-grid"
                                                        onClick={(e) => showDetails(_layer)} >
                                                        <BiEdit className="btn-grid-icon" />
                                                        <span className="btn-label">Düzenle</span>
                                                    </Button>
                                                    <Button variant="outline-secondary" className="btn-grid"
                                                        onClick={(e) => gotoService(_layer)} >
                                                        <FiExternalLink className="btn-grid-icon" />
                                                        <span className="btn-label">Git</span>
                                                    </Button>



                                                    <Button variant="outline-secondary" className="btn-grid float-end"
                                                        onClick={(e) => showDeleteConfirm(_layer)} >
                                                        <RiDeleteBin2Fill className="btn-grid-icon btn-danger" />
                                                        <span className="btn-label">Sil</span>
                                                    </Button>

                                                </td>
                                            </tr>)
                                        })
                                    }
                                </tbody>
                            </Table>

                }
            </div>
        </div>

        {
            selectedItem && <BasemapLayerDetailsPage
                item={selectedItem}
                setMessage={setMessage}
                close={() => closeDetailsWindow()}></BasemapLayerDetailsPage>
        }

        {
            confirmDeleteMessage && <ConfirmDialog
                text={confirmDeleteMessage}
                CancelCallBack={() => deleteCancelled(null)}
                AcceptCallBack={() => deleteConfirmed(selectedItem)}></ConfirmDialog>
        }

    </>);
}