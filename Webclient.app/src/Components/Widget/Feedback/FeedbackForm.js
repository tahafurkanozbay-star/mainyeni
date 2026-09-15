import React, { useEffect, useState } from "react";
import { Modal, Button, Form } from "react-bootstrap";
import { FeedbackBusiness } from "../../../Business/FeedbackBusiness";
import { IsNull } from "../../../Toolbox/ObjectHelper";
import { ContainerLoading, ButtonLoading } from "../../Common/Loading";
import { MessageAlert } from "../../Common/MessageAlert";
import { BiCheckCircle, BiError, BiUpload } from "react-icons/bi";

const Constants_SubmitStatus = {
    NONE: 0,
    LOADING: 1,
    SUBMITTED: 2,
    ERROR: 3
};

const INITIAL_FORM_DATA = {
    CaptchaValue: "",
    FeedbackType: 1,
    country: -1
};

const FeedbackForm = ({ show, closeWindow }) => {
    const [feedbackTypes, setFeedbackTypes] = useState(null);
    const [message, setMessage] = useState(null);
    const [submitStatus, setSubmitStatus] = useState(Constants_SubmitStatus.NONE);
    const [formData, setFormData] = useState(INITIAL_FORM_DATA);

    useEffect(() => {
        if (!show) return;

        setFeedbackTypes(FeedbackBusiness.GetFeedbackTypes());
        setFormData(INITIAL_FORM_DATA);
        setMessage(null);
        setSubmitStatus(Constants_SubmitStatus.NONE);
    }, [show]);

    const setField = (event, key) => {
        const value = event.target.value;
        setFormData(current => ({ ...current, [key]: value }));
    };

    const validate = () => {
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
            setMessage({ Text: "Lütfen adresinizi giriniz.", Type: "error" });
            return false;
        }
        return true;
    };

    const dismissMessage = () => setMessage(null);

    const submit = async () => {
        if (!validate()) return;

        dismissMessage();
        setSubmitStatus(Constants_SubmitStatus.LOADING);

        try {
            const result = await FeedbackBusiness.SendFeedBack(formData);
            if (!result || Number(result.Type) === 20) {
                setSubmitStatus(Constants_SubmitStatus.ERROR);
                return;
            }

            setSubmitStatus(Constants_SubmitStatus.SUBMITTED);
            window.setTimeout(closeWindow, 2000);
        } catch (error) {
            setSubmitStatus(Constants_SubmitStatus.ERROR);
        }
    };

    return (
        <Modal
            show={show}
            className="ZoningStatusDocument_ModalContainer"
            onHide={closeWindow}
            aria-labelledby="feedback-dialog-title"
        >
            <Modal.Header closeButton>
                <div className="feedback-widget-logo">
                    <img src="images/logo.png" alt="Ankara Kent Rehberi" />
                </div>
                <div className="feedback-widget-title">
                    <span id="feedback-dialog-title">İstek/Öneri ve Şikayetleriniz</span>
                </div>
            </Modal.Header>

            <Modal.Body>
                {submitStatus === Constants_SubmitStatus.LOADING && <ContainerLoading />}

                {submitStatus === Constants_SubmitStatus.ERROR && (
                    <div
                        role="alert"
                        style={{ padding: "20px", backgroundColor: "rgb(255 0 0 / 70%)", color: "white" }}
                    >
                        <BiError aria-hidden="true" />&nbsp;Mesajınız gönderilirken bir hata oluştu, lütfen daha sonra tekrar deneyin.
                    </div>
                )}

                {submitStatus === Constants_SubmitStatus.SUBMITTED && (
                    <div
                        role="status"
                        aria-live="polite"
                        style={{ padding: "20px", backgroundColor: "rgb(39 169 169)", color: "white" }}
                    >
                        <BiCheckCircle aria-hidden="true" />&nbsp;Mesajınız gönderildi!
                    </div>
                )}

                {message ? (
                    <MessageAlert
                        dismissMessage={dismissMessage}
                        message={message.Text}
                        type={message.Type}
                    />
                ) : null}

                <div className="row feedback-form-row">
                    <div className="col-3 feedback-form-label">Başvuru Türü</div>
                    <div className="col-9">
                        {feedbackTypes?.map(feedbackType => (
                            <Form.Check
                                key={feedbackType.id}
                                id={`feedback-type-${feedbackType.id}`}
                                onChange={event => setField(event, "FeedbackType")}
                                value={feedbackType.id}
                                name="feedbackType"
                                type="radio"
                                label={feedbackType.name}
                                checked={String(formData.FeedbackType) === String(feedbackType.id)}
                            />
                        ))}
                    </div>
                </div>

                <div className="row feedback-form-row">
                    <label className="col-3 feedback-form-label" htmlFor="feedback-full-name">Ad Soyad</label>
                    <div className="col-9">
                        <Form.Control
                            id="feedback-full-name"
                            onChange={event => setField(event, "FullName")}
                            type="text"
                            autoComplete="name"
                            placeholder="Adınızı soyadınızı giriniz"
                        />
                    </div>
                </div>

                <div className="row feedback-form-row">
                    <label className="col-3 feedback-form-label" htmlFor="feedback-city">Şehir</label>
                    <div className="col-9">
                        <Form.Control
                            id="feedback-city"
                            onChange={event => setField(event, "City")}
                            type="text"
                            autoComplete="address-level2"
                            placeholder="Şehir adını giriniz"
                        />
                    </div>
                </div>

                <div className="row feedback-form-row">
                    <label className="col-3 feedback-form-label" htmlFor="feedback-email">E-posta</label>
                    <div className="col-9">
                        <Form.Control
                            id="feedback-email"
                            onChange={event => setField(event, "Email")}
                            type="email"
                            autoComplete="email"
                            placeholder="E-posta giriniz"
                        />
                    </div>
                </div>

                <div className="row feedback-form-row">
                    <label className="col-3 feedback-form-label" htmlFor="feedback-address">Adres</label>
                    <div className="col-9">
                        <textarea
                            id="feedback-address"
                            className="w-100"
                            onChange={event => setField(event, "Address")}
                            autoComplete="street-address"
                            placeholder="Adresinizi giriniz"
                        />
                    </div>
                </div>

                <div className="row feedback-form-row">
                    <label className="col-3 feedback-form-label" htmlFor="feedback-description">Açıklama</label>
                    <div className="col-9">
                        <textarea
                            id="feedback-description"
                            className="w-100"
                            style={{ height: "100px" }}
                            onChange={event => setField(event, "Description")}
                            placeholder="Açıklama giriniz"
                        />
                    </div>
                </div>

                <div className="row feedback-form-row">
                    <label className="col-3 feedback-form-label" htmlFor="feedback-captcha">Güvenlik metni</label>
                    <div className="col-9">
                        <Form.Control
                            id="feedback-captcha"
                            onChange={event => setField(event, "CaptchaValue")}
                            type="text"
                            autoComplete="off"
                            placeholder="Resimdeki karakterleri giriniz"
                        />
                    </div>
                </div>
            </Modal.Body>

            <Modal.Footer>
                {submitStatus !== Constants_SubmitStatus.LOADING ? (
                    <Button variant="primary" onClick={submit}>
                        <BiUpload aria-hidden="true" />&nbsp;Gönder
                    </Button>
                ) : (
                    <ButtonLoading />
                )}
            </Modal.Footer>
        </Modal>
    );
};

export default FeedbackForm;
