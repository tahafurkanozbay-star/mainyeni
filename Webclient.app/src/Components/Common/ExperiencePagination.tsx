import type { ReactNode } from 'react';

export type ExperiencePaginationItem = number | 'ellipsis-start' | 'ellipsis-end';

export interface ExperiencePaginationProps {
  readonly page: number;
  readonly totalPages: number;
  readonly onPageChange: (page: number) => void;
  readonly label?: string;
  readonly siblingCount?: number;
  readonly disabled?: boolean;
}

const clampInteger = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.trunc(Number.isFinite(value) ? value : min)));

export function buildPaginationItems(page: number, totalPages: number, siblingCount = 1): ExperiencePaginationItem[] {
  const safeTotal = Math.max(1, Math.trunc(Number.isFinite(totalPages) ? totalPages : 1));
  const safePage = clampInteger(page, 1, safeTotal);
  const siblings = clampInteger(siblingCount, 0, 3);
  if (safeTotal <= 5 + siblings * 2) return Array.from({ length: safeTotal }, (_, index) => index + 1);
  const left = Math.max(2, safePage - siblings);
  const right = Math.min(safeTotal - 1, safePage + siblings);
  const items: ExperiencePaginationItem[] = [1];
  if (left > 2) items.push('ellipsis-start');
  for (let current = left; current <= right; current += 1) items.push(current);
  if (right < safeTotal - 1) items.push('ellipsis-end');
  items.push(safeTotal);
  return items;
}

export function ExperiencePagination({ page, totalPages, onPageChange, label = 'Sayfalama', siblingCount = 1, disabled = false }: ExperiencePaginationProps): ReactNode {
  const safeTotal = Math.max(1, Math.trunc(Number.isFinite(totalPages) ? totalPages : 1));
  const safePage = clampInteger(page, 1, safeTotal);
  const changePage = (next: number): void => {
    if (disabled) return;
    const bounded = clampInteger(next, 1, safeTotal);
    if (bounded !== safePage) onPageChange(bounded);
  };
  return (
    <nav className="experience-pagination" aria-label={label}>
      <button type="button" onClick={() => changePage(safePage - 1)} disabled={disabled || safePage <= 1} aria-label="Önceki sayfa">‹</button>
      <ol>
        {buildPaginationItems(safePage, safeTotal, siblingCount).map(item => typeof item === 'number' ? (
          <li key={item}><button type="button" onClick={() => changePage(item)} disabled={disabled} aria-current={item === safePage ? 'page' : undefined} aria-label={`${item}. sayfa`}>{item}</button></li>
        ) : <li key={item} aria-hidden="true">…</li>)}
      </ol>
      <button type="button" onClick={() => changePage(safePage + 1)} disabled={disabled || safePage >= safeTotal} aria-label="Sonraki sayfa">›</button>
    </nav>
  );
}
