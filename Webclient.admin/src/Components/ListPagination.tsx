import { Form } from "react-bootstrap";
import type { ChangeEventHandler } from "react";

interface ListPaginationProps {
    rowCount: number | string;
    pageSize: number | string;
    selectedPage: number | string;
    OnChange: ChangeEventHandler<HTMLSelectElement>;
}

const MAX_NEARBY_PAGES = 99;
const HALF_WINDOW = Math.floor(MAX_NEARBY_PAGES / 2);

export function visiblePaginationPages(
    rowCount: number | string,
    pageSize: number | string,
    selectedPage: number | string,
): { readonly count: number; readonly selected: number; readonly pages: readonly number[] } {
    const rows = Number(rowCount);
    const size = Number(pageSize);
    const count = Number.isSafeInteger(rows) && rows >= 0 &&
        Number.isSafeInteger(size) && size > 0
        ? Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(rows / size)))
        : 1;

    const requested = Number(selectedPage);
    const selected = Number.isSafeInteger(requested)
        ? Math.max(1, Math.min(requested, count))
        : 1;

    const start = Math.max(1, Math.min(selected - HALF_WINDOW, count - MAX_NEARBY_PAGES + 1));
    const end = Math.min(count, start + MAX_NEARBY_PAGES - 1);
    const pages = new Set<number>([1, selected, count]);
    for (let page = start; page <= end; page += 1) {
        pages.add(page);
    }
    // Fixed landmarks allow long-distance navigation without mounting one
    // option per page, regardless of the size of the backing GIS dataset.
    for (let step = 1; step < 10; step += 1) {
        pages.add(1 + Math.floor((count - 1) * step / 10));
    }
    return { count, selected, pages: [...pages].sort((a, b) => a - b) };
}

/** Bounded, controlled native selection; preserves legacy OnChange(event). */
export const ListPagination = ({
    rowCount, pageSize, selectedPage, OnChange,
}: ListPaginationProps) => {
    const pagination = visiblePaginationPages(rowCount, pageSize, selectedPage);
    return (
        <nav aria-label="Sayfalar" style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "0.5rem" }}>
            <Form.Select
                aria-label="Sayfa seçimi"
                size="sm"
                value={pagination.selected}
                style={{ width: "auto", minWidth: "5rem" }}
                onChange={OnChange}
            >
                {pagination.pages.map(page => (
                    <option key={page} value={page}>{page}</option>
                ))}
            </Form.Select>
            <span aria-live="polite">/ {pagination.count}</span>
        </nav>
    );
};
