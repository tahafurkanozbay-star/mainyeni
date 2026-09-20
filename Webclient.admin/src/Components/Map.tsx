import { useCallback, useEffect, useRef, type HTMLAttributes } from "react";
import { Button } from "react-bootstrap";
import { AiOutlineDoubleLeft } from "react-icons/ai";
import { readFiniteNumber, readString } from "../platform/contracts";
import { reportAdminError } from "../platform/diagnostics";
import "./Map.css";

export interface AdminMapConfiguration {
  readonly Centerx?: unknown;
  readonly Centery?: unknown;
  readonly Zoom?: unknown;
  readonly DefaultBasemapTitle?: unknown;
}

export interface AdminMapExport {
  readonly Zoom: number;
  readonly Center: Readonly<{
    readonly longitude: number;
    readonly latitude: number;
  }>;
}

export interface MapProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  readonly config: AdminMapConfiguration;
  readonly exportCallBack: (details: AdminMapExport) => void;
}

interface ArcGisMapLike {
  basemap: unknown;
}

interface ArcGisPointLike {
  readonly longitude?: number;
  readonly latitude?: number;
  readonly x?: number;
  readonly y?: number;
}

interface ArcGisViewLike {
  center: ArcGisPointLike | readonly [number, number];
  zoom: number;
  readonly map: ArcGisMapLike;
  destroy(): void;
}

const readConfiguration = (config: AdminMapConfiguration) => {
  const longitude = readFiniteNumber(config.Centerx) ?? 32.85;
  const latitude = readFiniteNumber(config.Centery) ?? 39.93;
  const zoom = Math.min(23, Math.max(1, readFiniteNumber(config.Zoom) ?? 8));
  const basemap = readString(config.DefaultBasemapTitle) ?? "osm";
  return Object.freeze({ longitude, latitude, zoom, basemap });
};

const centerCoordinates = (center: ArcGisPointLike | readonly [number, number]): AdminMapExport["Center"] | null => {
  if (Array.isArray(center)) {
    const longitude = readFiniteNumber(center[0]);
    const latitude = readFiniteNumber(center[1]);
    return longitude === null || latitude === null
      ? null
      : Object.freeze({ longitude, latitude });
  }

  const longitude = readFiniteNumber(center.longitude ?? center.x);
  const latitude = readFiniteNumber(center.latitude ?? center.y);
  return longitude === null || latitude === null
    ? null
    : Object.freeze({ longitude, latitude });
};

export const Map = ({
  config,
  exportCallBack,
  className,
  ...containerProps
}: MapProps) => {
  const mapDiv = useRef<HTMLDivElement>(null);
  const viewRef = useRef<ArcGisViewLike | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    const load = async (): Promise<void> => {
      if (!mapDiv.current || viewRef.current) return;
      try {
        const [{ default: ArcGISMap }, { default: MapView }] = await Promise.all([
          import("@arcgis/core/Map.js"),
          import("@arcgis/core/views/MapView.js"),
        ]);
        if (cancelled || !mountedRef.current || !mapDiv.current) return;

        const normalized = readConfiguration(config);
        const map = new ArcGISMap({ basemap: normalized.basemap });
        const view = new MapView({
          container: mapDiv.current,
          map,
          zoom: normalized.zoom,
          center: [normalized.longitude, normalized.latitude],
          ui: { components: [] },
          padding: { top: 0 },
          constraints: { rotationEnabled: false },
        });

        viewRef.current = view as unknown as ArcGisViewLike;
      } catch (error) {
        if (!cancelled) reportAdminError("gis", "admin-map-load-failed", error);
      }
    };

    void load();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      const current = viewRef.current;
      viewRef.current = null;
      try {
        current?.destroy();
      } catch (error) {
        reportAdminError("gis", "admin-map-destroy-failed", error);
      }
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const normalized = readConfiguration(config);
    try {
      view.center = [normalized.longitude, normalized.latitude];
      view.zoom = normalized.zoom;
      view.map.basemap = normalized.basemap;
    } catch (error) {
      reportAdminError("gis", "admin-map-config-update-failed", error);
    }
  }, [config]);

  const exportConfig = useCallback((): void => {
    const view = viewRef.current;
    if (!view) return;
    const center = centerCoordinates(view.center);
    const zoom = readFiniteNumber(view.zoom);
    if (!center || zoom === null) {
      reportAdminError(
        "gis",
        "admin-map-export-invalid",
        new Error("Harita merkez veya zoom bilgisi okunamadı."),
      );
      return;
    }
    exportCallBack(Object.freeze({ Zoom: zoom, Center: center }));
  }, [exportCallBack]);

  return (
    <>
      <div>
        <Button
          type="button"
          variant="outline-secondary"
          onClick={exportConfig}
          disabled={!viewRef.current}
        >
          <AiOutlineDoubleLeft aria-hidden="true" />
          <span className="ms-1">Bu koordinatları kullan</span>
        </Button>
      </div>
      <div
        {...containerProps}
        className={["esri-map", "map-container", className].filter(Boolean).join(" ")}
        ref={mapDiv}
        aria-label="Harita merkez seçimi"
      />
    </>
  );
};
