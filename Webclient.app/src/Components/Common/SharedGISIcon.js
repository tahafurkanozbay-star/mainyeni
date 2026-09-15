import React, { useMemo } from "react";
import { createListIconModel } from "../../gis-engine/iconPresentation";

const FALLBACK_SRC = "images/icons/map/pictureMarker.png";

export function SharedGISIcon({ record, size = 28, className = "" }) {
    const model = useMemo(() => createListIconModel(record || {}), [record]);
    const source = model.src || FALLBACK_SRC;
    return <img
        className={`shared-gis-icon ${className}`.trim()}
        src={source}
        width={size}
        height={size}
        alt={model.alt}
        loading="lazy"
        decoding="async"
        onError={(event) => {
            if (event.currentTarget.dataset.fallbackApplied === "true") return;
            event.currentTarget.dataset.fallbackApplied = "true";
            event.currentTarget.src = FALLBACK_SRC;
        }}
    />;
}

export default SharedGISIcon;
