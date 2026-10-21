type CachedBundle = {
  data: unknown;
  expiresAt: number;
};

const bundleCache = new Map<string, CachedBundle>();
const BUNDLE_CACHE_TTL_MS = 30_000; // 30s cache

export function getCachedSocialBundle(userId: string): unknown | null {
  const hit = bundleCache.get(userId);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.data;
  }
  return null;
}

export function setCachedSocialBundle(userId: string, data: unknown): void {
  bundleCache.set(userId, { data, expiresAt: Date.now() + BUNDLE_CACHE_TTL_MS });
  if (bundleCache.size > 2000) {
    const now = Date.now();
    for (const [k, v] of bundleCache.entries()) {
      if (v.expiresAt <= now) bundleCache.delete(k);
    }
  }
}

export function invalidateSocialBundleCache(userIds: string | string[]): void {
  const list = Array.isArray(userIds) ? userIds : [userIds];
  for (const id of list) {
    if (id) bundleCache.delete(id);
  }
}
