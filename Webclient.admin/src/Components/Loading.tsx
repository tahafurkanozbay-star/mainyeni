import type { ReactNode } from "react";
import { Button } from "react-bootstrap";
import "./Loading.css";

const loadingGif = "images/ajax-loader.gif";

export interface LoadingProps {
  readonly text?: ReactNode;
}

export const ButtonLoading = ({ text = "İşlem sürüyor" }: LoadingProps) => (
  <Button
    className="w-100 ButtonLoading"
    disabled
    aria-busy="true"
    aria-live="polite"
  >
    <img src={loadingGif} alt="" aria-hidden="true" />
    <span className="ms-2">{text}</span>
  </Button>
);

export const ContainerLoading = ({ text = "Yükleniyor" }: LoadingProps) => (
  <div
    className="w-100 h-100 ContainerLoading"
    role="status"
    aria-live="polite"
    aria-busy="true"
  >
    <img src={loadingGif} alt="" aria-hidden="true" />
    <span className="ms-2">{text}</span>
  </div>
);

export const FullScreenLoading = ({ text = "Yönetim paneli hazırlanıyor" }: LoadingProps) => (
  <div
    className="FullScreenLoading"
    role="status"
    aria-live="polite"
    aria-busy="true"
  >
    <div>
      <img
        src="logo.png"
        className="FullScreenLoading_Logo"
        alt="ABB Rehber Admin"
      />
    </div>
    <img src={loadingGif} alt="" aria-hidden="true" />
    <span className="ms-2">{text}</span>
  </div>
);

export const NoResultsFound = ({ text = "Sonuç bulunamadı" }: LoadingProps) => (
  <div className="NoResultsFound" role="status">
    {text}
  </div>
);

export const ImageNotFound = () => (
  <div className="imageNotFound">
    <img
      src="images/imagenotfound.png"
      style={{ width: "100%" }}
      alt="Görsel bulunamadı"
    />
  </div>
);
