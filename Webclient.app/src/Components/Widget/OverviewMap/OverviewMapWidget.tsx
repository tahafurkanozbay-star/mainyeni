import {
  Component,
  type ReactNode,
} from 'react';
import { loadArcgisModules } from '../../../gis-engine/arcgisModuleRuntime';

interface RemovableHandle {
  readonly remove?: () => void;
}

interface ArcgisInteractionEvent {
  readonly key?: string;
  readonly stopPropagation: () => void;
}

interface OverviewGraphicsCollection {
  readonly add: (graphic: OverviewGraphic) => unknown;
  readonly remove?: (graphic: OverviewGraphic) => unknown;
}

interface OverviewGraphic {
  geometry: unknown;
}

interface OverviewMapView {
  readonly graphics: OverviewGraphicsCollection;
  readonly width: number;
  readonly height: number;
  readonly center: unknown;
  readonly scale: number;
  readonly on: (...args: readonly unknown[]) => RemovableHandle;
  readonly when: (callback: () => void) => unknown;
  readonly goTo: (target: unknown) => Promise<unknown>;
  readonly destroy?: () => void;
}

interface MainMapView {
  readonly center: unknown;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  readonly when: (callback: () => void) => unknown;
}

interface ArcgisMapConstructor {
  new(options: Readonly<Record<string, unknown>>): unknown;
}

interface ArcgisMapViewConstructor {
  new(options: Readonly<Record<string, unknown>>): OverviewMapView;
}

interface ArcgisGraphicConstructor {
  new(options: Readonly<Record<string, unknown>>): OverviewGraphic;
}

interface ArcgisWatchUtils {
  readonly init: (
    target: unknown,
    propertyName: string,
    callback: (value: unknown) => void,
  ) => RemovableHandle;
}

interface OverviewMapWidgetProps {
  readonly mainView: MainMapView;
  readonly registerWindow: (
    window: OverviewMapWidget,
    visible: boolean,
    query: string,
  ) => void;
  readonly getWindowVisibility: (windowId: string) => boolean;
  readonly windowid: string;
}

const PROHIBITED_KEYS = new Set(['+', '-', 'Shift', '_', '=']);

const isGoToInterrupted = (error: unknown): boolean =>
  error !== null
  && typeof error === 'object'
  && 'name' in error
  && (error as { readonly name?: unknown }).name === 'view:goto-interrupted';

export class OverviewMapWidget extends Component<OverviewMapWidgetProps> {
  private initialized = false;
  private disposed = false;
  private mapView: OverviewMapView | null = null;
  private extentGraphic: OverviewGraphic | null = null;
  private readonly runtimeHandles = new Set<RemovableHandle>();

  componentDidMount(): void {
    this.props.registerWindow(this, true, '');
  }

  componentDidUpdate(): void {
    if (!this.initialized && !this.disposed) {
      void this.loadMap('overviewMapDiv');
    }
  }

  componentWillUnmount(): void {
    this.disposed = true;

    for (const handle of this.runtimeHandles) {
      try {
        handle.remove?.();
      } catch (error) {
        globalThis.reportError?.(error);
      }
    }
    this.runtimeHandles.clear();

    if (this.extentGraphic && this.mapView) {
      try {
        this.mapView.graphics.remove?.(this.extentGraphic);
      } catch (error) {
        globalThis.reportError?.(error);
      }
    }
    this.extentGraphic = null;

    try {
      this.mapView?.destroy?.();
    } catch (error) {
      globalThis.reportError?.(error);
    }
    this.mapView = null;
    this.initialized = false;
  }

  private trackHandle(handle: RemovableHandle | null | undefined): void {
    if (handle) this.runtimeHandles.add(handle);
  }

  private setup(
    Graphic: ArcgisGraphicConstructor,
    watchUtils: ArcgisWatchUtils,
  ): void {
    const mapView = this.mapView;
    if (!mapView || this.disposed) return;

    const extentGraphic = new Graphic({
      geometry: null,
      symbol: {
        type: 'simple-fill',
        color: [0, 0, 0, 0.5],
        outline: null,
      },
    });
    this.extentGraphic = extentGraphic;
    mapView.graphics.add(extentGraphic);

    const extentWatch = watchUtils.init(
      this.props.mainView,
      'extent',
      (extent: unknown) => {
        const activeView = this.mapView;
        if (!activeView || this.disposed) return;

        const widthRatio = activeView.width > 0
          ? this.props.mainView.width / activeView.width
          : 1;
        const heightRatio = activeView.height > 0
          ? this.props.mainView.height / activeView.height
          : 1;
        const scale = this.props.mainView.scale
          * 2
          * Math.max(widthRatio, heightRatio);

        void activeView.goTo({
          center: this.props.mainView.center,
          scale,
        }).catch((error: unknown) => {
          if (!isGoToInterrupted(error)) {
            globalThis.reportError?.(error);
          }
        });

        extentGraphic.geometry = extent;
      },
    );

    this.trackHandle(extentWatch);
  }

  private stopInteraction = (event: ArcgisInteractionEvent): void => {
    event.stopPropagation();
  };

  private stopKeyboardInteraction = (event: ArcgisInteractionEvent): void => {
    if (event.key && PROHIBITED_KEYS.has(event.key)) {
      event.stopPropagation();
    }
  };

  private async loadMap(container: string): Promise<OverviewMapView | null> {
    if (this.initialized || this.disposed) return this.mapView;
    this.initialized = true;

    try {
      const [Map, MapView, Graphic, watchUtils] = await loadArcgisModules<
        readonly [
          ArcgisMapConstructor,
          ArcgisMapViewConstructor,
          ArcgisGraphicConstructor,
          ArcgisWatchUtils,
        ]
      >([
        'esri/Map',
        'esri/views/MapView',
        'esri/Graphic',
        'esri/core/watchUtils',
      ]);

      if (this.disposed) return null;

      const map = new Map({
        basemap: 'topo-vector',
      });

      const view = new MapView({
        container,
        map,
        ui: {
          components: [],
        },
        constraints: {
          rotationEnabled: false,
        },
      });

      this.mapView = view;

      this.trackHandle(view.on('key-down', this.stopKeyboardInteraction));
      this.trackHandle(view.on('mouse-wheel', this.stopInteraction));
      this.trackHandle(view.on('double-click', this.stopInteraction));
      this.trackHandle(view.on(
        'double-click',
        ['Control'],
        this.stopInteraction,
      ));
      this.trackHandle(view.on('drag', this.stopInteraction));

      view.when(() => {
        if (this.disposed) return;
        this.props.mainView.when(() => {
          if (!this.disposed) this.setup(Graphic, watchUtils);
        });
      });

      return view;
    } catch (error) {
      this.initialized = false;
      globalThis.reportError?.(error);
      return null;
    }
  }

  render(): ReactNode {
    const visible = this.props.getWindowVisibility(this.props.windowid);

    return (
      <section
        id="overviewMapDiv"
        className="overviewMapDiv"
        style={{ visibility: visible ? 'visible' : 'hidden' }}
        aria-label="Genel bakış haritası"
        aria-hidden={!visible}
      >
        <div
          id="overviewMap_extentDiv"
          className="overviewMap_extentDiv"
          aria-hidden="true"
        />
      </section>
    );
  }
}
