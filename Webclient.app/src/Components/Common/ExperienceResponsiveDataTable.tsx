import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  createResponsiveDataTableProjectionModel,
  type ResponsiveDataTableColumnDefinition,
  type ResponsiveDataTableDensity,
  type ResponsiveDataTableProjectionModel,
  type ResponsiveDataTableProjectionSnapshot,
} from '../../experience/responsiveDataTableProjection';
import { createResponsiveDataTableRuntime } from '../../experience/responsiveDataTableRuntime';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import {
  ExperienceDataTable,
  type ExperienceDataColumn,
  type ExperienceDataTableProps,
} from './ExperienceDataTable';
import './experience-responsive-data-table.css';

export interface ExperienceResponsiveDataColumn<Row> extends ExperienceDataColumn<Row> {
  readonly priority?: number;
  readonly essential?: boolean;
  readonly hideOnPhone?: boolean;
  readonly minimumWidth?: number;
  readonly preferredWidth?: number;
}

export type ExperienceResponsiveDataTableProps<Row> = Omit<
  ExperienceDataTableProps<Row>,
  'columns' | 'stackOnCompact'
> & Readonly<{
  columns: readonly ExperienceResponsiveDataColumn<Row>[];
  allowColumnChooser?: boolean;
  allowDensityControl?: boolean;
  initialDensity?: ResponsiveDataTableDensity;
  stackOnCompact?: boolean;
  projectionStatusLabel?: string;
}>;

const DEFAULT_CONTAINER_WIDTH = 1024;

const initialEnvironment = () => ({
  containerWidth: typeof window === 'undefined' ? DEFAULT_CONTAINER_WIDTH : Math.max(320, window.innerWidth),
  viewportWidth: typeof window === 'undefined' ? DEFAULT_CONTAINER_WIDTH : Math.max(320, window.innerWidth),
  coarsePointer: typeof window === 'undefined' ? false : window.matchMedia?.('(pointer: coarse)').matches === true,
  reducedMotion: typeof window === 'undefined' ? false : window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  forcedColors: typeof window === 'undefined' ? false : window.matchMedia?.('(forced-colors: active)').matches === true,
});

const projectionColumns = <Row,>(
  columns: readonly ExperienceResponsiveDataColumn<Row>[],
): readonly ResponsiveDataTableColumnDefinition[] => Object.freeze(columns.map((column, index) => {
  const definition: ResponsiveDataTableColumnDefinition = {
    id: column.id,
    label: typeof column.header === 'string' ? column.header : column.id,
    priority: column.priority ?? index,
    essential: column.essential === true,
    hideOnPhone: column.hideOnPhone === true,
    ...(column.minimumWidth === undefined ? {} : { minimumWidth: column.minimumWidth }),
    ...(column.preferredWidth === undefined ? {} : { preferredWidth: column.preferredWidth }),
    ...(column.align === undefined ? {} : { align: column.align }),
  };
  return Object.freeze(definition);
}));

const projectionSchemaKey = (
  columns: readonly ResponsiveDataTableColumnDefinition[],
): string => JSON.stringify(columns.map((column) => [
  column.id,
  column.label,
  column.priority ?? null,
  column.essential === true,
  column.hideOnPhone === true,
  column.minimumWidth ?? null,
  column.preferredWidth ?? null,
  column.align ?? 'start',
]));

const useStableProjectionColumns = <Row,>(
  columns: readonly ExperienceResponsiveDataColumn<Row>[],
): readonly ResponsiveDataTableColumnDefinition[] => {
  const projected = projectionColumns(columns);
  const schemaKey = projectionSchemaKey(projected);
  const cacheRef = useRef<{
    readonly key: string;
    readonly columns: readonly ResponsiveDataTableColumnDefinition[];
  } | null>(null);

  if (cacheRef.current === null || cacheRef.current.key !== schemaKey) {
    cacheRef.current = Object.freeze({ key: schemaKey, columns: projected });
  }

  return cacheRef.current.columns;
};

const toPixelWidth = (value: number): string => `${Math.max(88, Math.round(value))}px`;

const createProjectionModel = (
  columns: readonly ResponsiveDataTableColumnDefinition[],
  initialDensity: ResponsiveDataTableDensity,
): ResponsiveDataTableProjectionModel => createResponsiveDataTableProjectionModel({
  columns,
  initialEnvironment: initialEnvironment(),
  initialDensity,
  maxObservers: 24,
});

const describeHiddenColumns = (
  snapshot: ResponsiveDataTableProjectionSnapshot,
  columns: readonly ResponsiveDataTableColumnDefinition[],
): string => {
  if (snapshot.hiddenColumnIds.length === 0) return 'Tüm sütunlar görünür.';
  const labelById = new Map(columns.map((column) => [column.id, column.label]));
  const labels = snapshot.hiddenColumnIds
    .map((id) => labelById.get(id) ?? id)
    .slice(0, 8);
  const remainder = snapshot.hiddenColumnIds.length - labels.length;
  return `Gizli sütunlar: ${labels.join(', ')}${remainder > 0 ? ` ve ${remainder} sütun daha` : ''}.`;
};

