/**
 * Tiny in-process TTL cache for the aggregate dashboard endpoints. Underlying
 * data only changes once a day (the scheduled fetch) plus the occasional
 * on-demand "Générer maintenant"/"Vérifier maintenant" action, so a short TTL
 * turns repeat navigation (switching tabs, tweaking the period) from N
 * database round trips into a plain object lookup -- the main lever for
 * keeping the dashboard feeling instant instead of Data-Studio-slow.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

const DEFAULT_TTL_MS = 3 * 60 * 1000;

export async function cached<T>(key: string, compute: () => Promise<T>, ttlMs = DEFAULT_TTL_MS): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await compute();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/** Drops every cached entry -- called after anything that changes underlying data (sync, backfill, on-demand checks). */
export function clearCache(): void {
  store.clear();
}
