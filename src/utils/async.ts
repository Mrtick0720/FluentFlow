export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = ((...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as Debounced<A>;
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

/** Split items into batches capped by count and by total measured size. */
export function batchBy<T>(
  items: T[],
  maxItems: number,
  maxSize: number,
  sizeOf: (item: T) => number,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentSize = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (current.length > 0 && (current.length >= maxItems || currentSize + size > maxSize)) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(item);
    currentSize += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
