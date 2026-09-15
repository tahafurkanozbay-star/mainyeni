import React, { useEffect, useState } from "react";
import { Modal, Button, Form } from "react-bootstrap";
import {ArrayHelper} from "../../../Toolbox/ArrayHelper";

import {FeedbackBusiness} from "../../../Business/FeedbackBusiness";
import {IsNull} from "../../../Toolbox/ObjectHelper";
import {ContainerLoading, ButtonLoading} from "../../Common/Loading";
import {MessageAlert} from "../../Common/MessageAlert";
import { BiCheckCircle, BiError, BiUpload } from "react-icons/bi";

const Constants_SubmitStatus = {
    NONE: 0,
    LOADING: 1,
    SUBMITTED: 2
};



const FeedbackForm = (props) => {

    const [feedbackTypes, setFeedbackTypes] = useState(null);
    const [message, setMessage] = useState(null);
    const [submitStatus, setSubmitStatus] = useState(Constants_SubmitStatus.NONE);

    const [formData, setFormData] = useState({
        CaptchaValue: "",
        FeedbackType: 1,
        country: -1
    });

    useEffect(() => {

        if (props.show) {

        
            const _feedbackTypes = FeedbackBusiness.GetFeedbackTypes();
            setFeedbackTypes(_feedbackTypes);

            //loadCaptchaEnginge(4, 'gray');

            setFormData({
                CaptchaValue: "",
                FeedbackType: 1,
                country: -1
            });

        }

    }, [props]);



    const setField = (e, key) => {
        let _formData = { ...formData };
        _formData[key] = e.target.value;
        setFormData(_formData);
    }

    const validate = () => {

        /*if (validateCaptcha(formData.CaptchaValue) == false) {
            setMessage({ Text: "Lütfen güvenlik metnini doğru şekilde giriniz.", Type: "error" });
            return false;
        }
        */


        if (IsNull(formData.FeedbackType)) {
            setMessage({ Text: "Lütfen başvuru türünü seçiniz.", Type: "error" });
            return false;
        }

        if (IsNull(formData.Description)) {
            setMessage({ Text: "Lütfen açıklama giriniz.", Type: "error" });
            return false;
        }


        if (IsNull(formData.FullName)) {
            setMessage({ Text: "Lütfen adınızı giriniz.", Type: "error" });
            return false;
        }



        if (IsNull(formData.City)) {
            setMessage({ Text: "Lütfen şehir giriniz.", Type: "error" });
            return false;
        }

        if (IsNull(formData.Email)) {
            setMessage({ Text: "Lütfen e-posta giriniz.", Type: "error" });
            return false;
        }

        if (IsNull(formData.Address)) {
            setMessage({ Text: "Lütfen adresinizi numaranızı giriniz.", Type: "error" });
            return false;
        }
        return true;

    }

    const btnSubmit_Click = (e) => {

        if (validate()) {

            dismissMessage();

            setSubmitStatus(Constants_SubmitStatus.LOADING);

            FeedbackBusiness.SendFeedBack(formData).then((result) => {
                if (result == null || result.Type == "20" || result.Type == 20) {
                    setSubmitStatus(Constants_SubmitStatus.ERROR);
                }
                else {

                    setSubmitStatus(Constants_SubmitStatus.SUBMITTED);
                    setTimeout(() => {
                        closeWindow();
                    }, 2000);

                }
            });
        }
    }

    const dismissMessage = () => {
        setMessage(null);
    }

    const closeWindow = (e) => {
        props.closeWindow();
    }

    /*render*/
    return (
        <Modal show={props.show}
            className="ZoningStatusDocument_ModalContainer"
            onHide={(e) => { closeWindow(e) }} >
            <Modal.Header closeButton>

                <div className="feedback-widget-logo">
                    <img src="images/logo.png"></img>
                </div>
                <div className="feedback-widget-title">
                    <span>İstek/Öneri ve Şikayetleriniz</span>
                </div>
            </Modal.Header>
            <Modal.Body>
                {

                    <div>
                        {
                            submitStatus == Constants_SubmitStatus.LOADING && <ContainerLoading/>
                        }

                        {
                            submitStatus == Constants_SubmitStatus.ERROR &&
                            <div style={{ padding: '20px', backgroundColor: 'rgb(255 0 0 / 70%)', color: 'white' }}>
                                <BiError/>&nbsp;Mesajınız gönderilirken bir hata oluştu, lütfen daha sonra tekrar deneyin</div>
                        }

                        {
                            submitStatus == Constants_SubmitStatus.SUBMITTED &&
                            <div style={{ padding: '20px', backgroundColor: 'rgb(39 169 169)', color: 'white' }}>
                                <BiCheckCircle/>&nbsp;Mesajınız gönderildi!</div>
                        }

                        {
                            message != null ?
                                <MessageAlert dismissMessage={dismissMessage}
                                    message={message.Text}
                                    type={message.Type}></MessageAlert> : null
                        }


                        <div className="row feedback-form-row">
                            <div className="col-3 feedback-form-label">
                                Başvuru Türü
                            </div>
                            <div className="col-9">

                                {
                                    feedbackTypes && feedbackTypes.map(feedbackType => {
                                        return <Form.Check onChange={(e) => setField(e, "FeedbackType")} value={feedbackType.id} name="a" type="radio" label={feedbackType.name} defaultChecked={feedbackType.id == 1}></Form.Check>
                                    })
                                }

                            </div>
                        </div>


                        <div className="row feedback-form-row">
                            <div className="col-3 feedback-form-label">Ad Soyad</div>
                            <div className="col-9">
                                <Form.Control onChange={(e) => setField(e, "FullName")}
                                    type="text" placeholder="Adınızı soyadınızı giriniz"></Form.Control>
                            </div>
                        </div>

                        <div className="row feedback-form-row">
                            <div className="col-3 feedback-form-label">Şehir</div>
                            <div className="col-9">
                                <Form.Control onChange={(e) => setField(e, "City")} type="text"
                                    placeholder="Şehir adını giriniz"></Form.Control>
                            </div>
                        </div>

                        <div className="row feedback-form-row">
                            <div className="col-3 feedback-form-label">Eposta</div>
                            <div className="col-9">
                                <Form.Control onChange={(e) => setField(e, "Email")} type="text"
                                    placeholder="Eposta giriniz"></Form.Control>
                            </div>
                        </div>
                        <div className="row feedback-form-row">
                            <div className="col-3 feedback-form-label">Adres</div>
                            <div className="col-9">

                                <textarea
                                    className="w-100"
                                    onChange={(e) => setField(e, "Address")} placeholder="Adresinizi  giriniz">

                                </textarea>
                            </div>
                        </div>

                        <div className="row feedback-form-row">
                            <div className="col-3 feedback-form-label">Açıklama</div>
                            <div className="col-9">
                                <textarea
                                    className="w-100"
                                    style={{height:'100px'}}
                                    onChange={(e) => setField(e, "Description")} placeholder="Açıklama giriniz">

                                </textarea>
                            </div>
                        </div>


                        <div className="row feedback-form-row">
                            <div className="col-3 feedback-form-label"></div>
                            <div className="col-9">
                                {
                                    /*
                                    <LoadCanvasTemplate reloadText="Başka bir resim oluştur" />
                                    */
                                }
                                <Form.Control onChange={(e) => setField(e, "CaptchaValue")}
                                    type="text" placeholder="Resimdeki karakterleri giriniz"></Form.Control>
                            </div>
                        </div>
                    </div>
                }


            </Modal.Body>


            <Modal.Footer>
                {
                    submitStatus !== Constants_SubmitStatus.LOADING ? <Button variant="primary" onClick={(e) => btnSubmit_Click(e)}>
                        <BiUpload/>&nbsp;Gönder</Button>
                        : <ButtonLoading/>
                }

            </Modal.Footer>
        </Modal>);

}

export default FeedbackForm;