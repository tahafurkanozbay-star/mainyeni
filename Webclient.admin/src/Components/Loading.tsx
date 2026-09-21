import { Button } from 'react-bootstrap';
import { ImTable } from 'react-icons/im';

import './Loading.css';

const loadingGif = 'images/ajax-loader.gif';

export interface LoadingProps {
  readonly text?: string;
}

export const ButtonLoading = ({ text }: LoadingProps) => (
  <Button
    className="w-100 ButtonLoading"
    disabled
    aria-busy="true"
  >
    <img src={loadingGif} alt="" aria-hidden="true" />
    &nbsp;&nbsp;&nbsp;{text ?? 'İşlem sürüyor'}
  </Button>
);

export const ContainerLoading = ({ text }: LoadingProps) => (
  <div
    className="w-100 h-100 ContainerLoading"
    role="status"
    aria-live="polite"
    aria-busy="true"
  >
    <img src={loadingGif} alt="" aria-hidden="true" />
    &nbsp;&nbsp;&nbsp;{text ?? 'Yükleniyor'}
  </div>
);

export const FullScreenLoading = ({ text }: LoadingProps) => (
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
        alt=""
        aria-hidden="true"
      />
    </div>
    <img src={loadingGif} alt="" aria-hidden="true" />
    &nbsp;&nbsp;&nbsp;{text ?? 'Yükleniyor'}
  </div>
);

export const NoResultsFound = ({ text }: LoadingProps) => (
  <div className="NoResultsFound" role="status">
    <ImTable aria-hidden="true" />
    &nbsp;{text ?? 'Sonuç bulunamadı'}
  </div>
);

export const ImageNotFound = () => (
  <div className="imageNotFound">
    <img
      src="images/imagenotfound.png"
      style={{ width: '100%' }}
      alt="Görsel bulunamadı"
    />
  </div>
);
