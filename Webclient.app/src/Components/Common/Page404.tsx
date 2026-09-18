import type { ReactNode } from 'react';
import './Page404.css';

export const Page404 = (): ReactNode => (
  <main className="page404">
    <header className="page404__header">
      <a className="page404__brand" href="/" aria-label="ABB Kent Rehberi ana sayfası">
        <img
          className="page404__logo"
          src="images/logo.png"
          alt=""
          aria-hidden="true"
        />
        <span className="page404__brand-text">
          <strong>ABB</strong>
          <span aria-hidden="true"> · </span>
          <span>Kent Rehberi</span>
        </span>
      </a>
    </header>

    <section className="page404__content" aria-labelledby="page404-title">
      <p className="page404__code" aria-hidden="true">404</p>
      <h1 id="page404-title">Sayfa bulunamadı</h1>
      <p className="page404__description">
        Aradığınız sayfanın adresi değişmiş, kaldırılmış veya hatalı yazılmış olabilir.
      </p>
      <a className="page404__home-link" href="/">
        <span aria-hidden="true">←</span>
        <span>Kent Rehberi'ne dön</span>
      </a>
    </section>
  </main>
);
