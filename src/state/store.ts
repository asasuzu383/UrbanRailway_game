/** 最小限の状態ストア。UI フレームワークに依存しない（ui 側でフックに包む）。 */
export interface Store<T> {
  get(): T;
  set(update: Partial<T> | ((prev: T) => T)): void;
  subscribe(listener: (state: T) => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<(state: T) => void>();
  return {
    get: () => state,
    set(update) {
      const next = typeof update === 'function' ? update(state) : { ...state, ...update };
      if (next === state) return;
      state = next;
      for (const l of listeners) l(state);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
