import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { AiOutlineClear, AiOutlineDelete } from 'react-icons/ai';
import { BiRectangle, BiShapePolygon } from 'react-icons/bi';
import { BsCircle } from 'react-icons/bs';
import { GrCursor } from 'react-icons/gr';
import { HiOutlineArrowTrendingUp } from 'react-icons/hi2';
import { IoArrowRedoOutline, IoArrowUndoOutline } from 'react-icons/io5';
import { MdGesture } from 'react-icons/md';
import { TbPoint } from 'react-icons/tb';
import { loadArcgisModules } from '../../../gis-engine/arcgisModuleRuntime';
import {
  createLayerOwner,
  type LayerOwner,
  type LayerViewLike,
} from '../../../gis-engine/layerOwnership';
import MapManager from '../../../Store/Managers/MapManager';
import ColorPicker from './ColorPicker';
import {
  ADVANCED_SKETCH_TOOLS,
  DEFAULT_ADVANCED_SKETCH_STYLE,
  createAdvancedSketchSession,
  type AdvancedSketchSession,
  type AdvancedSketchSnapshot,
  type AdvancedSketchStyle,
  type AdvancedSketchTool,
  type GraphicsLayerLike,
  type SketchMapViewLike,
  type SketchViewModelLike,
} from './AdvancedSketchRuntime';
import './AdvancedSketchWidgetMain.css';

const OWNER_ID = 'advanced-sketch-widget';
const LAYER_ID = 'advanced-sketch-user-drawings';

interface SketchMapLike {
  readonly add?: (layer: GraphicsLayerLike) => unknown;
  readonly remove?: (layer: GraphicsLayerLike) => unknown;
}

interface AdvancedSketchMapView extends SketchMapViewLike, LayerViewLike<GraphicsLayerLike> {
  readonly map?: SketchMapLike | null;
}

interface GraphicsLayerConstructor {
  new(options?: Readonly<Record<string, unknown>>): GraphicsLayerLike;
}

interface SketchViewModelConstructor {
  new(options: Readonly<Record<string, unknown>>): SketchViewModelLike;
}

interface ToolDescriptor {
  readonly tool: AdvancedSketchTool;
  readonly label: string;
  readonly shortcut: string;
  readonly icon: ReactNode;
}

const TOOL_DESCRIPTORS: readonly ToolDescriptor[] = Object.freeze([
  {
    tool: ADVANCED_SKETCH_TOOLS.SELECT,
    label: 'Seç',
    shortcut: 'V',
    icon: <GrCursor aria-hidden="true" />,
  },
  {
    tool: ADVANCED_SKETCH_TOOLS.POINT,
    label: 'Nokta',
    shortcut: 'P',
    icon: <TbPoint aria-hidden="true" />,
  },
  {
    tool: ADVANCED_SKETCH_TOOLS.POLYLINE,
    label: 'Çizgi',
    shortcut: 'L',
    icon: <HiOutlineArrowTrendingUp aria-hidden="true" />,
  },
  {
    tool: ADVANCED_SKETCH_TOOLS.FREEHAND,
    label: 'Serbest',
    shortcut: 'F',
    icon: <MdGesture aria-hidden="true" />,
  },
  {
    tool: ADVANCED_SKETCH_TOOLS.POLYGON,
    label: 'Poligon',
    shortcut: 'G',
    icon: <BiShapePolygon aria-hidden="true" />,
  },
  {
    tool: ADVANCED_SKETCH_TOOLS.RECTANGLE,
    label: 'Dikdörtgen',
    shortcut: 'R',
    icon: <BiRectangle aria-hidden="true" />,
  },
  {
    tool: ADVANCED_SKETCH_TOOLS.CIRCLE,
    label: 'Daire',
    shortcut: 'C',
    icon: <BsCircle aria-hidden="true" />,
  },
]);

const SHORTCUT_TO_TOOL = new Map(
  TOOL_DESCRIPTORS.map((descriptor) => [descriptor.shortcut.toLowerCase(), descriptor.tool]),
);

const initialSnapshot = (): AdvancedSketchSnapshot => Object.freeze({
  tool: ADVANCED_SKETCH_TOOLS.SELECT,
  phase: 'idle',
  style: DEFAULT_ADVANCED_SKETCH_STYLE,
  graphicCount: 0,
  selectionCount: 0,
  canUndo: false,
  canRedo: false,
  message: 'Çizim aracı hazırlanıyor.',
  error: null,
});

