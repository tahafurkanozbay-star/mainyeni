import "./Page404.css";

export const SharedPage404 = () => (
  <main className="page page404-body">
    <div className="container py-5 text-center">
      <p className="display-1" aria-hidden="true">404</p>
      <h1>Sayfa bulunamadı</h1>
      <p>
        İstediğiniz yönetim sayfası mevcut değil veya artık kullanılmıyor.
      </p>
      <a className="btn btn-primary" href="#/">
        Yönetim ana sayfasına dön
      </a>
    </div>
  </main>
);
