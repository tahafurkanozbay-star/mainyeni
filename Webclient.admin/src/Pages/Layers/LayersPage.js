import { useEffect, useState, useTransition } from "react";
import { Accordion, Breadcrumb, Button, Form, Table } from "react-bootstrap";
import { LayerBusiness } from "../../Business/LayerBusiness";
import { LayerGroupBusiness } from "../../Business/LayerGroupBusiness";
import { Constants } from "../../Core/Constants";
import { MdOutlineApps } from "react-icons/md";
import { BiEdit } from "react-icons/bi";
import { TbPackgeImport, TbPackgeExport } from "react-icons/tb";
import { FiExternalLink } from "react-icons/fi";
import { IoAddCircleOutline } from "react-icons/io5";
import { RiDeleteBin2Fill } from "react-icons/ri";
import { Message } from "../../Components/Message";
import { ContainerLoading, NoResultsFound } from "../../Components/Loading";
import { ConfirmDialog } from "../../Components/ConfirmDialog";
import { LayerDetailsPage } from "./LayerDetailsPage";
import { LayerGroupDetailsPage } from "./LayerGroupDetailsPage";


export const LayersPage = () => {

    useEffect(() => {

        getList();

    }, []);

    const [message, setMessage] = useState(null);
    const [loading, setLoading] = useState(Constants.LoadingStatus.LOADING);
    const [layerGroups, setLayerGroups] = useState(null);
    const [selectedItem, setSelectedItem] = useState(null);

    const [selectedGroup, setSelectedGroup] = useState(null);

    const getList = () => {
        LayerGroupBusiness.ListWithLayers().then((_result) => {
            if (_result.type == Constants.MessageTypes.Success) {
                setLoading(Constants.LoadingStatus.NONE);
                setLayerGroups(_result.data);
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
    const [confirmGroupDeleteMessage, setConfirmGroupDeleteMessage] = useState(null);
    const [selectedGroupForDelete,setSelectedGroupForDelete]=useState(null);
    const showGroupDeleteConfirm=(_group)=>{
        setConfirmGroupDeleteMessage(_group.title + " adlı katman grubunu silmek istediğinizden emin misiniz?")
        setSelectedGroupForDelete(_group);
    }
    const groupDeleteConfirmed = () => {
        setMessage(null);
        setConfirmGroupDeleteMessage(null);
        setLoading(Constants.LoadingStatus.LOADING);

        LayerGroupBusiness.Delete(selectedGroupForDelete).then((_result) => {
            setLoading(Constants.LoadingStatus.NONE);
            setMessage({
                type: _result.type,
                text: _result.message
            });
            setSelectedGroupForDelete(null);
            getList(); //refresh list
        }).catch((_result) => {
            setLoading(Constants.LoadingStatus.NONE);
            setMessage({
                type: Constants.MessageTypes.Error,
                text: "İşlem sırasında bir hata oluştu"
            });
        });
    }
    const groupDeleteCancelled = () => {
        setSelectedGroupForDelete(null);
        setConfirmGroupDeleteMessage(null);
    }


    /*layer delete */
    const [confirmDeleteMessage, setConfirmDeleteMessage] = useState(null);
    const [selectedItemForDelete, setSelectedItemForDelete] = useState(null);
    
    const showDeleteConfirm = (_layer) => {
        setConfirmDeleteMessage(_layer.title + " adlı katmanı silmek istediğinizden emin misiniz?")
        setSelectedItemForDelete(_layer);
    }

    const deleteConfirmed = () => {
        setMessage(null);
        setConfirmDeleteMessage(null);
        setLoading(Constants.LoadingStatus.LOADING);

        LayerBusiness.Delete(selectedItemForDelete).then((_result) => {
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
                <span>Katmanlar</span>
            </div>
            {
                <Message message={message}></Message>
            }
            <div className="page-tools row">
                <div className="col-6">
                    <Button variant="primary" className="page-tools-button" onClick={(e) => showGroupDetails({})}>
                        <IoAddCircleOutline></IoAddCircleOutline>
                        <span>Yeni Katman Grubu</span>
                    </Button>

                    <Button variant="success" className="page-tools-button" onClick={(e) => showDetails({ startupOpacity: 50, orderPriority: 1 })}>
                        <IoAddCircleOutline></IoAddCircleOutline>
                        <span>Yeni Katman</span>
                    </Button>

                    {
                        /*
                        <Button variant="outline-secondary" className="page-tools-button">
                            <TbPackgeImport></TbPackgeImport>
                            <span>İçeri Aktar</span>
                        </Button>

                        <Button variant="outline-secondary" className="page-tools-button">
                            <TbPackgeExport></TbPackgeExport>
                            <span>Dışarı Aktar</span>
                        </Button>
                        */
                    }

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
                        layerGroups?.length == 0 ? <NoResultsFound text="Herhangi bir katman grubu bulunamadı" /> :
                            <Accordion defaultActiveKey="0">
                                {
                                    layerGroups?.map((_group, _index) => {
                                        return (<Accordion.Item eventKey={_index}>
                                            <Accordion.Header>
                                                <div className="row w-100">
                                                    <div className="col-10 layerlist-group-title">
                                                        {_group.title}
                                                    </div>
                                                    <div className="col-2">
                                                        <Button variant="outline-secondary" className="btn-grid float-end"
                                                            onClick={(e) => showGroupDetails(_group)} >
                                                            <BiEdit className="btn-grid-icon" />
                                                            <span className="btn-label">Düzenle</span>
                                                        </Button>

                                                        {
                                                            _group.layers?.length == 0 &&
                                                            <Button variant="outline-secondary" className="btn-grid float-end"
                                                                onClick={(e) => showGroupDeleteConfirm(_group)} >
                                                                <RiDeleteBin2Fill className="btn-grid-icon btn-danger" />
                                                                <span className="btn-label">Sil</span>
                                                            </Button>
                                                        }

                                                    </div>
                                                </div>
                                            </Accordion.Header>
                                            <Accordion.Body>
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
                                                            _group.layers == null || _group.layers?.length == 0 ? <tr><td colSpan={5}><NoResultsFound text="Bu grupta herhangi bir katman bulunamadı" /></td></tr> :
                                                                _group.layers?.map(_layer => {
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

                                            </Accordion.Body>
                                        </Accordion.Item>)
                                    })
                                }
                            </Accordion>

                }
            </div>
        </div>

        {
            selectedGroup && <LayerGroupDetailsPage
                item={selectedGroup}
                setMessage={setMessage}
                close={() => closeGroupDetailsWindow()}></LayerGroupDetailsPage>
        }

        {
            selectedItem && <LayerDetailsPage
                item={selectedItem}
                setMessage={setMessage}
                close={() => closeDetailsWindow()}></LayerDetailsPage>
        }

        {
            confirmDeleteMessage && <ConfirmDialog
                text={confirmDeleteMessage}
                CancelCallBack={() => deleteCancelled(null)}
                AcceptCallBack={() => deleteConfirmed(selectedItem)}></ConfirmDialog>
        }

{
            confirmGroupDeleteMessage && <ConfirmDialog
                text={confirmGroupDeleteMessage}
                CancelCallBack={() => groupDeleteCancelled(null)}
                AcceptCallBack={() => groupDeleteConfirmed(selectedItem)}></ConfirmDialog>
        }

    </>);
}