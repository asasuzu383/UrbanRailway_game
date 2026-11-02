/**
 * 費用パラメータ（パネルで調整できる）。ブラウザに保存し、読み込み時は既定値と同じ形の数値だけを採用する。
 */
import type { CostParams } from '../config/cost';
import { CURRENT_REGION } from '../config/regions';
import { createStore } from './store';

const STORAGE_KEY = CURRENT_REGION.storageKeys.costParams;
/** 地域の単価の初期値 */
const defaultCostParams: CostParams = CURRENT_REGION.costParams;

/** stored のうち、defaults と同じ形（数値・数値配列・入れ子オブジェクト）の値だけを上書きする */
export function mergeParams<T>(defaults: T, stored: unknown): T {
  if (typeof defaults === 'number') return (typeof stored === 'number' && Number.isFinite(stored) ? stored : defaults) as T;
  if (Array.isArray(defaults)) {
    return (Array.isArray(stored) && stored.length > 0 && stored.every((x) => typeof x === 'number' && Number.isFinite(x))
      ? stored
      : defaults) as T;
  }
  if (typeof defaults === 'object' && defaults !== null) {
    const src = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(defaults)) out[k] = mergeParams(v, src[k]);
    return out as T;
  }
  return defaults;
}

function load(): CostParams {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text ? mergeParams(defaultCostParams, JSON.parse(text)) : defaultCostParams;
  } catch {
    return defaultCostParams;
  }
}

export const costParamsStore = createStore<{ params: CostParams }>({ params: load() });

costParamsStore.subscribe(({ params }) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
  } catch {
    // 保存できない環境（プライベートモード等）では保存しない
  }
});

/** パス（例: ['fare', 'minimumFare']）で 1 つの値を更新する */
export function setCostParam(path: readonly (string | number)[], value: number | number[]): void {
  costParamsStore.set(({ params }) => ({ params: setIn(params, path, value) }));
}

export function resetCostParams(): void {
  costParamsStore.set({ params: defaultCostParams });
}

function setIn<T>(obj: T, path: readonly (string | number)[], value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  const src = obj as Record<string | number, unknown>;
  const copy = (Array.isArray(obj) ? [...obj] : { ...src }) as Record<string | number, unknown>;
  copy[head!] = setIn(src[head!], rest, value);
  return copy as T;
}
