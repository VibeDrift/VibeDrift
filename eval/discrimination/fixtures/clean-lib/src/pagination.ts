import type { Page, PageRequest } from "./types.js";

export function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function paginate<TItem>(items: readonly TItem[], request: PageRequest): Page<TItem> {
  const slice = items.slice(request.offset, request.offset + request.limit);
  return {
    items: slice,
    total: items.length,
    limit: request.limit,
    offset: request.offset,
  };
}
