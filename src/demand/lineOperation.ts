/**
 * 需要推計で使う新線の運行（docs/design.md §14.2）。
 * 停車駅の組ごとに、両方に停まる種別の合計本数から待ち時間を、本数で重み付けした平均から乗車時間を求め、
 * 新線上の一般化費用 [分]（待ち時間＋乗車時間）にする。直通運転は接続駅から直通先の系統の駅まで乗換なしで行ける。
 */
import { representativeTph, waitMinutes, type GeneralizedCostWeights } from '../core/generalizedCost';
import type { LinePlanOperation } from '../network/servicePlan';
import type { LineStop } from './lineStops';

export interface DemandPattern {
  /** LineStop ごとに停車するか */
  readonly stops: readonly boolean[];
  /** 起点からの所要時間 [分]（停車駅のみ） */
  readonly cumMin: readonly number[];
  /** 代表本数 [本/時]（ピークと日中の加重平均） */
  readonly tph: number;
}

export interface DemandThrough {
  /** 直通する接続駅（LineStop の添字） */
  readonly stop: number;
  /** 直通先の系統の各駅（既存駅の添字）までの乗車時間 [分]（接続駅から。乗換・待ちなし） */
  readonly ivtTo: ReadonlyMap<number, number>;
}

export interface LineOperation {
  readonly patterns: readonly DemandPattern[];
  readonly through: readonly DemandThrough[];
}

/** Phase 1 互換: 全駅停車・一律の表定速度・代表本数（運行計画を渡さないとき。バックテストの比較用） */
export function uniformOperation(stops: readonly LineStop[], speedKmh: number, tph: number): LineOperation {
  return {
    patterns: [{ stops: stops.map(() => true), cumMin: stops.map((s) => (s.chainageKm * 60) / speedKmh), tph }],
    through: [],
  };
}

/** 運行計画（network/servicePlan）から。through は呼び出し側で直通先の系統の時間を引いて渡す */
export function operationFromPlan(op: LinePlanOperation, w: GeneralizedCostWeights, through: readonly DemandThrough[] = []): LineOperation {
  return {
    patterns: op.patterns.map((p) => ({
      stops: p.stops,
      cumMin: p.cumMin,
      tph: representativeTph({ peak: p.pattern.tphPeak, offpeak: p.pattern.tphOffpeak }, w),
    })),
    through,
  };
}

/**
 * 新線上の駅の組ごとの一般化費用 [分]（ns × ns、行 = 乗車駅）。両方に停まる種別がなければ Infinity。
 * 待ち時間は両方に停まる種別の合計本数で求め（来た列車に乗る）、乗車時間は本数で重み付けした平均。
 */
export function onLineCost(op: LineOperation, ns: number, w: GeneralizedCostWeights): Float64Array {
  const out = new Float64Array(ns * ns).fill(Infinity);
  for (let a = 0; a < ns; a++) {
    out[a * ns + a] = 0;
    for (let b = a + 1; b < ns; b++) {
      let tph = 0;
      let ivt = 0;
      for (const p of op.patterns) {
        if (!p.stops[a] || !p.stops[b] || !(p.tph > 0)) continue;
        tph += p.tph;
        ivt += p.tph * Math.abs(p.cumMin[b]! - p.cumMin[a]!);
      }
      if (tph > 0) {
        const c = w.waitWeight * waitMinutes(tph, w) + ivt / tph;
        out[a * ns + b] = c;
        out[b * ns + a] = c;
      }
    }
  }
  return out;
}