const asMapView = (value: unknown): AdvancedSketchMapView | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as AdvancedSketchMapView;
  if (!candidate.map || typeof candidate.map.add !== 'function') return null;
  return candidate;
};

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('input, select, textarea, [contenteditable="true"]'));
};

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.trim()
    ? error.message
    : 'Çizim araçları başlatılamadı.';

export const AdvancedSketchWidgetMain = (): ReactNode => {
  const [snapshot, setSnapshot] = useState<AdvancedSketchSnapshot>(initialSnapshot);
  const [loading, setLoading] = useState(true);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const sessionRef = useRef<AdvancedSketchSession | null>(null);
  const ownerRef = useRef<LayerOwner<GraphicsLayerLike> | null>(null);
  const layerRef = useRef<GraphicsLayerLike | null>(null);
  const initializationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    const requestId = ++initializationRef.current;
    const view = asMapView(MapManager.GetMapView());

    if (!view) {
      setLoading(false);
      setInitializationError('Harita görünümü henüz hazır değil.');
      return () => {
        mountedRef.current = false;
        initializationRef.current += 1;
      };
    }

    const initialize = async (): Promise<void> => {
      try {
        const [SketchViewModel, GraphicsLayer] = await loadArcgisModules<
          readonly [SketchViewModelConstructor, GraphicsLayerConstructor]
        >([
          'esri/widgets/Sketch/SketchViewModel',
          'esri/layers/GraphicsLayer',
        ]);

        if (!mountedRef.current || requestId !== initializationRef.current) return;

        const layer = new GraphicsLayer({
          id: LAYER_ID,
          title: 'Kullanıcı çizimleri',
          listMode: 'hide',
        });
        const owner = createLayerOwner<GraphicsLayerLike>(view, OWNER_ID);
        if (!owner.add(layer)) {
          layer.destroy?.();
          throw new Error('Çizim katmanı haritaya eklenemedi.');
        }

        const sketchViewModel = new SketchViewModel({
          view,
          layer,
          defaultCreateOptions: { mode: 'click' },
          defaultUpdateOptions: {
            tool: 'transform',
            enableRotation: true,
            enableScaling: true,
            multipleSelectionEnabled: false,
          },
        });

        if (!mountedRef.current || requestId !== initializationRef.current) {
          try {
            sketchViewModel.destroy?.();
          } finally {
            owner.clear();
            layer.destroy?.();
          }
          return;
        }

        ownerRef.current = owner;
        layerRef.current = layer;
        const session = createAdvancedSketchSession({
          view,
          layer,
          sketchViewModel,
          initialTool: ADVANCED_SKETCH_TOOLS.SELECT,
          initialStyle: DEFAULT_ADVANCED_SKETCH_STYLE,
          onChange: (next) => {
            if (mountedRef.current) setSnapshot(next);
          },
          onError: (error) => {
            globalThis.reportError?.(error);
          },
        });
        sessionRef.current = session;
        setSnapshot(session.snapshot());
        setInitializationError(null);
        setLoading(false);
      } catch (error) {
        globalThis.reportError?.(error);
        if (!mountedRef.current || requestId !== initializationRef.current) return;
        setInitializationError(errorMessage(error));
        setLoading(false);
      }
    };

    void initialize();

    return () => {
      mountedRef.current = false;
      initializationRef.current += 1;
      sessionRef.current?.destroy();
      sessionRef.current = null;
      ownerRef.current?.clear();
      ownerRef.current = null;
      try {
        layerRef.current?.destroy?.();
      } catch (error) {
        globalThis.reportError?.(error);
      }
      layerRef.current = null;
    };
  }, []);

  const activateTool = useCallback((tool: AdvancedSketchTool): void => {
    sessionRef.current?.activateTool(tool);
  }, []);

  const updateStyle = useCallback((patch: Parameters<AdvancedSketchSession['setStyle']>[0]): void => {
    sessionRef.current?.setStyle(patch);
  }, []);

  const handleKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isEditableTarget(event.target)) return;
    const session = sessionRef.current;
    if (!session) return;

    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) session.redo();
      else session.undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'y') {
      event.preventDefault();
      session.redo();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      session.cancel();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (snapshot.selectionCount > 0) {
        event.preventDefault();
        session.deleteSelection();
      }
      return;
    }

    const tool = SHORTCUT_TO_TOOL.get(key);
    if (tool) {
      event.preventDefault();
      session.activateTool(tool);
    }
  };

  const style: AdvancedSketchStyle = snapshot.style;
  const isSurfaceTool = [
    ADVANCED_SKETCH_TOOLS.POLYGON,
    ADVANCED_SKETCH_TOOLS.RECTANGLE,
    ADVANCED_SKETCH_TOOLS.CIRCLE,
  ].includes(snapshot.tool);
  const isLineTool = [
    ADVANCED_SKETCH_TOOLS.POLYLINE,
    ADVANCED_SKETCH_TOOLS.FREEHAND,
    ADVANCED_SKETCH_TOOLS.POLYGON,
    ADVANCED_SKETCH_TOOLS.RECTANGLE,
    ADVANCED_SKETCH_TOOLS.CIRCLE,
  ].includes(snapshot.tool);

  return (
    <div
      className="advanced-sketch"
      onKeyDown={handleKeyboard}
      aria-busy={loading}
    >
      <div className="advanced-sketch__toolbar" role="toolbar" aria-label="Çizim araçları">
        {TOOL_DESCRIPTORS.map((descriptor) => (
          <button
            key={descriptor.tool}
            type="button"
            className="advanced-sketch__tool"
            data-active={snapshot.tool === descriptor.tool ? 'true' : 'false'}
            aria-pressed={snapshot.tool === descriptor.tool}
            onClick={() => activateTool(descriptor.tool)}
            disabled={loading || Boolean(initializationError)}
            title={`${descriptor.label} (${descriptor.shortcut})`}
          >
            <span className="advanced-sketch__tool-icon">{descriptor.icon}</span>
            <span>{descriptor.label}</span>
            <kbd aria-hidden="true">{descriptor.shortcut}</kbd>
          </button>
        ))}
      </div>

      <div className="advanced-sketch__history" aria-label="Çizim geçmişi ve temizleme işlemleri">
        <button
          type="button"
          onClick={() => sessionRef.current?.undo()}
          disabled={!snapshot.canUndo}
          aria-label="Son çizim adımını geri al"
        >
          <IoArrowUndoOutline aria-hidden="true" /> Geri al
        </button>
        <button
          type="button"
          onClick={() => sessionRef.current?.redo()}
          disabled={!snapshot.canRedo}
          aria-label="Çizim adımını yinele"
        >
          <IoArrowRedoOutline aria-hidden="true" /> Yinele
        </button>
        <button
          type="button"
          onClick={() => sessionRef.current?.deleteSelection()}
          disabled={snapshot.selectionCount === 0}
          aria-label="Seçili çizimi sil"
        >
          <AiOutlineDelete aria-hidden="true" /> Seçileni sil
        </button>
        <button
          type="button"
          onClick={() => sessionRef.current?.clear()}
          disabled={snapshot.graphicCount === 0}
          aria-label="Tüm kullanıcı çizimlerini temizle"
        >
          <AiOutlineClear aria-hidden="true" /> Tümünü temizle
        </button>
      </div>

      {loading ? (
        <div className="advanced-sketch__status" role="status">
          Çizim modülü yükleniyor…
        </div>
      ) : null}

      {initializationError ? (
        <div className="advanced-sketch__error" role="alert">
          <strong>Çizim araçları açılamadı.</strong>
          <span>{initializationError}</span>
        </div>
      ) : null}

      {!loading && !initializationError && snapshot.tool !== ADVANCED_SKETCH_TOOLS.SELECT ? (
        <fieldset className="advanced-sketch__options">
          <legend>Çizim stili</legend>

          {snapshot.tool === ADVANCED_SKETCH_TOOLS.POINT ? (
            <>
              <div className="advanced-sketch__field">
                <label htmlFor="advanced-sketch-point-style">Nokta stili</label>
                <select
                  id="advanced-sketch-point-style"
                  value={style.point.style}
                  onChange={(event) => updateStyle({
                    point: { style: event.target.value as AdvancedSketchStyle['point']['style'] },
                  })}
                >
                  <option value="circle">Daire</option>
                  <option value="cross">Artı</option>
                  <option value="diamond">Elmas</option>
                  <option value="square">Kare</option>
                  <option value="x">Çarpı</option>
                </select>
              </div>
              <div className="advanced-sketch__field">
                <label htmlFor="advanced-sketch-point-size">Nokta boyutu</label>
                <input
                  id="advanced-sketch-point-size"
                  type="range"
                  min={4}
                  max={32}
                  value={style.point.size}
                  onChange={(event) => updateStyle({
                    point: { size: Number(event.target.value) },
                  })}
                  aria-valuetext={`${style.point.size} piksel`}
                />
                <output htmlFor="advanced-sketch-point-size">{style.point.size}px</output>
              </div>
              <ColorPicker
                label="Nokta rengi"
                value={{ hex: style.point.color, alpha: 1 }}
                onChange={(value) => updateStyle({ point: { color: value.hex } })}
              />
            </>
          ) : null}

          {isLineTool ? (
            <>
              <div className="advanced-sketch__field">
                <label htmlFor="advanced-sketch-line-width">Çizgi kalınlığı</label>
                <input
                  id="advanced-sketch-line-width"
                  type="range"
                  min={1}
                  max={12}
                  value={style.line.width}
                  onChange={(event) => {
                    const width = Number(event.target.value);
                    updateStyle({
                      line: { width },
                      fill: { outlineWidth: width },
                    });
                  }}
                  aria-valuetext={`${style.line.width} piksel`}
                />
                <output htmlFor="advanced-sketch-line-width">{style.line.width}px</output>
              </div>
              <ColorPicker
                label="Çizgi rengi"
                value={{ hex: style.line.color, alpha: 1 }}
                onChange={(value) => updateStyle({
                  line: { color: value.hex },
                  fill: { outlineColor: value.hex },
                })}
              />
              <div className="advanced-sketch__field">
                <label htmlFor="advanced-sketch-line-style">Çizgi stili</label>
                <select
                  id="advanced-sketch-line-style"
                  value={style.line.style}
                  onChange={(event) => updateStyle({
                    line: { style: event.target.value as AdvancedSketchStyle['line']['style'] },
                    fill: { outlineStyle: event.target.value as AdvancedSketchStyle['line']['style'] },
                  })}
                >
                  <option value="solid">Düz</option>
                  <option value="dash">Kesik</option>
                  <option value="dash-dot">Kesik-nokta</option>
                  <option value="dot">Noktalı</option>
                  <option value="long-dash">Uzun kesik</option>
                  <option value="long-dash-dot">Uzun kesik-nokta</option>
                  <option value="short-dash">Kısa kesik</option>
                  <option value="short-dot">Kısa nokta</option>
                  <option value="none">Çizgi yok</option>
                </select>
              </div>
            </>
          ) : null}

          {isSurfaceTool ? (
            <>
              <ColorPicker
                label="Dolgu rengi"
                value={{ hex: style.fill.color, alpha: style.fill.opacity }}
                showAlpha
                onChange={(value) => updateStyle({
                  fill: { color: value.hex, opacity: value.alpha },
                })}
              />
              <div className="advanced-sketch__field">
                <label htmlFor="advanced-sketch-fill-style">Dolgu stili</label>
                <select
                  id="advanced-sketch-fill-style"
                  value={style.fill.style}
                  onChange={(event) => updateStyle({
                    fill: { style: event.target.value as AdvancedSketchStyle['fill']['style'] },
                  })}
                >
                  <option value="solid">Düz</option>
                  <option value="horizontal">Yatay</option>
                  <option value="vertical">Dikey</option>
                  <option value="cross">Çapraz</option>
                  <option value="forward-diagonal">İleri diyagonal</option>
                  <option value="backward-diagonal">Geri diyagonal</option>
                  <option value="diagonal-cross">Diyagonal çapraz</option>
                  <option value="none">Dolgu yok</option>
                </select>
              </div>
            </>
          ) : null}
        </fieldset>
      ) : null}

      <div
        className={snapshot.error ? 'advanced-sketch__status advanced-sketch__status--error' : 'advanced-sketch__status'}
        role={snapshot.error ? 'alert' : 'status'}
        aria-live={snapshot.error ? 'assertive' : 'polite'}
      >
        <span>{snapshot.error ?? snapshot.message}</span>
        <span className="advanced-sketch__counts">
          {snapshot.graphicCount} çizim
          {snapshot.selectionCount > 0 ? ` · ${snapshot.selectionCount} seçili` : ''}
        </span>
      </div>

      <p className="advanced-sketch__help">
        Kısayollar: V seçim, P nokta, L çizgi, F serbest, G poligon, R dikdörtgen,
        C daire, Esc iptal, Ctrl/⌘+Z geri al.
      </p>
    </div>
  );
};

export default AdvancedSketchWidgetMain;
