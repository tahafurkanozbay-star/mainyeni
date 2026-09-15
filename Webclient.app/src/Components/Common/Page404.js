import { faHome, faQuestion } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import './Page404.css';

export const Page404 = () => {

    return (<>
        <div className="row mainbar">
            <div className="d-none d-lg-block col-sm-12 col-md-12 col-lg-12 col-xl-12 mainbar_AppTitle">
                <div className="mainbar_AppLogo" onClick={(e) => window.location.href="/"}>
                    <img src="images/logo.png"></img>
                </div>
                <div className="mainbar_AppTitleText hidden-xs-down"  onClick={(e) => window.location.href="/"}>
                    <span className="mainbar_AppTitleText_Title1">ABB</span> | <span className="mainbar_AppTitleText_Title2">Kent Rehberi</span>
                </div>
            </div>

        </div>
        <div className="Page_Wrapper" style={{ minHeight: '30rem', borderTop: '1p solid gray', paddingLeft: '25px' }}>
            <div className="row" >

                <div className="col-3" style={{ fontSize: '72px', fontWeight: '600' }}>
                    404
                </div>
            </div>

            <div className="row" >

                <div className="col-12" style={{ fontSize: '36px' }}>
                    Sayfa Bulunamadı
                </div>
            </div>

            <div className="row" style={{ borderTop: '1px solid gray', marginTop: '20px' }} >

                <div className="col-12">
                    <a href="/" className="link404">
                        <div className="btn404">
                            <FontAwesomeIcon icon={faHome}></FontAwesomeIcon>&nbsp;
                            Uygulamaya Geri Dön
                        </div>

                    </a>
                </div>
            </div>

        </div>
    </>);


}