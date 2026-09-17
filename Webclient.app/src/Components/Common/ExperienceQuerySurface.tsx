import { useId, type FormEvent, type ReactNode } from 'react';
import { ExperienceInput } from './ExperienceForm';
import { ExperienceStatus, type ExperienceStatusTone } from './ExperienceStatus';

export interface ExperienceFilterChip {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onRemove?: () => void;
}

export interface ExperienceQuerySurfaceProps {
  readonly title: string;
  readonly description?: string;
  readonly query: string;
  readonly onQueryChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly queryLabel?: string;
  readonly queryPlaceholder?: string;
  readonly submitLabel?: string;
  readonly busy?: boolean;
  readonly status?: ReactNode;
  readonly statusTone?: ExperienceStatusTone;
  readonly filters?: readonly ExperienceFilterChip[];
  readonly onClearFilters?: () => void;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}

export function ExperienceQuerySurface({
  title,
  description,
  query,
  onQueryChange,
  onSubmit,
  queryLabel = 'Arama',
  queryPlaceholder = 'Aranacak ifadeyi yazın',
  submitLabel = 'Ara',
  busy = false,
  status,
  statusTone = 'neutral',
  filters = [],
  onClearFilters,
  actions,
  children,
}: ExperienceQuerySurfaceProps): ReactNode {
  const titleId = useId();
  const submit = (event: FormEvent<HTMLFormElement>): void => { event.preventDefault(); if (!busy) onSubmit(); };
  return (
    <section className="experience-query-surface" aria-labelledby={titleId} aria-busy={busy || undefined}>
      <header className="experience-query-surface__header">
        <div><h2 id={titleId}>{title}</h2>{description ? <p>{description}</p> : null}</div>
        {actions ? <div className="experience-query-surface__actions">{actions}</div> : null}
      </header>
      <form className="experience-query-surface__search" role="search" onSubmit={submit}>
        <ExperienceInput label={queryLabel} value={query} placeholder={queryPlaceholder} autoComplete="off" onChange={event => onQueryChange(event.currentTarget.value)} disabled={busy} />
        <button type="submit" className="experience-query-surface__submit" disabled={busy}>{busy ? 'Aranıyor…' : submitLabel}</button>
      </form>
      {filters.length > 0 ? (
        <div className="experience-filter-summary" aria-label="Etkin filtreler">
          <div className="experience-filter-summary__heading"><strong>Etkin filtreler</strong>{onClearFilters ? <button type="button" onClick={onClearFilters}>Tümünü temizle</button> : null}</div>
          <ul>{filters.map(filter => <li key={filter.id}><span>{filter.label}: <strong>{filter.value}</strong></span>{filter.onRemove ? <button type="button" onClick={filter.onRemove} aria-label={`${filter.label} filtresini kaldır`}>×</button> : null}</li>)}</ul>
        </div>
      ) : null}
      {status ? <ExperienceStatus tone={statusTone} live="polite" busy={busy}>{status}</ExperienceStatus> : null}
      <div className="experience-query-surface__content">{children}</div>
    </section>
  );
}
