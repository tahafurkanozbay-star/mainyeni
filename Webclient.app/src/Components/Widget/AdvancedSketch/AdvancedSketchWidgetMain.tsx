import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { AiOutlineClear, AiOutlineRedo, AiOutlineUndo } from 'react-icons/ai';
import { BiRectangle, BiShapePolygon } from 'react-icons/bi';
import { BsCircle } from 'react-icons/bs';
import { GrCursor } from 'react-icons/gr';
import { HiOutlineArrowTrendingUp } from 'react-icons/hi2';
import { TbDownload, TbPoint, TbUpload } from 'react-icons/tb';
import MapManager from '../../../Store/Managers/MapManager';
import './AdvancedSketchWidgetMain.css';
import { createArcgisSketchAdapter } from './sketchArcgisAdapter';
import {
  announceSketchStatus,
  createSketchLiveRegion,
  describeSketchTool,
  sketchToolFromShortcut,
  shouldHandleSketchShortcut,
  SKETCH_TOOL_DESCRIPTORS,
} from './sketchAccessibilityRuntime';
import type {
  FillStyle,
  LineStyle,
  PointStyle,
  SketchSessionRuntime,
  SketchSessionSnapshot,
  SketchStyleState,
  SketchTool,
} from './sketchContracts';
import {
  downloadSketchDocument,
  parseSketchDocument,
} from './sketchDocumentRuntime';
import { createSketchSessionRuntime } from './sketchSessionRuntime';
import {
  DEFAULT_SKETCH_STYLE,
  withFillColor,
  withFillStyle,
  withLineColor,
  withLineStyle,
  withLineWidth,
  withPointStyle,
} from './sketchStyleRuntime';
import ColorPicker from './ColorPicker';

export interface AdvancedSketchWidgetMainProps {
  readonly active?: boolean;
}

const toolIcon = (tool: SketchTool): ReactNode => {
  if (tool === 'move') return <GrCursor aria-hidden="true" />;
  if (tool === 'point') return <TbPoint aria-hidden="true" />;
  if (tool === 'polyline' || tool === 'freehand') return <HiOutlineArrowTrendingUp aria-hidden="true" />;
  if (tool === 'polygon') return <BiShapePolygon aria-hidden="true" />;
  if (tool === 'rectangle') return <BiRectangle aria-hidden="true" />;
  if (tool === 'circle') return <BsCircle aria-hidden="true" />;
  if (tool === 'clear') return <AiOutlineClear aria-hidden="true" />;
  return <span aria-hidden="true">T</span>;
};

const LINE_TOOLS = new Set<SketchTool>(['polyline', 'freehand', 'polygon', 'rectangle', 'circle']);
const FILL_TOOLS = new Set<SketchTool>(['polygon', 'rectangle', 'circle']);

const asLineStyle = (value: string): LineStyle => value as LineStyle;
const asFillStyle = (value: string): FillStyle => value as FillStyle;
const asPointStyle = (value: string): PointStyle => value as PointStyle;

