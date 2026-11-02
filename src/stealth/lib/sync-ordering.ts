/**
 * Sort filter hits into Bitcoin chain order before the order-sensitive UTXO
 * walk. Concurrent filter workers append in completion order, so callers must
 * not consume their arrays until this function has run.
 */
export function sortByAscendingHeight<T extends { height: number }>(hits: T[]): T[] {
  return hits.sort((a, b) => a.height - b.height);
}
