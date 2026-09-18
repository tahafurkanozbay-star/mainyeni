import { useMemo, type SyntheticEvent } from 'react';
import { createListIconModel } from '../../gis-engine/iconPresentation';
import type { IconRecord } from '../../gis-engine/contracts';

const FALLBACK_SRC = 'images/icons/map/pictureMarker.png';

export interface SharedGISIconProps {
  readonly record?: IconRecord | null;
  readonly size?: number;
  readonly className?: string;
}

const normalizeSize = (value: number): number =>
  Number.isFinite(value) ? Math.min(256, Math.max(12, Math.round(value))) : 28;

export function SharedGISIcon({ record, size = 28, className = '' }: SharedGISIconProps) {
  const model = useMemo(() => createListIconModel(record ?? {}), [record]);
  const pixelSize = normalizeSize(size);
  const handleError = (event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    if (image.dataset.fallbackApplied === 'true') return;
    image.dataset.fallbackApplied = 'true';
    image.src = FALLBACK_SRC;
  };
  return <img
    className={`shared-gis-icon ${className}`.trim()}
    src={model.src || FALLBACK_SRC}
    width={pixelSize}
    height={pixelSize}
    alt={model.alt}
    loading="lazy"
    decoding="async"
    onError={handleError}
  />;
}
export default SharedGISIcon;
