import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ChangeEvent,
  type Ref,
} from 'react';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import { NumberingQueryBusiness } from '../../../Business/NumberingQueryBusiness';
import { Constants_MessageType } from '../../../Core/Constants';
import MapManager from '../../../Store/Managers/MapManager';
import { DebugHelper } from '../../../Toolbox/DebugHelper';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import {
  ExperienceInput,
  ExperienceSelect,
} from '../../Common/ExperienceForm';
import { ExperienceStatus } from '../../Common/ExperienceStatus';
import { SharedGISIcon } from '../../Common/SharedGISIcon';
import {
  CommonQueryWindowTools,
  type QueryWindowManagerLike,
} from '../_Common/CommonQueryWindowTools';
import {
  normalizeErrorMessage,
  safeClientLog,
} from '../_Common/QueryInteractionRuntime';
import {
  NUMBERING_LEVELS_V11,
  normalizeNumberingOptionsV11,
  numberingPathLabelV11,
  readNumberingOptionV11,
  type NumberingLevelV11,
  type NumberingPathV11,
  type NumberingRuntimeEffectsV11,
  type NumberingTransportV11,
} from './NumberingQueryContractsV11';
import {
  auditNumberingSnapshotV11,
} from './NumberingQueryAuditV11';
import {
  createNumberingWorkspacePresentationV11,
  numberingFilterDisabledV11,
  numberingSelectionValueV11,
  numberingStepDisabledV11,
} from './NumberingQueryPresentationV11';
import {
  createNumberingQueryRuntimeV11,
} from './NumberingQueryRuntimeV11';
import './NumberingQueryWindow.css';

type UnknownRecord = Record<string, unknown>;

export interface NumberingFeature {
  readonly attr?: UnknownRecord | null;
  readonly geometry?: unknown;
}

export interface NumberingQueryState {
  readonly district: string;
  readonly districtName: string;
  readonly nbhood: string;
  readonly nbhoodName: string;
  readonly street: string;
  readonly streetName: string;
  readonly door: string;
}

export interface NumberingWindowHandle {
  readonly id: string;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly OnShow: () => void;
  readonly OnClose: () => void;
}

export interface NumberingWindowManager extends QueryWindowManagerLike {
  RegisterWindow(ref: Ref<NumberingWindowHandle>): void;
  IsVisible(id: string): boolean;
  ShowWindow(id: string): void;
}

export interface NumberingQueryWindowProps {
  readonly id: string;
  readonly windowManager: NumberingWindowManager;
}

const INITIAL_QUERY: NumberingQueryState = Object.freeze({
  district: '',
  districtName: '',
  nbhood: '',
  nbhoodName: '',
  street: '',
  streetName: '',
  door: '',
});

export const createInitialNumberingQuery = (): NumberingQueryState => ({
  ...INITIAL_QUERY,
});

export const readNumberingOption = (
  item: NumberingFeature,
  valueKey: string,
  labelKey: string,
): Readonly<{ value: string; label: string }> | null => {
  const option = readNumberingOptionV11(item, valueKey, labelKey, 0);
  return option
    ? Object.freeze({ value: option.value, label: option.label })
    : null;
};

export const normalizeNumberingOptions = (
  items: readonly NumberingFeature[] | null | undefined,
  valueKey: string,
  labelKey: string,
): readonly Readonly<{ value: string; label: string }>[] =>
  Object.freeze(normalizeNumberingOptionsV11(items, {
    valueKey,
    labelKey,
    maxOptions: 100_000,
  }).options.map(option => Object.freeze({
    value: option.value,
    label: option.label,
  })));

const transportAdapter = (): NumberingTransportV11 => Object.freeze({
  loadDistricts: () => NumberingQueryBusiness.GetDistricts(),
  loadDistrict: districtId => NumberingQueryBusiness.GetDistrictById(districtId),
  loadNeighborhoods: districtId => NumberingQueryBusiness.GetNeighborhoodsOfDistrict(districtId),
  loadNeighborhood: neighborhoodId => NumberingQueryBusiness.GetNeighborhoodById(neighborhoodId),
  loadStreets: neighborhoodId => NumberingQueryBusiness.GetStreets(neighborhoodId),
  loadStreetGeometries: streetId => NumberingQueryBusiness.GetStreetCenterLines(streetId),
  loadDoors: streetId => NumberingQueryBusiness.GetDoors(streetId),
  loadDoor: doorId => NumberingQueryBusiness.GetDoorById(doorId),
});

const pathForLog = (path: NumberingPathV11): string =>
  numberingPathLabelV11(path) || 'Adres seçimi';

interface LevelControlProps {
  readonly id: string;
  readonly level: NumberingLevelV11;
  readonly snapshot: ReturnType<ReturnType<typeof createNumberingQueryRuntimeV11>['snapshot']>;
  readonly onFilter: (level: NumberingLevelV11, value: string) => void;
  readonly onSelect: (level: NumberingLevelV11, value: string) => void;
}

