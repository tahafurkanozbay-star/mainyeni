import { MdOutlineApps } from "react-icons/md";
import { Global } from "../../Core/Global";

export const HomePage = () => {


    return (<>
        <div className="page">
            <div className="page-title">
                <MdOutlineApps></MdOutlineApps>
                <span>{Global.App.Title1}<strong>{Global.App.Title2}</strong> &gt; Giriş</span>
            </div>
            <div className="page-body">

                <div className="main-page-cards">
                    <div className="main-page-card">
                        <div className="main-page-card-title">Konfigürasyon</div>
                        <div className="main-page-card-body">
                            <p className="main-page-card-link"><a href="#/mapconfig">Harita Ayarları</a></p>
                            <p className="main-page-card-link"><a href="#/configservices">Konfigürasyon Servisleri</a></p>
                        </div>
                    </div>
                </div>


                <div className="main-page-cards">
                    <div className="main-page-card">
                        <div className="main-page-card-title">Katmanlar</div>
                        <div className="main-page-card-body">
                            <p className="main-page-card-link"><a href="#/layers">Katmanlar</a></p>
                            <p className="main-page-card-link"><a href="#/basemaps">Altlık Haritalar</a></p>
                        </div>
                    </div>
                </div>

                <div className="main-page-cards">
                    <div className="main-page-card">
                        <div className="main-page-card-title">Kayıtlar</div>
                        <div className="main-page-card-body">
                            <p className="main-page-card-link"><a href="#/feedbacks">Kullanıcı Geri Bildirimleri</a></p>
                        </div>
                    </div>
                </div>

                <div className="main-page-cards">
                    <div className="main-page-card">
                        <div className="main-page-card-title">Sistem</div>
                        <div className="main-page-card-body">

                            <p className="main-page-card-link"><a href="#/adminaccount">Yönetici Hesap Ayarları</a></p>
                            <p className="main-page-card-link"><a href="#/errorlogs">Hata Kayıtları</a></p>
                        </div>
                    </div>
                </div>

            </div>
        </div>
    </>);


}