export const AdvancedSketchWidgetMain = ({
  active = true,
}: AdvancedSketchWidgetMainProps) => {
  const runtimeRef = useRef<SketchSessionRuntime | null>(null);
  const liveRegionRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [style, setStyle] = useState<SketchStyleState>(DEFAULT_SKETCH_STYLE);
  const [snapshot, setSnapshot] = useState<SketchSessionSnapshot | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importWarnings, setImportWarnings] = useState<readonly string[]>(Object.freeze([]));

  const publishSnapshot = useCallback((next: SketchSessionSnapshot): void => {
    setSnapshot(next);
  }, []);

  useEffect(() => {
    let disposed = false;
    liveRegionRef.current = createSketchLiveRegion();

    const initialize = async (): Promise<void> => {
      try {
        const view = MapManager.GetMapView();
        if (!view) throw new Error('Harita görünümü henüz hazır değil.');

        const adapterHandle = await createArcgisSketchAdapter(view, {
          layerId: 'advanced-sketch-runtime',
          onGraphicCreated: (graphic) => {
            if (disposed) return;
            try {
              const next = runtimeRef.current?.observeGraphic(graphic, 'Draw graphic');
              if (next) {
                publishSnapshot(next);
                announceSketchStatus(liveRegionRef.current, 'Çizim haritaya eklendi.');
              }
            } catch (observeError) {
              const message = observeError instanceof Error ? observeError.message : String(observeError);
              setError(message);
            }
          },
          onGraphicsUpdated: (graphics) => {
            if (disposed) return;
            try {
              const next = runtimeRef.current?.observeGraphics(graphics, 'Update graphic');
              if (next) {
                publishSnapshot(next);
                announceSketchStatus(liveRegionRef.current, 'Çizim güncellendi.');
              }
            } catch (observeError) {
              const message = observeError instanceof Error ? observeError.message : String(observeError);
              setError(message);
            }
          },
        });

        if (disposed) {
          await adapterHandle.destroy();
          return;
        }

        const runtime = createSketchSessionRuntime(adapterHandle.adapter, {
          initialStyle: style,
          budget: {
            maxGraphics: 2_000,
            maxHistoryEntries: 96,
            maxQueuedOperations: 32,
            operationTimeoutMs: 15_000,
          },
        });
        runtimeRef.current = runtime;
        publishSnapshot(runtime.snapshot());
        setInitializing(false);
        setError(null);
        announceSketchStatus(liveRegionRef.current, 'Gelişmiş çizim araçları hazır.');
      } catch (initializeError) {
        if (disposed) return;
        const message = initializeError instanceof Error ? initializeError.message : String(initializeError);
        setError(message);
        setInitializing(false);
        announceSketchStatus(liveRegionRef.current, `Çizim araçları başlatılamadı: ${message}`, true);
      }
    };

    void initialize();

    return () => {
      disposed = true;
      const runtime = runtimeRef.current;
      runtimeRef.current = null;
      if (runtime) {
        void runtime.dispose().catch((disposeError: unknown) => {
          globalThis.reportError?.(disposeError);
        });
      }
    };
  }, [publishSnapshot]);

  useEffect(() => {
    if (active) return;
    const runtime = runtimeRef.current;
    if (!runtime) return;
    void runtime.selectTool('move').then(publishSnapshot).catch((toolError: unknown) => {
      globalThis.reportError?.(toolError);
    });
  }, [active, publishSnapshot]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!active || !shouldHandleSketchShortcut(event)) return;
      const tool = sketchToolFromShortcut(event);
      if (!tool) return;
      event.preventDefault();
      const runtime = runtimeRef.current;
      if (!runtime) return;
      void runtime.selectTool(tool).then((next) => {
        publishSnapshot(next);
        announceSketchStatus(liveRegionRef.current, `${describeSketchTool(next.selectedTool).label} aracı seçildi.`);
      }).catch((toolError: unknown) => {
        const message = toolError instanceof Error ? toolError.message : String(toolError);
        setError(message);
      });
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active, publishSnapshot]);

  const selectTool = useCallback(async (tool: SketchTool): Promise<void> => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      const next = await runtime.selectTool(tool);
      publishSnapshot(next);
      setError(null);
      announceSketchStatus(liveRegionRef.current, `${describeSketchTool(next.selectedTool).label} aracı seçildi.`);
    } catch (toolError) {
      const message = toolError instanceof Error ? toolError.message : String(toolError);
      setError(message);
      announceSketchStatus(liveRegionRef.current, message, true);
    }
  }, [publishSnapshot]);

  const updateStyle = useCallback(async (nextStyle: SketchStyleState): Promise<void> => {
    setStyle(nextStyle);
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      const current = runtime.setStyle(nextStyle);
      publishSnapshot(current);
      if (current.selectedTool !== 'move' && current.selectedTool !== 'clear') {
        publishSnapshot(await runtime.selectTool(current.selectedTool));
      }
    } catch (styleError) {
      const message = styleError instanceof Error ? styleError.message : String(styleError);
      setError(message);
    }
  }, [publishSnapshot]);

  const undo = useCallback(async (): Promise<void> => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      const next = await runtime.undo();
      publishSnapshot(next);
      announceSketchStatus(liveRegionRef.current, 'Son çizim değişikliği geri alındı.');
    } catch (undoError) {
      setError(undoError instanceof Error ? undoError.message : String(undoError));
    }
  }, [publishSnapshot]);

  const redo = useCallback(async (): Promise<void> => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      const next = await runtime.redo();
      publishSnapshot(next);
      announceSketchStatus(liveRegionRef.current, 'Çizim değişikliği yeniden uygulandı.');
    } catch (redoError) {
      setError(redoError instanceof Error ? redoError.message : String(redoError));
    }
  }, [publishSnapshot]);

  const exportDocument = useCallback((): void => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      const sketchDocument = runtime.exportDocument('Kent Rehberi çizimi');
      downloadSketchDocument(sketchDocument, 'kent-rehberi-cizim.json');
      announceSketchStatus(liveRegionRef.current, 'Çizim dosyası dışa aktarıldı.');
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    }
  }, []);

  const importDocument = useCallback(async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const [file] = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!file) return;
    try {
      const parsed = parseSketchDocument(await file.text());
      setImportWarnings(parsed.warnings);
      if (!parsed.document) {
        throw new Error(parsed.errors.join(' ') || 'Çizim dosyası doğrulanamadı.');
      }
      const runtime = runtimeRef.current;
      if (!runtime) throw new Error('Çizim runtime hazır değil.');
      const next = await runtime.importDocument(parsed.document);
      setStyle(parsed.document.style);
      publishSnapshot(next);
      announceSketchStatus(
        liveRegionRef.current,
        `${parsed.document.graphics.length} çizim içe aktarıldı.`,
      );
    } catch (importError) {
      const message = importError instanceof Error ? importError.message : String(importError);
      setError(message);
      announceSketchStatus(liveRegionRef.current, message, true);
    }
  }, [publishSnapshot]);

  const selectedTool = snapshot?.selectedTool ?? 'move';
  const disabled = initializing || !snapshot || snapshot.state === 'disposed';
  const supportsLine = LINE_TOOLS.has(selectedTool);
  const supportsFill = FILL_TOOLS.has(selectedTool);
  const history = snapshot?.history;

  return (
    <div className="advanced-sketch" aria-busy={initializing}>
      <div className="advanced-sketch-toolbar" role="toolbar" aria-label="Çizim araçları">
        {SKETCH_TOOL_DESCRIPTORS.filter((descriptor) => descriptor.tool !== 'text').map((descriptor) => (
          <button
            key={descriptor.tool}
            type="button"
            className={`advanced-sketch-tool${selectedTool === descriptor.tool ? ' is-active' : ''}`}
            onClick={() => void selectTool(descriptor.tool)}
            disabled={disabled}
            aria-pressed={selectedTool === descriptor.tool}
            aria-label={descriptor.description}
            title={descriptor.shortcut ? `${descriptor.label} (${descriptor.shortcut})` : descriptor.label}
          >
            <span className="advanced-sketch-tool-icon">{toolIcon(descriptor.tool)}</span>
            <span>{descriptor.label}</span>
          </button>
        ))}
      </div>

      <div className="advanced-sketch-actions" aria-label="Çizim geçmişi ve dosya işlemleri">
        <button type="button" onClick={() => void undo()} disabled={disabled || !history?.canUndo}>
          <AiOutlineUndo aria-hidden="true" /> Geri al
        </button>
        <button type="button" onClick={() => void redo()} disabled={disabled || !history?.canRedo}>
          <AiOutlineRedo aria-hidden="true" /> Yinele
        </button>
        <button type="button" onClick={exportDocument} disabled={disabled}>
          <TbDownload aria-hidden="true" /> Dışa aktar
        </button>
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={disabled}>
          <TbUpload aria-hidden="true" /> İçe aktar
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="visually-hidden"
          accept="application/json,.json"
          onChange={(event) => void importDocument(event)}
          aria-label="Çizim dosyası seç"
        />
      </div>

      {selectedTool === 'point' ? (
        <fieldset className="advanced-sketch-options">
          <legend>Nokta görünümü</legend>
          <label>
            Nokta stili
            <select
              value={style.point.style}
              onChange={(event) => void updateStyle(withPointStyle(style, asPointStyle(event.target.value)))}
              disabled={disabled}
            >
              <option value="circle">Daire</option>
              <option value="cross">Çarpı</option>
              <option value="diamond">Elmas</option>
              <option value="square">Kare</option>
            </select>
          </label>
        </fieldset>
      ) : null}

      {supportsLine ? (
        <fieldset className="advanced-sketch-options">
          <legend>Çizgi ve kenarlık</legend>
          <label>
            Kalınlık
            <select
              value={style.line.width}
              onChange={(event) => void updateStyle(withLineWidth(style, Number(event.target.value)))}
              disabled={disabled}
            >
              {[1, 2, 3, 4, 5, 6, 8, 10].map((weight) => (
                <option key={weight} value={weight}>{weight}</option>
              ))}
            </select>
          </label>
          <label>
            Stil
            <select
              value={style.line.style}
              onChange={(event) => void updateStyle(withLineStyle(style, asLineStyle(event.target.value)))}
              disabled={disabled}
            >
              <option value="solid">Normal</option>
              <option value="dash">Kesik</option>
              <option value="dash-dot">Kesik-nokta</option>
              <option value="dot">Nokta</option>
              <option value="long-dash">Uzun kesik</option>
              <option value="short-dash">Kısa kesik</option>
              <option value="none">Gizli</option>
            </select>
          </label>
          <div className="advanced-sketch-option-row">
            <span>Renk</span>
            <ColorPicker
              value={style.line.color}
              label="Çizgi rengi seç"
              onChange={(color) => void updateStyle(withLineColor(style, color.hex))}
              disabled={disabled}
            />
          </div>
        </fieldset>
      ) : null}

      {supportsFill ? (
        <fieldset className="advanced-sketch-options">
          <legend>Alan dolgusu</legend>
          <label>
            Dolgu stili
            <select
              value={style.polygon.style}
              onChange={(event) => void updateStyle(withFillStyle(style, asFillStyle(event.target.value)))}
              disabled={disabled}
            >
              <option value="solid">Düz</option>
              <option value="horizontal">Yatay</option>
              <option value="vertical">Dikey</option>
              <option value="cross">Çapraz</option>
              <option value="forward-diagonal">İleri diyagonal</option>
              <option value="backward-diagonal">Geri diyagonal</option>
              <option value="diagonal-cross">Diyagonal çapraz</option>
              <option value="none">Yok</option>
            </select>
          </label>
          <div className="advanced-sketch-option-row">
            <span>Dolgu rengi</span>
            <ColorPicker
              value={style.polygon.color}
              label="Dolgu rengi seç"
              onChange={(color) => void updateStyle(withFillColor(style, color.hex))}
              disabled={disabled}
            />
          </div>
        </fieldset>
      ) : null}

      <div className="advanced-sketch-status" role="status" aria-live="polite">
        {initializing ? 'Çizim araçları hazırlanıyor…' : null}
        {!initializing && snapshot ? (
          <>
            <strong>{describeSketchTool(selectedTool).label}</strong>
            <span>{snapshot.graphicsCount} çizim</span>
            <span>{history?.size ?? 0} geçmiş kaydı</span>
          </>
        ) : null}
      </div>

      {importWarnings.length > 0 ? (
        <div className="alert alert-warning" role="status">
          {importWarnings.join(' ')}
        </div>
      ) : null}

      {error ? (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
};

export default AdvancedSketchWidgetMain;
