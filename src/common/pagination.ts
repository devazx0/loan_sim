export function paginate(query: { limit?: string; cursor?: string }) {
  const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 100);
  return { limit, cursor: query.cursor };
}

export function pageResponse<T extends { id: number }>(items: T[], limit: number) {
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: items.length === limit && last ? String(last.id) : null,
  };
}
