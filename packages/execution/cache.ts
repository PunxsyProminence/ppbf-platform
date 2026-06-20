const cache = new Map();

export function setCache(key: string, value: any, ttlMs: number = 300000) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

export function getCache(key: string) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

export function clearCache() {
  cache.clear();
}