export function ExperienceResponsiveDataTable<Row>({
  columns,
  allowColumnChooser = true,
  allowDensityControl = true,
  initialDensity = 'comfortable',
  stackOnCompact = false,
  projectionStatusLabel = 'Tablo görünümü',
  className = '',
  ...tableProps
}: ExperienceResponsiveDataTableProps<Row>): ReactNode {
  const rootRef = useRef<HTMLElement | null>(null);
  const definitionColumns = useStableProjectionColumns(columns);
  const model = useMemo(
    () => createProjectionModel(definitionColumns, initialDensity),
    [definitionColumns, initialDensity],
  );

  const subscribe = useCallback((notify: () => void): (() => void) => (
    model.subscribe(() => notify())
  ), [model]);
  const snapshot = useSyncExternalStore(subscribe, model.getSnapshot, model.getSnapshot);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const runtime = createResponsiveDataTableRuntime({
      target: root,
      onEnvironment(environment) {
        model.setEnvironment(environment);
      },
    });
    model.setEnvironment(runtime.snapshot());
    return () => runtime.dispose();
  }, [model]);

  useEffect(() => () => {
    const diagnostics = model.getDiagnostics();
    if (diagnostics.failureCount > 0 || diagnostics.rejectedObserverCount > 0) {
      runtimeDiagnostics.record('experience.responsive-data-table.observer-diagnostics', {
        revision: diagnostics.revision,
        failureCount: diagnostics.failureCount,
        rejectedObserverCount: diagnostics.rejectedObserverCount,
      });
    }
    model.dispose();
  }, [model]);

  const projectedColumns = useMemo<readonly ExperienceDataColumn<Row>[]>(() => {
    const sourceById = new Map(columns.map((column) => [column.id, column]));
    return Object.freeze(snapshot.visibleColumns.flatMap((projected) => {
      const source = sourceById.get(projected.id);
      if (!source) return [];
      const projectedColumn: ExperienceDataColumn<Row> = {
        id: source.id,
        header: source.header,
        cell: source.cell,
        align: source.align ?? projected.align,
        width: toPixelWidth(projected.width),
        ...(source.sortDirection === undefined ? {} : { sortDirection: source.sortDirection }),
        ...(source.onSort === undefined ? {} : { onSort: source.onSort }),
      };
      return [Object.freeze(projectedColumn)];
    }));
  }, [columns, snapshot.visibleColumns]);

  const status = useMemo(() => (
    `${snapshot.announcement} ${describeHiddenColumns(snapshot, definitionColumns)}`
  ), [definitionColumns, snapshot]);
  const announceProjection = tableProps.busy !== true && tableProps.rows.length > 0;

  return (
    <section
      ref={rootRef}
      className={`experience-responsive-table ${className}`.trim()}
      data-viewport={snapshot.viewport}
      data-density={snapshot.density}
      data-coarse-pointer={snapshot.coarsePointer ? 'true' : 'false'}
      data-reduced-motion={snapshot.reducedMotion ? 'true' : 'false'}
      data-forced-colors={snapshot.forcedColors ? 'true' : 'false'}
      style={{ '--experience-responsive-table-touch-target': `${snapshot.touchTargetPx}px` } as CSSProperties}
    >
      {(allowColumnChooser || allowDensityControl) ? (
        <div className="experience-responsive-table__toolbar" aria-label="Tablo görünüm araçları">
          {allowDensityControl ? (
            <div className="experience-responsive-table__density" role="group" aria-label="Satır yoğunluğu">
              <span className="experience-responsive-table__toolbar-label">Yoğunluk</span>
              <button type="button" className="experience-responsive-table__segment" aria-pressed={snapshot.density === 'comfortable'} onClick={() => model.setDensity('comfortable')}>Rahat</button>
              <button type="button" className="experience-responsive-table__segment" aria-pressed={snapshot.density === 'compact'} onClick={() => model.setDensity('compact')}>Sıkı</button>
            </div>
          ) : null}

          {allowColumnChooser ? (
            <details className="experience-responsive-table__columns">
              <summary>Sütunlar</summary>
              <div className="experience-responsive-table__column-menu" role="group" aria-label="Görünür sütunlar">
                {definitionColumns.map((column) => {
                  const hiddenByUser = snapshot.userHiddenColumnIds.includes(column.id);
                  const automaticallyHidden = snapshot.automaticHiddenColumnIds.includes(column.id);
                  return (
                    <label key={column.id} className="experience-responsive-table__column-option">
                      <input type="checkbox" checked={!hiddenByUser} disabled={column.essential === true} onChange={(event) => model.setColumnHidden(column.id, !event.currentTarget.checked)} />
                      <span>{column.label}</span>
                      {column.essential ? <em>Zorunlu</em> : automaticallyHidden ? <em>Dar görünümde gizli</em> : null}
                    </label>
                  );
                })}
                {snapshot.userHiddenColumnIds.length > 0 ? (
                  <button type="button" className="experience-responsive-table__reset" onClick={() => model.resetColumnVisibility()}>Sütun görünümünü sıfırla</button>
                ) : null}
              </div>
            </details>
          ) : null}

          <span className="experience-responsive-table__projection-count" aria-label={projectionStatusLabel}>
            {snapshot.visibleColumns.length}/{definitionColumns.length} sütun
          </span>
        </div>
      ) : null}

      {announceProjection ? (
        <p
          className="experience-sr-only"
          aria-label={`${projectionStatusLabel} duyurusu`}
          aria-live="polite"
          aria-atomic="true"
        >
          {status}
        </p>
      ) : null}

      <div className="experience-responsive-table__viewport" data-overflow={snapshot.horizontalOverflow ? 'true' : 'false'}>
        <ExperienceDataTable
          {...tableProps}
          columns={projectedColumns}
          stackOnCompact={stackOnCompact}
          className="experience-responsive-table__managed"
        />
      </div>
    </section>
  );
}

export default ExperienceResponsiveDataTable;
