import type { ReactNode } from 'react';
import './ExperiencePrimitives.css';

export interface ExperiencePaginationProps {
  readonly page: number;
  readonly pageCount: number;
  readonly onPageChange: (page: number) => void;
  readonly label?: string;
  readonly siblingCount?: number;
  readonly disabled?: boolean;
}

export const normalizePage = (page: number, pageCount: number): number => {
  const safeCount = Math.max(1, Math.floor(Number.isFinite(pageCount) ? pageCount : 1));
  const safePage = Math.floor(Number.isFinite(page) ? page : 1);
  return Math.min(safeCount, Math.max(1, safePage));
};

export const createPaginationWindow = (
  page: number,
  pageCount: number,
  siblingCount = 1,
): readonly number[] => {
  const count = Math.max(1, Math.floor(Number.isFinite(pageCount) ? pageCount : 1));
  const current = normalizePage(page, count);
  const siblings = Math.max(0, Math.min(4, Math.floor(siblingCount)));
  const maximumVisible = Math.min(count, siblings * 2 + 5);

  if (count <= maximumVisible) {
    return Array.from({ length: count }, (_, index) => index + 1);
  }

  const pages = new Set<number>([1, count, current]);
  for (let offset = 1; offset <= siblings; offset += 1) {
    if (current - offset > 1) pages.add(current - offset);
    if (current + offset < count) pages.add(current + offset);
  }

  if (current <= siblings + 3) {
    for (let value = 2; value <= Math.min(count - 1, maximumVisible - 1); value += 1) {
      pages.add(value);
    }
  } else if (current >= count - siblings - 2) {
    for (
      let value = Math.max(2, count - maximumVisible + 2);
      value < count;
      value += 1
    ) {
      pages.add(value);
    }
  }

  return [...pages].sort((left, right) => left - right);
};

export function ExperiencePagination({
  page,
  pageCount,
  onPageChange,
  label = 'Sayfalama',
  siblingCount = 1,
  disabled = false,
}: ExperiencePaginationProps): ReactNode {
  const count = Math.max(1, Math.floor(Number.isFinite(pageCount) ? pageCount : 1));
  const current = normalizePage(page, count);
  const pages = createPaginationWindow(current, count, siblingCount);

  if (count <= 1) return null;

  return (
    <nav className="experience-pagination" aria-label={label}>
      <button
        type="button"
        className="experience-pagination__button"
        disabled={disabled || current <= 1}
        onClick={() => onPageChange(current - 1)}
        aria-label="Önceki sayfa"
      >
        ‹
      </button>
      <div className="experience-pagination__pages">
        {pages.map((value, index) => {
          const previous = pages[index - 1];
          const hasGap = previous !== undefined && value - previous > 1;
          return (
            <span key={value} style={{ display: 'contents' }}>
              {hasGap ? <span aria-hidden="true">…</span> : null}
              <button
                type="button"
                className="experience-pagination__button"
                aria-current={value === current ? 'page' : undefined}
                disabled={disabled}
                onClick={() => onPageChange(value)}
                aria-label={`Sayfa ${value}`}
              >
                {value}
              </button>
            </span>
          );
        })}
      </div>
      <button
        type="button"
        className="experience-pagination__button"
        disabled={disabled || current >= count}
        onClick={() => onPageChange(current + 1)}
        aria-label="Sonraki sayfa"
      >
        ›
      </button>
    </nav>
  );
}
