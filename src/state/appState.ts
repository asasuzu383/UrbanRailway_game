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
import { computeLinePlanOperation, invalidStructureSegments, normalizePlan, planWarnings, type LinePlanOperation } from '../network/servicePlan';
import { defaultCapacityParams } from '../config/capacity';
import { runDemandWithCapacity, segmentCapacity, type CapacityResult } from '../demand/capacity';
import { STRUCTURE_LABELS } from '../config/editor';
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
  /** 輸送力制約（混雑率・均衡計算の結果）。需要推計の前は null */
  readonly capacity: CapacityResult | null;
  /** 計画・構造・混雑の警告（UI に表示） */
  readonly warnings: readonly string[];
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
  capacity: null,
  warnings: [],
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

/** 直通先の候補: 既存駅（stations.json の id）を通る既存の運行系統。運行データの読込前は空 */
export function throughCandidates(existingStationId: string | null): { id: string; name: string; operator: string; quality: string }[] {
  if (!servicesData || !demandContext || !existingStationId) return [];
  const idx = demandContext.stations.byId.get(existingStationId);
  if (idx === undefined) return [];
  return servicesData.routes
    .filter((r) => r.stations.includes(idx))
    .map((r) => ({ id: r.id, name: r.name, operator: r.operator, quality: r.quality }));
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

/** 警告: 交通機関タイプで選べない構造、運行計画（最小運転間隔・編成両数）、混雑率（国交省の目標の水準を超える区間） */
function collectWarnings(line: UserLine, geometry: LineGeometry, plan: ServicePlan, cap: CapacityResult | null): string[] {
  const t = transitTypeOf(line);
  const out: string[] = [];
  const bad = invalidStructureSegments(geometry, t);
  if (bad.length > 0) {
    const kinds = [...new Set(geometry.segments.filter((g) => bad.includes(g.fromStationId)).map((g) => STRUCTURE_LABELS[g.structure]))];
    out.push(`${t.name}では ${kinds.join('・')} の区間を選べません（${bad.length} 区間）。構造を ${t.structures.map((x) => STRUCTURE_LABELS[x]).join('・')} に変えてください`);
  }
  out.push(...planWarnings(plan, t));
  if (cap) {
    const w = defaultCapacityParams.warn;
    const name = (k: number) => `${geometry.stations[k]?.name}〜${geometry.stations[k + 1]?.name}`;
    const over = cap.congestion.map((r, k) => [r, k] as const).filter(([r]) => r > w.limit);
    if (over.length > 0) {
      const [r, k] = over.reduce((a, b) => (b[0] > a[0] ? b : a));
      out.push(`混雑率が ${Math.round(w.limit * 100)}% を超える区間が ${over.length} あります（最大 ${name(k)} ${Math.round(r * 100)}%）。${t.name}の輸送力では捌けない需要があります。本数・編成両数を増やすか、輸送力の大きい交通機関を検討してください`);
    } else if (cap.congestion.some((r) => r > w.target)) {
      out.push(`混雑率が ${Math.round(w.target * 100)}% を超える区間があります（国交省の目標の水準）`);
    }
  }
  return out;
}

function compute(s: Scenario): void {
  const line = s.lines[0];
  const geometry = line ? computeLineGeometry(line) : null;
  const planned = line && geometry ? planFor(s, line, geometry) : null;
  let demand: DemandResult | null = null;
  let capacity: CapacityResult | null = null;
  let demandMs: number | null = null;
  let error: string | null = null;
  if (line && demandContext) {
    const t0 = performance.now();
    try {
      const ctx = demandContext;
      if (planned && geometry) {
        const op = operationFromPlan(planned.operation, ctx.params.generalizedCost, throughFor(planned.plan, geometry, ctx));
        const cap = segmentCapacity(geometry.segments.length, planned.plan.patterns, transitTypeOf(line).capacityPerCar);
        capacity = runDemandWithCapacity(line, ctx, op, cap, defaultCapacityParams);
        demand = capacity.demand;
      } else {
        demand = runDemand(line, ctx);
      }
    } catch (e) {
      console.error(e);
      error = e instanceof Error ? e.message : String(e);
    }
    demandMs = performance.now() - t0;
  }
  const warnings = line && geometry && planned ? collectWarnings(line, geometry, planned.plan, capacity) : [];
  computeStore.set({ status: 'idle', geometry, plan: planned?.plan ?? null, operation: planned?.operation ?? null, capacity, warnings, demand, demandMs, error, computedFor: s });
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
