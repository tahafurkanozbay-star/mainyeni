import type { MouseEvent, ReactNode } from 'react';
import { BiZoomIn } from 'react-icons/bi';
import { TbRoute } from 'react-icons/tb';
import './CommonQueryResultItemTools.css';

export interface CommonQueryResultItemToolsProps<Item> {
  readonly item: Item;
  readonly zoomCallback?: (event: MouseEvent<HTMLButtonElement>, item: Item) => void;
  readonly showRouteCallback?: (event: MouseEvent<HTMLButtonElement>, item: Item) => void;
  readonly disableZoom?: boolean;
  readonly disableRoute?: boolean;
}

export function CommonQueryResultItemTools<Item>({
  item,
  zoomCallback,
  showRouteCallback,
  disableZoom = false,
  disableRoute = false,
}: CommonQueryResultItemToolsProps<Item>): ReactNode {
  const invoke = (
    event: MouseEvent<HTMLButtonElement>,
    callback: ((event: MouseEvent<HTMLButtonElement>, item: Item) => void) | undefined,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    callback?.(event, item);
  };

  return (
    <div className="result-item-tools-container" aria-label="Sonuç işlemleri">
      <button
        type="button"
        className="result-item-tool-button"
        onClick={(event) => invoke(event, zoomCallback)}
        aria-label="Haritada göster"
        disabled={disableZoom}
      >
        <BiZoomIn className="result-item-tool-button-icon" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="result-item-tool-button"
        onClick={(event) => invoke(event, showRouteCallback)}
        aria-label="Yol tarifi al"
        disabled={disableRoute}
      >
        <TbRoute className="result-item-tool-button-icon" aria-hidden="true" />
      </button>
    </div>
  );
}
