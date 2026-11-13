/**
 * Two small tools for slow lookups (gh, Jira):
 *
 * - `once`: callers asking for the same thing while it's already being
 *   fetched share that one fetch, instead of each starting their own.
 * - `Swr`: keeps answers. A fresh one is returned as is. An old one is still
 *   returned at once, while a new one is fetched behind it for next time, so
 *   a screen never waits on a lookup it has seen before.
 */
const inflight = new Map<string, Promise<unknown>>()

export function once<T>(key: string, fetch: () => Promise<T>): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined
  if (running) return running
  const p = fetch().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

export class Swr<T> {
  private kept = new Map<string, { at: number; value: T }>()

  constructor(
    private readonly name: string,
    /** Younger than this, an answer is used without asking again. */
    private readonly freshMs: number,
    /** Older than this, an answer is too old to show while a new one comes. */
    private readonly staleMs: number
  ) {}

  /** The answer for `key`, fetching only when there's none worth showing. */
  async get(key: string, fetch: () => Promise<T>, onRefreshed?: (value: T) => void): Promise<T> {
    const hit = this.kept.get(key)
    const age = hit ? Date.now() - hit.at : Infinity
    const load = (): Promise<T> =>
      once(`${this.name}:${key}`, async () => {
        const value = await fetch()
        this.kept.set(key, { at: Date.now(), value })
        return value
      })
    if (hit && age < this.freshMs) return hit.value
    if (hit && age < this.staleMs) {
      void load()
        .then((v) => onRefreshed?.(v))
        .catch(() => {
          // Keep showing the old answer; the next ask tries again.
        })
      return hit.value
    }
    return load()
  }

  forget(key: string): void {
    this.kept.delete(key)
  }
}
