/**
 * アプリ全体の状態の組み立て: シナリオの読込・自動保存・編集後の再計算（デバウンス）。
 */
import { AUTOSAVE_DEBOUNCE_MS, RECOMPUTE_DEBOUNCE_MS } from '../config/editor';
import { DEFAULT_TRANSIT_TYPE, TRANSIT_TYPES, type TransitTypeParams } from '../config/transitTypes';
import type { DemandResult, FinanceResult, Scenario, ServicePlan, UserLine } from '../core/types';
import { rideTimesFrom, type ServicesFile } from '../data/services';
import type { DemandContext } from '../demand/context';
import { runDemand } from '../demand/engine';
import { operationFromPlan, type DemandThrough } from '../demand/lineOperation';
import { computeLinePlanOperation, normalizePlan, type LinePlanOperation } from '../network/servicePlan';
import { effectiveCostParams, runFinance } from '../finance/finance';
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
  /** 運行計画（シナリオに無ければ既定の計画）と、それから求めた所要時間・必要編成数など */
  readonly plan: ServicePlan | null;
  readonly operation: LinePlanOperation | null;
  /** 基礎データの読込前は null */
  readonly demand: DemandResult | null;
  readonly demandMs: number | null;
  readonly error: string | null;
  readonly computedFor: Scenario | null;
}

export const computeStore = createStore<ComputeState>({
  status: 'idle',
  geometry: null,
  plan: null,
  operation: null,
  demand: null,
  demandMs: null,
  error: null,
  computedFor: null,
});

let demandContext: DemandContext | null = null;
let servicesData: ServicesFile | null = null;

/** 基礎データの読込後に呼ぶ。以後の再計算で需要推計も行う */
export function setDemandContext(ctx: DemandContext, services: ServicesFile | null = null): void {
  demandContext = ctx;
  servicesData = services;
  compute(scenarioStore.scenario);
}

/** 路線の交通機関タイプ（省略時は普通鉄道） */
export function transitTypeOf(line: UserLine | undefined): TransitTypeParams {
  return TRANSIT_TYPES[line?.transitType ?? DEFAULT_TRANSIT_TYPE];
}

/** 路線の運行計画と運行の計算（費用パラメータの既定の計画・運行時間帯を使う） */
function planFor(s: Scenario, line: UserLine, geometry: LineGeometry): { plan: ServicePlan; operation: LinePlanOperation } {
  const cp = costParamsStore.get().params;
  const plan = normalizePlan(s.servicePlans?.find((p) => p.lineId === line.id), line, geometry, {
    tphPeak: cp.service.peakTrainsPerHour,
    tphOffpeak: cp.service.offpeakTrainsPerHour,
    carsPerTrain: cp.service.carsPerTrain,
  });
  const operation = computeLinePlanOperation(geometry, plan, transitTypeOf(line), cp.service, cp.construction.spareRatio);
  return { plan, operation };
}

/** 直通運転: 接続駅から直通先の系統の各駅までの乗車時間 */
function throughFor(plan: ServicePlan, geometry: LineGeometry, ctx: DemandContext): DemandThrough[] {
  if (!servicesData) return [];
  const out: DemandThrough[] = [];
  for (const t of plan.through) {
    const stop = geometry.stations.findIndex((s) => s.id === t.atStationId);
    const existingId = geometry.stations[stop]?.transferTo;
    const existing = existingId ? ctx.stations.byId.get(existingId) : undefined;
    const route = servicesData.routes.find((r) => r.id === t.routeId);
    if (stop < 0 || existing === undefined || !route) continue;
    out.push({ stop, ivtTo: rideTimesFrom(route, existing) });
  }
  return out;
}

function compute(s: Scenario): void {
  const line = s.lines[0];
  const geometry = line ? computeLineGeometry(line) : null;
  const planned = line && geometry ? planFor(s, line, geometry) : null;
  let demand: DemandResult | null = null;
  let demandMs: number | null = null;
  let error: string | null = null;
  if (line && demandContext) {
    const t0 = performance.now();
    try {
      const ctx = demandContext;
      const op = planned && geometry ? operationFromPlan(planned.operation, ctx.params.generalizedCost, throughFor(planned.plan, geometry, ctx)) : undefined;
      demand = runDemand(line, ctx, op);
    } catch (e) {
      console.error(e);
      error = e instanceof Error ? e.message : String(e);
    }
    demandMs = performance.now() - t0;
  }
  computeStore.set({ status: 'idle', geometry, plan: planned?.plan ?? null, operation: planned?.operation ?? null, demand, demandMs, error, computedFor: s });
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
  const { geometry, demand, operation } = computeStore.get();
  if (!geometry || !demand || !operation || geometry.segments.length === 0) {
    financeStore.set({ finance: null, error: null });
    return;
  }
  try {
    const line = computeStore.get().computedFor?.lines[0];
    const finance = runFinance(geometry, demand, effectiveCostParams(costParamsStore.get().params, transitTypeOf(line)), operation, landPrice);
    financeStore.set({ finance, error: null });
  } catch (e) {
    console.error(e);
    financeStore.set({ finance: null, error: e instanceof Error ? e.message : String(e) });
  }
}

computeStore.subscribe((s) => {
  if (s.status === 'idle') computeFinance();
});
// 費用パラメータの既定の計画（本数・両数）・運行時間帯は需要にも効くので、需要から計算し直す
costParamsStore.subscribe(() => {
  computeStore.set((st) => ({ ...st, status: 'pending' }));
  recompute(scenarioStore.scenario);
});

// 起動時に 1 回計算する（需要推計は基礎データの読込後）。ページを離れる前には保存を確定させる
compute(scenarioStore.scenario);
if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => autosave.flush());
