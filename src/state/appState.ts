/**
 * アプリ全体の状態の組み立て: シナリオの読込・自動保存・編集後の再計算（デバウンス）。
 */
import { defaultDemandParams } from '../config/demand';
import { AUTOSAVE_DEBOUNCE_MS, RECOMPUTE_DEBOUNCE_MS } from '../config/editor';
import type { DemandResult, FinanceResult, Scenario } from '../core/types';
import type { DemandContext } from '../demand/context';
import { runDemand } from '../demand/engine';
import { runFinance } from '../finance/finance';
import type { LandPriceIndex } from '../finance/landPrice';
import { costParamsStore } from './costParams';
import { computeLineGeometry, type LineGeometry } from '../network/lineGeometry';
import { debounce } from './debounce';
import { loadFromStorage, saveToStorage } from './scenarioIO';
import { ScenarioStore, emptyScenario } from './scenarioStore';
import { createStore } from './store';

export const scenarioStore = new ScenarioStore(loadFromStorage() ?? emptyScenario());

/**
 * 再計算の結果。路線の幾何と需要推計（M5 で収支を加える）。
 * 計算中かどうかを UI で示せるよう status を持つ。
 */
export interface ComputeState {
  readonly status: 'idle' | 'pending';
  readonly geometry: LineGeometry | null;
  /** 基礎データの読込前は null */
  readonly demand: DemandResult | null;
  readonly demandMs: number | null;
  readonly error: string | null;
  readonly computedFor: Scenario | null;
}

export const computeStore = createStore<ComputeState>({
  status: 'idle',
  geometry: null,
  demand: null,
  demandMs: null,
  error: null,
  computedFor: null,
});

let demandContext: DemandContext | null = null;

/** 基礎データの読込後に呼ぶ。以後の再計算で需要推計も行う */
export function setDemandContext(ctx: DemandContext): void {
  demandContext = ctx;
  compute(scenarioStore.scenario);
}

function compute(s: Scenario): void {
  const line = s.lines[0];
  const geometry = line ? computeLineGeometry(line) : null;
  let demand: DemandResult | null = null;
  let demandMs: number | null = null;
  let error: string | null = null;
  if (line && demandContext) {
    const t0 = performance.now();
    try {
      demand = runDemand(line, demandContext);
    } catch (e) {
      console.error(e);
      error = e instanceof Error ? e.message : String(e);
    }
    demandMs = performance.now() - t0;
  }
  computeStore.set({ status: 'idle', geometry, demand, demandMs, error, computedFor: s });
}

const recompute = debounce(compute, RECOMPUTE_DEBOUNCE_MS);
const autosave = debounce((s: Scenario) => saveToStorage(s), AUTOSAVE_DEBOUNCE_MS);

let lastScenario = scenarioStore.scenario;
scenarioStore.store.subscribe(({ scenario }) => {
  if (scenario === lastScenario) return;
  lastScenario = scenario;
  computeStore.set((st) => ({ ...st, status: 'pending' }));
  recompute(scenario);
  autosave(scenario);
});

// ---------------------------------------------------------------------------
// 収支: 需要推計の結果か費用パラメータが変わるたびに計算し直す（軽いのでデバウンスしない）
// ---------------------------------------------------------------------------

export const financeStore = createStore<{ finance: FinanceResult | null; error: string | null }>({ finance: null, error: null });
let landPrice: LandPriceIndex | null = null;

/** 地価データの読込後に呼ぶ（無い場合は用地費 0 で計算） */
export function setLandPrice(index: LandPriceIndex | null): void {
  landPrice = index;
  computeFinance();
}

function computeFinance(): void {
  const { geometry, demand } = computeStore.get();
  if (!geometry || !demand || geometry.segments.length === 0) {
    financeStore.set({ finance: null, error: null });
    return;
  }
  try {
    const finance = runFinance(geometry, demand, costParamsStore.get().params, defaultDemandParams.service.scheduledSpeedKmh, landPrice);
    financeStore.set({ finance, error: null });
  } catch (e) {
    console.error(e);
    financeStore.set({ finance: null, error: e instanceof Error ? e.message : String(e) });
  }
}

computeStore.subscribe((s) => {
  if (s.status === 'idle') computeFinance();
});
costParamsStore.subscribe(() => computeFinance());

// 起動時に 1 回計算する（需要推計は基礎データの読込後）。ページを離れる前には保存を確定させる
compute(scenarioStore.scenario);
if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => autosave.flush());
