import { useMemo, type ReactNode } from 'react';

export interface ExperiencePaginationProps {
  readonly page: number;
  readonly pageCount: number;
  readonly onPageChange: (page: number) => void;
  readonly siblingCount?: number;
  readonly disabled?: boolean;
  readonly label?: string;
}

type PageToken = number | 'ellipsis-start' | 'ellipsis-end';

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const buildTokens = (page: number, pageCount: number, siblingCount: number): readonly PageToken[] => {
  if (pageCount <= 1) return [1];
  const radius = Math.max(0, Math.floor(siblingCount));
  const visible = new Set<number>([1, pageCount]);
  for (let candidate = page - radius; candidate <= page + radius; candidate += 1) {
    if (candidate >= 1 && candidate <= pageCount) visible.add(candidate);
  }
  const ordered = [...visible].sort((a, b) => a - b);
  const tokens: PageToken[] = [];
  ordered.forEach((candidate, index) => {
    const previous = ordered[index - 1];
    if (previous && candidate - previous > 1) tokens.push(previous === 1 ? 'ellipsis-start' : 'ellipsis-end');
    tokens.push(candidate);
  });
  return tokens;
};

export function ExperiencePagination({
  page,
  pageCount,
  onPageChange,
  siblingCount = 1,
  disabled = false,
  label = 'Sayfalama',
}: ExperiencePaginationProps): ReactNode {
  const safePageCount = Math.max(1, Math.floor(Number.isFinite(pageCount) ? pageCount : 1));
  const currentPage = clamp(Math.floor(Number.isFinite(page) ? page : 1), 1, safePageCount);
  const tokens = useMemo(() => buildTokens(currentPage, safePageCount, siblingCount), [currentPage, safePageCount, siblingCount]);
  const change = (next: number): void => {
    if (disabled) return;
    const bounded = clamp(next, 1, safePageCount);
    if (bounded !== currentPage) onPageChange(bounded);
  };

  return (
    <nav className="experience-pagination" aria-label={label}>
      <button type="button" className="experience-pagination__button" onClick={() => change(currentPage - 1)} disabled={disabled || currentPage === 1} aria-label="Önceki sayfa">‹</button>
      <ol className="experience-pagination__pages">
        {tokens.map(token => token === 'ellipsis-start' || token === 'ellipsis-end' ? (
          <li key={token} className="experience-pagination__ellipsis" aria-hidden="true">…</li>
        ) : (
          <li key={token}>
            <button
              type="button"
              className="experience-pagination__button"
              aria-current={token === currentPage ? 'page' : undefined}
              aria-label={`${token}. sayfa${token === currentPage ? ', mevcut sayfa' : ''}`}
              disabled={disabled}
              onClick={() => change(token)}
            >{token}</button>
          </li>
        ))}
      </ol>
      <button type="button" className="experience-pagination__button" onClick={() => change(currentPage + 1)} disabled={disabled || currentPage === safePageCount} aria-label="Sonraki sayfa">›</button>
    </nav>
  );
}

export const experiencePaginationInternals = Object.freeze({ buildTokens, clamp });
