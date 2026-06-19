/**
 * Generic client-side pagination hook.
 *
 * Slices the input array into pages of `pageSize`, exposes the current page
 * slice, and clamps `page` to the valid range whenever the data shrinks
 * (e.g. when a filter is applied). The caller owns `page` and `pageSize` so
 * they can persist either one to localStorage or reset on filter change.
 */

import { useEffect, useMemo } from "react";

export interface UsePaginationResult<T> {
  /** Total number of pages (always >= 1, even when items is empty). */
  totalPages: number;
  /** The slice of items that should render on the current page. */
  pageItems: T[];
  /** First index (1-based) shown on the current page. 0 when items is empty. */
  rangeStart: number;
  /** Last index (1-based) shown on the current page. 0 when items is empty. */
  rangeEnd: number;
}

export function usePagination<T>(
  items: T[],
  page: number,
  pageSize: number,
  onPageChange: (next: number) => void,
): UsePaginationResult<T> {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));

  // Clamp page when the dataset shrinks below the current page (e.g. user
  // applies a filter that reduces row count). Without this the table would
  // appear empty until the user manually clicks Prev.
  useEffect(() => {
    if (page > totalPages) onPageChange(totalPages);
    if (page < 1) onPageChange(1);
  }, [page, totalPages, onPageChange]);

  const safePage = Math.min(Math.max(1, page), totalPages);

  const pageItems = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, safePage, pageSize]);

  const rangeStart = items.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const rangeEnd = items.length === 0 ? 0 : Math.min(items.length, safePage * pageSize);

  return { totalPages, pageItems, rangeStart, rangeEnd };
}
