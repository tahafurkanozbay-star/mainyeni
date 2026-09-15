import { useEffect, useState } from "react"
import { Button, Modal } from "react-bootstrap";
import CryptoJS from "crypto-js";
import { IsNull } from "../../../Toolbox/ObjectHelper";
import { TextHelper } from "../../../Toolbox/TextHelper";
import "./DisclaimerWidget.css";

export const DisclaimerWidget = (props) => {

    const [show, setShow] = useState(false);

    useEffect(() => {

        //Get preferences from local storage
        /*let accepted = localStorage.getItem(termsOfServiceAccepted_Key);
        if (IsNull(accepted)) {
            
        }
        */

        setShow(true);

    }, []);


    const termsOfServiceAccepted_Key = "_tosa";

    const handleClose = () => {

        /*
        let encrypted = CryptoJS.DES.encrypt(TextHelper.CreateRandomNumber() + "", TextHelper.CreateRandomNumber() + "");
        localStorage.setItem(termsOfServiceAccepted_Key, encrypted);
        */
        setShow(false);
    }

    return (
        <>
            <Modal
                show={show}
                onHide={handleClose}
                backdrop="static"
                keyboard={false}
                className="disclaimer-modal"
            >
                <Modal.Header closeButton>
                    <Modal.Title className="disclaimer-header">
                        <div className="disclaimer-logo">
                            <img src="images/logo.png" style={{ height: '36px' }}></img>
                        </div>
                        <div className="disclaimer-title">
                            Bilgilendirme
                        </div>
                        
                        </Modal.Title>
                </Modal.Header>
                <Modal.Body>
                    <div className="disclaimer-body">
                        <p>
                        Ankara'daki yapı stoğunun Deprem Yönetmelikleri dikkate alınarak, 
                        </p>
                        <p>
                        Bina Yapım Yıllarına göre renklendirilmesi sonucu oluşan Deprem Yönetmeliklerine Göre Yapı Sınıflandırma Analizi çalışmasıdır.
                        </p>
                        <p>
                            Binalar;
                        </p>
                        <ul className="disclaimer-list">
                            <li>
                                1998 Deprem Yönetmeliği Öncesi
                            </li>
                            <li>
                                1998 Deprem Yönetmeliği Sonrası
                            </li>
                            <li>
                                2007 Deprem Yönetmeliği Sonrası
                            </li>
                            <li>
                                2018 Deprem Yönetmeliği Sonrası
                            </li>
                        </ul>
                        <p>
                            olacak şekilde 4 sınıfta tasniflenmiştir.
                        </p>
                        <p>
                            <strong>Yapılan sınıflandırma binaların riskli olduğunu göstermemektedir.</strong>
                        </p>
                        <p>
                            * Verilerin doğruluk oranı %90-%99 aralığındadır.
                        </p>
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button className="form-button" variant="primary" onClick={handleClose}>
                        Anladım
                    </Button>
                </Modal.Footer>
            </Modal>
        </>
    );


}