const NumberingLevelControl = ({
  id,
  level,
  snapshot,
  onFilter,
  onSelect,
}: LevelControlProps): React.ReactElement => {
  const workspace = createNumberingWorkspacePresentationV11(snapshot);
  const step = workspace.steps.find(item => item.level === level);
  const state = snapshot.levels[level];
  const selectedValue = numberingSelectionValueV11(snapshot, level);
  const selectedIsVisible = state.options.some(option => option.value === selectedValue);
  const inputId = `${id}-${level}-filter`;
  const selectId = `${id}-${level}`;
  const descriptionId = `${id}-${step?.describedByIdSuffix ?? `${level}-description`}`;
  const showFilter = state.optionCount > 12 || Boolean(state.filter);

  return (
    <div
      className={[
        'numbering-v11-step',
        step?.complete ? 'is-complete' : '',
        step?.busy ? 'is-busy' : '',
        state.error ? 'has-error' : '',
      ].filter(Boolean).join(' ')}
      data-level={level}
    >
      <div className="numbering-v11-step__heading">
        <span className="numbering-v11-step__index" aria-hidden="true">{step?.ordinal ?? 1}</span>
        <div>
          <h3>{step?.label}</h3>
          <p id={descriptionId}>{step?.optionSummary}</p>
        </div>
      </div>

      {showFilter ? (
        <ExperienceInput
          id={inputId}
          label={step?.filterLabel ?? 'Listede filtrele'}
          value={state.filter}
          onChange={(event) => onFilter(level, event.target.value)}
          placeholder={step?.filterPlaceholder}
          disabled={numberingFilterDisabledV11(snapshot, level)}
          autoComplete="off"
          inputMode={level === 'door' ? 'numeric' : 'search'}
          aria-describedby={descriptionId}
        />
      ) : null}

      <ExperienceSelect
        id={selectId}
        label={step?.label ?? level}
        value={selectedValue}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => onSelect(level, event.target.value)}
        disabled={numberingStepDisabledV11(snapshot, level)}
        hint={step?.selectHint}
        error={state.error || undefined}
        aria-describedby={descriptionId}
      >
        <option value="">Seçiniz…</option>
        {!selectedIsVisible && state.selected ? (
          <option value={state.selected.value}>{state.selected.label}</option>
        ) : null}
        {state.options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </ExperienceSelect>

      {state.truncated ? (
        <p className="numbering-v11-step__bounded-note">
          Performans için görünür seçenekler sınırlandı. Filtre alanı tüm yüklenmiş kayıtlar üzerinde çalışır.
        </p>
      ) : null}
    </div>
  );
};

export const NumberingQueryWindow = forwardRef<
  NumberingWindowHandle,
  NumberingQueryWindowProps
