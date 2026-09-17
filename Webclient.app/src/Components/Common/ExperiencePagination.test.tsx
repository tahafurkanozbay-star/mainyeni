import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExperiencePagination, experiencePaginationInternals } from './ExperiencePagination';

describe('ExperiencePagination', () => {
  it('clamps invalid page input and disables previous at the lower bound', () => {
    render(<ExperiencePagination page={-4} pageCount={8} onPageChange={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Önceki sayfa' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '1. sayfa, mevcut sayfa' })).toHaveAttribute('aria-current', 'page');
  });

  it('emits only a bounded next page', () => {
    const onPageChange = vi.fn();
    render(<ExperiencePagination page={2} pageCount={3} onPageChange={onPageChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sonraki sayfa' }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('builds a compact token set for large result collections', () => {
    expect(experiencePaginationInternals.buildTokens(50, 100, 1)).toEqual([1, 'ellipsis-start', 49, 50, 51, 'ellipsis-end', 100]);
  });
});
