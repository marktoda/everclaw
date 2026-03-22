/**
 * Evict the oldest entries from a Set or Map to cap its size.
 *
 * Iteration order in JS Sets and Maps follows insertion order,
 * so the first entries returned by the iterator are the oldest.
 */
export function evictOldest(
  collection: Set<any> | Map<any, any>,
  maxSize: number,
  evictCount: number,
): void {
  if (collection.size <= maxSize) return;
  const iter = collection.keys();
  for (let i = 0; i < evictCount; i++) {
    const { value, done } = iter.next();
    if (done) break;
    collection.delete(value);
  }
}
