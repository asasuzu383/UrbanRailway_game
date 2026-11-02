/**
 * 輸送力制約（Phase 2 M5。docs/design.md §16）: 区間ごとの混雑率と、混雑による不効用を入れた需要の均衡計算。
 *
 *   ピーク 1 時間の断面輸送量 = max(上り, 下り の 1 日の断面輸送量) × ピーク率
 *   輸送力 = Σ（種別のピーク本数 × 編成両数 × 1 両の定員）
 *   混雑率 = ピーク 1 時間の断面輸送量 / 輸送力
 *   新線の乗車時間の係数 = 1 + alpha × max(0, 混雑率 − threshold)
 * 係数を変えると需要が変わり混雑率も変わるので、係数を逐次平均法（MSA）で更新して数回で収束させる。
 * 既存線の混雑は扱わない（Phase 3 のネットワーク配分で扱う）。
 */
import type { CapacityParams } from '../config/capacity';
import type { DemandResult, UserLine } from '../core/types';
import type { DemandContext } from './context';
import { runDemand } from './engine';
import type { LineOperation } from './lineOperation';

/** 区間ごとのピーク 1 時間の輸送力 [人/時]（全種別が全区間を走る） */
export function segmentCapacity(nSegments: number, patterns: readonly { tphPeak: number; carsPerTrain: number }[], capacityPerCar: number): number[] {
  const perHour = patterns.reduce((a, p) => a + p.tphPeak * p.carsPerTrain * capacityPerCar, 0);
  return Array.from({ length: nSegments }, () => perHour);
}

/** 区間ごとの混雑率（ピーク方向） */
export function congestionRates(demand: DemandResult, capacity: readonly number[], c: CapacityParams): number[] {
  return demand.segments.map((s, k) => {
    const cap = capacity[k] ?? 0;
    const load = Math.max(s.forward, s.backward) * c.peakHourShare;
    return cap > 0 ? load / cap : load > 0 ? Infinity : 0;
  });
}

export function crowdingMultiplier(rate: number, c: CapacityParams): number {
  return 1 + c.crowding.alpha * Math.max(0, Math.min(rate, 10) - c.crowding.threshold);
}

export interface CapacityResult {
  readonly demand: DemandResult;
  /** 区間ごとの混雑率（均衡後） */
  readonly congestion: readonly number[];
  /** 区間ごとの乗車時間の係数（均衡後） */
  readonly multipliers: readonly number[];
  readonly capacity: readonly number[];
  readonly iterations: number;
  readonly converged: boolean;
}

/**
 * 混雑の不効用を入れた需要の均衡計算。最初の推計で混雑率が threshold 以下なら係数 1 のまま（追加の計算なし）。
 */
export function runDemandWithCapacity(
  line: UserLine,
  ctx: DemandContext,
  op: LineOperation,
  capacity: readonly number[],
  c: CapacityParams,
): CapacityResult {
  let multipliers = capacity.map(() => 1);
  let demand = runDemand(line, ctx, { ...op, segmentIvtMultiplier: multipliers });
  let rates = congestionRates(demand, capacity, c);
  let iterations = 1;
  let converged = rates.every((r) => r <= c.crowding.threshold);
  for (let n = 1; !converged && n < c.equilibrium.maxIterations; n++) {
    const target = rates.map((r) => crowdingMultiplier(r, c));
    const next = multipliers.map((m, k) => m + (target[k]! - m) / (n + 1));
    const change = Math.max(...next.map((m, k) => Math.abs(m - multipliers[k]!)));
    multipliers = next;
    demand = runDemand(line, ctx, { ...op, segmentIvtMultiplier: multipliers });
    rates = congestionRates(demand, capacity, c);
    iterations++;
    converged = change < c.equilibrium.tolerance;
  }
  return { demand, congestion: rates, multipliers, capacity, iterations, converged };
}
