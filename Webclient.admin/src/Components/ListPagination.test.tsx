import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ListPagination, visiblePaginationPages } from './ListPagination';

describe('Admin ListPagination bounded and accessible contract', () => {
  test('supports empty and invalid pagination without creating large arrays', () => {
    for (const [rows, size, selected] of [
      [0, 10, 1], [100, 0, 1], [-1, 5, -2], [Number.NaN, 10, 1],
      [100, Number.POSITIVE_INFINITY, 1], [100, 10, Number.NaN],
    ]) {
      const result = visiblePaginationPages(rows, size, selected);
      expect(result.count).toBe(1);
      expect(result.selected).toBe(1);
      expect(result.pages).toEqual([1]);
    }
  });

  test('retains an exact current page and count for large datasets with bounded options', () => {
    const result = visiblePaginationPages(1_000_000_000, 1, 765_432_100);
    expect(result.count).toBe(1_000_000_000);
    expect(result.selected).toBe(765_432_100);
    expect(result.pages.length).toBeLessThanOrEqual(110);
    expect(result.pages[0]).toBe(1);
    expect(result.pages.at(-1)).toBe(1_000_000_000);
    expect(result.pages).toContain(765_432_100);
    expect(new Set(result.pages).size).toBe(result.pages.length);
    expect(result.pages).toEqual([...result.pages].sort((a, b) => a - b));
  });

  test('supports near-start and near-end selection without invalid options', () => {
    for (const page of [1, 2, 1000, 999, 500]) {
      const result = visiblePaginationPages(1000, 1, page);
      expect(result.pages).toContain(page);
      expect(result.pages.length).toBeLessThanOrEqual(110);
      expect(result.pages.every(p => Number.isSafeInteger(p) && p >= 1 && p <= 1000)).toBe(true);
    }
  });

  test('updates its controlled page and total immediately when parent props change', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ListPagination rowCount={50} pageSize={10} selectedPage={2} OnChange={onChange} />,
    );
    const select = screen.getByRole('combobox', { name: 'Sayfa seçimi' });
    expect(select).toHaveValue('2');
    expect(screen.getByText('/ 5')).toBeInTheDocument();
    rerender(<ListPagination rowCount={90} pageSize={10} selectedPage={7} OnChange={onChange} />);
    expect(select).toHaveValue('7');
    expect(screen.getByText('/ 9')).toBeInTheDocument();
    rerender(<ListPagination rowCount={10} pageSize={10} selectedPage={7} OnChange={onChange} />);
    expect(select).toHaveValue('1');
    expect(screen.getByText('/ 1')).toBeInTheDocument();
  });

  test('preserves the legacy OnChange(event) selection callback contract', async () => {
    const user = userEvent.setup();
    let observedValue: string | undefined;
    let observedTag: string | undefined;
    const onChange = vi.fn((event: React.ChangeEvent<HTMLSelectElement>) => {
      observedValue = event.currentTarget.value;
      observedTag = event.currentTarget.tagName;
    });
    render(<ListPagination rowCount={100} pageSize={10} selectedPage={1} OnChange={onChange} />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sayfa seçimi' }), '7');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(observedValue).toBe('7');
    expect(observedTag).toBe('SELECT');
  });

  test('renders a finite number of options and keeps first/last jump points accessible', () => {
    render(<ListPagination rowCount={9_000_000_000} pageSize={1} selectedPage={5_000_000} OnChange={vi.fn()} />);
    const control = screen.getByRole('combobox', { name: 'Sayfa seçimi' });
    const choices = control.querySelectorAll('option');
    expect(choices.length).toBeLessThanOrEqual(110);
    expect(control.querySelector('option[value="1"]')).not.toBeNull();
    expect(control.querySelector('option[value="9000000000"]')).not.toBeNull();
    expect(screen.getByRole('navigation', { name: 'Sayfalar' })).toBeInTheDocument();
  });

  test('does not allocate unbounded options for a malicious count', () => {
    const result = visiblePaginationPages(Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
    expect(result.pages.length).toBeLessThanOrEqual(110);
    expect(result.selected).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.count).toBe(Number.MAX_SAFE_INTEGER);
  });
});