>(({ id, windowManager }, ref) => {
  const mapViewRef = useRef<unknown>(null);
  const highlightGraphicRef = useRef<readonly unknown[] | null>(null);
  const focusSequenceRef = useRef(0);

  const clearHighlight = useCallback((): void => {
    if (highlightGraphicRef.current && mapViewRef.current) {
      GisGraphicsHelper.RemoveGraphics(
        mapViewRef.current,
        highlightGraphicRef.current,
      );
    }
    highlightGraphicRef.current = null;
  }, []);

  const reportError = useCallback((error: unknown, fallback: string): void => {
    const message = normalizeErrorMessage(error, fallback);
    DebugHelper.Log(error);
    windowManager.ShowMessage(Constants_MessageType.Error, message);
  }, [windowManager]);

  const transport = useMemo<NumberingTransportV11>(() => transportAdapter(), []);

  const effects = useMemo<NumberingRuntimeEffectsV11>(() => Object.freeze({
    focusGeometries: async (geometries, context) => {
      const mapView = mapViewRef.current;
      if (!mapView || geometries.length === 0) return;
      focusSequenceRef.current = context.sequence;
      const expectedSequence = context.sequence;
      const projected = (await Promise.all(
        geometries.map(geometry => GisGraphicsHelper.ProjectGeometry(geometry, '4326')),
      )).filter(Boolean);
      if (focusSequenceRef.current !== expectedSequence || projected.length === 0) return;

      clearHighlight();
      await Promise.resolve(
        GisGraphicsHelper.ZoomToGeometry(mapView, projected, context.zoomLevel),
      );
      if (focusSequenceRef.current !== expectedSequence) return;

      const graphics = (await Promise.all(
        projected.map(geometry => GisGraphicsHelper.CreateGraphicFromGeometry(geometry)),
      )).filter(Boolean);
      if (focusSequenceRef.current !== expectedSequence) return;

      highlightGraphicRef.current = graphics;
      GisGraphicsHelper.AddGraphics(mapView, graphics);
    },
    logSelection: async path => {
      await safeClientLog(
        LoggingBusiness,
        'Numarataj/Sorgu',
        pathForLog(path),
        DebugHelper.Log,
      );
    },
    reportError: (error, context) => {
      reportError(error, context.fallback);
    },
    reportObserverError: DebugHelper.Log,
  }), [clearHighlight, reportError]);

  const runtime = useMemo(() => createNumberingQueryRuntimeV11(
    transport,
    effects,
    {
      maxOptionsPerLevel: 25_000,
      maxVisibleOptions: 240,
      maxFilterLength: 120,
      maxHistory: 96,
      maxObservers: 16,
      minimumFilterLengthForOverflow: 2,
    },
  ), [effects, transport]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => runtime.subscribe(onStoreChange),
    [runtime],
  );
  const getSnapshot = useCallback(() => runtime.snapshot(), [runtime]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const presentation = useMemo(
    () => createNumberingWorkspacePresentationV11(snapshot),
    [snapshot],
  );
  const audit = useMemo(() => auditNumberingSnapshotV11(snapshot), [snapshot]);

  const resetWindow = useCallback((): void => {
    focusSequenceRef.current += 1;
    runtime.reset();
    clearHighlight();
  }, [clearHighlight, runtime]);

  useImperativeHandle(ref, () => ({
    id,
    visible: false,
    minimized: false,
    OnShow: () => windowManager.ShowWindow('sidebar'),
    OnClose: resetWindow,
  }), [id, resetWindow, windowManager]);

  useEffect(() => {
    windowManager.RegisterWindow(ref);
    mapViewRef.current = MapManager.GetMapView();
    void runtime.initialize().catch(error => {
      reportError(error, 'Adres arama başlatılamadı.');
    });

    return () => {
      focusSequenceRef.current += 1;
      runtime.dispose();
      clearHighlight();
      mapViewRef.current = null;
    };
  }, [clearHighlight, ref, reportError, runtime, windowManager]);

  const handleFilter = useCallback((level: NumberingLevelV11, value: string): void => {
    runtime.setFilter(level, value);
  }, [runtime]);

  const handleSelect = useCallback((level: NumberingLevelV11, value: string): void => {
    focusSequenceRef.current += 1;
    clearHighlight();
    void runtime.select(level, value).catch(error => {
      reportError(error, 'Adres seçimi işlenemedi.');
    });
  }, [clearHighlight, reportError, runtime]);

  const visible = windowManager.IsVisible(id);

  return (
    <section
      className="common-query-window common-query-window-right numbering-v11"
      aria-labelledby={id + '-title'}
      aria-describedby={id + '-description'}
      aria-busy={snapshot.busy}
      aria-hidden={!visible}
      style={{ visibility: visible ? 'visible' : 'hidden' }}
      data-numbering-audit={audit.valid ? 'valid' : 'invalid'}
    >
      <header className="common-query-window-header numbering-v11__header">
        <SharedGISIcon
          record={{ type: 'adres', category: 'Adres Arama', title: 'Adres Arama' }}
          size={34}
          className="common-query-window-header-icon"
        />
        <div className="numbering-v11__title-group">
          <h2 id={id + '-title'}>{presentation.heading}</h2>
          <p id={id + '-description'}>{presentation.description}</p>
        </div>
        <CommonQueryWindowTools
          windowManager={windowManager}
          windowId={id}
          showNearbySearch={false}
          showMapSelect={false}
        />
      </header>

      <div className="common-query-window-body numbering-v11__body">
        <div className="numbering-v11__summary" aria-label="Adres seçim özeti">
          <div>
            <span className="numbering-v11__eyebrow">Seçili adres</span>
            <strong>{presentation.pathLabel || presentation.pathFallback}</strong>
          </div>
          <button
            type="button"
            className="numbering-v11__reset"
            onClick={resetWindow}
            disabled={!snapshot.canReset || snapshot.busy}
          >
            Temizle
          </button>
        </div>

        <div className="numbering-v11__progress" aria-label={presentation.progressLabel}>
          {NUMBERING_LEVELS_V11.map(level => {
            const step = presentation.steps.find(item => item.level === level);
            return (
              <span
                key={level}
                className={step?.complete ? 'is-complete' : step?.busy ? 'is-active' : ''}
                aria-hidden="true"
              />
            );
          })}
        </div>

        <p className="numbering-v11__progress-copy">{presentation.progressLabel}</p>

        <div className="numbering-v11__live" aria-live="polite" aria-atomic="true">
          {presentation.liveStatus}
        </div>

        {!audit.valid ? (
          <ExperienceStatus tone="danger" live="assertive">
            Adres arama durumu bütünlük kontrolünden geçemedi. Lütfen seçimi temizleyip yeniden deneyin.
          </ExperienceStatus>
        ) : null}

        <form
          className="numbering-v11__form"
          aria-label="Adres bileşenleri"
          onSubmit={event => event.preventDefault()}
        >
          {NUMBERING_LEVELS_V11.map(level => (
            <NumberingLevelControl
              key={level}
              id={id}
              level={level}
              snapshot={snapshot}
              onFilter={handleFilter}
              onSelect={handleSelect}
            />
          ))}
        </form>

        {snapshot.complete ? (
          <ExperienceStatus tone="success" live="polite">
            {presentation.completionLabel}
          </ExperienceStatus>
        ) : null}
      </div>
    </section>
  );
});

NumberingQueryWindow.displayName = 'NumberingQueryWindow';
