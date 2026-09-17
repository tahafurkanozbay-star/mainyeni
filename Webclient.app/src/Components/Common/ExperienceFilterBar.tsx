import { useId, type ReactNode } from 'react';

export interface ExperienceActiveFilter {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onRemove?: () => void;
}

export interface ExperienceFilterBarProps {
  readonly searchValue?: string;
  readonly onSearchChange?: (value: string) => void;
  readonly searchLabel?: string;
  readonly searchPlaceholder?: string;
  readonly filters?: readonly ExperienceActiveFilter[];
  readonly onClearAll?: () => void;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  readonly busy?: boolean;
}

export function ExperienceFilterBar({ searchValue = '', onSearchChange, searchLabel = 'Sonuçlarda ara', searchPlaceholder = 'Ara…', filters = [], onClearAll, actions, children, busy = false }: ExperienceFilterBarProps): ReactNode {
  const searchId = useId();
  const hasSearch = Boolean(onSearchChange);
  const hasFilters = filters.length > 0;
  return (
    <section className="experience-filterbar" aria-label="Filtreler" aria-busy={busy || undefined}>
      <div className="experience-filterbar__primary">
        {hasSearch ? (
          <label className="experience-filterbar__search" htmlFor={searchId}>
            <span className="experience-sr-only">{searchLabel}</span>
            <span aria-hidden="true">⌕</span>
            <input id={searchId} type="search" value={searchValue} onChange={event => onSearchChange?.(event.target.value)} placeholder={searchPlaceholder} autoComplete="off" />
            {searchValue ? <button type="button" onClick={() => onSearchChange?.('')} aria-label="Aramayı temizle">×</button> : null}
          </label>
        ) : null}
        {children ? <div className="experience-filterbar__controls">{children}</div> : null}
        {actions ? <div className="experience-filterbar__actions">{actions}</div> : null}
      </div>
      {hasFilters ? (
        <div className="experience-filterbar__active" aria-label="Etkin filtreler">
          <span className="experience-filterbar__active-label">Filtreler</span>
          <ul>
            {filters.map(filter => (
              <li key={filter.id} className="experience-filter-chip">
                <span><strong>{filter.label}:</strong> {filter.value}</span>
                {filter.onRemove ? <button type="button" onClick={filter.onRemove} aria-label={`${filter.label} filtresini kaldır`}>×</button> : null}
              </li>
            ))}
          </ul>
          {onClearAll ? <button type="button" className="experience-filterbar__clear" onClick={onClearAll}>Tümünü temizle</button> : null}
        </div>
      ) : null}
    </section>
  );
}
