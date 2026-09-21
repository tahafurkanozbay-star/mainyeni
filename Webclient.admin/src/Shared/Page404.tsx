import { Link } from 'react-router-dom';
import './Page404.css';

export const Page404 = () => (
  <main className="container py-5 text-center" aria-labelledby="not-found-title">
    <p className="display-1" aria-hidden="true">404</p>
    <h1 id="not-found-title">Sayfa bulunamadı</h1>
    <p className="lead">İstediğiniz yönetim sayfası mevcut değil veya taşınmış olabilir.</p>
    <Link className="btn btn-primary" to="/">Yönetim ana sayfasına dön</Link>
  </main>
);
