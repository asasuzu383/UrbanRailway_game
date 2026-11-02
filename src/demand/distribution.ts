/**
 * 分布と経路選択（docs/design.md §4.4, §4.5）。
 *
 * 既存駅・新駅すべてを発地とする発生制約型の重力モデル
 *   T(o→d) = (μ_o / 2) · M_d · exp(−γ t_od) / ACC_o
 * を考え、そのうち新線を通るものだけを新線の OD として集計する。既存駅どうしの組は
 * 既存経路と新線経由の所要時間の差による 2 項ロジットで新線経由の割合を決める（短絡利用）。
 * 発地側・着地側の両方向から求めた流動を半分ずつ足し合わせて対称化する。
 */
import type { DemandContext } from './context';
import type { NewNetwork } from './newNetwork';

/** 新線経由の方が遅いとき、これ以上遅い組は計算を省く [分]（ロジットの割合が十分小さい） */
const ROUTE_SLACK_MIN = 20;

export interface Accessibility {
  /** 新線ありの既存駅の ACC */
  readonly existing: Float64Array;
  /** 新線の各駅の ACC（接続駅は既存駅の値） */
  readonly stops: Float64Array;
}

export function computeAccessibility(ctx: DemandContext, net: NewNetwork, stopMass: Float64Array): Accessibility {
  const st = ctx.stations;
  const gamma = ctx.params.fitted.timeDecayPerMin;
  const n = st.n;
  const nt = net.transferStops.length;
  const existing = Float64Array.from(st.accOld);
  const stops = new Float64Array(net.stops.length);
  const outTime = new Float64Array(nt);
  const outFrom = new Int32Array(nt);

  for (let o = 0; o < n; o++) {
    if (net.minBoard[o] === Infinity) continue;
    let gain = 0;
    if (nt >= 2) {
      net.outbound(o, outTime, outFrom);
      for (let d = 0; d < n; d++) {
        if (d === o) continue;
        const told = ctx.times.get(o, d);
        let via = Infinity;
        for (let li = 0; li < nt; li++) via = Math.min(via, outTime[li]! + net.board[li]![d]!);
        if (via < told) gain += st.mass[d]! * (Math.exp(-gamma * via) - (told === Infinity ? 0 : ctx.decayTable[told]!));
      }
    }
    for (const f of net.freshStops) gain += stopMass[f]! * Math.exp(-gamma * net.toFresh(o, f).time);
    existing[o] = st.accOld[o]! + gain;
  }

  for (const f of net.freshStops) {
    let acc = 0;
    for (const g of net.freshStops) if (g !== f) acc += stopMass[g]! * Math.exp(-gamma * net.freshToFresh(f, g));
    if (nt > 0) for (let d = 0; d < n; d++) acc += st.mass[d]! * Math.exp(-gamma * net.toFresh(d, f).time);
    stops[f] = acc;
  }
  for (const k of net.transferStops) stops[k] = existing[net.stops[k]!.existing!]!;
  return { existing, stops };
}

export interface LineFlows {
  /** 新線の駅間 OD [人/日]（od[b * nStops + a]: b で乗って a で降りる） */
  readonly od: Float64Array;
  /** 駅別の乗降人員のうち、駅勢圏の利用者 / 乗換客 */
  readonly fromCatchment: Float64Array;
  readonly fromTransfer: Float64Array;
  /** fromTransfer のうち、両端とも既存線方面の流動（既存線から新線経由への経路転換）の分 */
  readonly fromThrough: Float64Array;
  readonly tripsByType: { local: number; toExisting: number; through: number };
}

/**
 * @param muExisting 新線ありの既存駅の乗降（駅勢圏由来）
 * @param muStops 新駅の乗降（接続駅は使わない）
 */
export function distributeFlows(
  ctx: DemandContext,
  net: NewNetwork,
  stopMass: Float64Array,
  acc: Accessibility,
  muExisting: Float64Array,
  muStops: Float64Array,
): LineFlows {
  const st = ctx.stations;
  const gamma = ctx.params.fitted.timeDecayPerMin;
  const lambda = ctx.params.shortcut.routeLogitPerMin;
  const n = st.n;
  const ns = net.stops.length;
  const nt = net.transferStops.length;
  const od = new Float64Array(ns * ns);
  const fromCatchment = new Float64Array(ns);
  const fromTransfer = new Float64Array(ns);
  const fromThrough = new Float64Array(ns);
  const trips = { local: 0, toExisting: 0, through: 0 };

  const add = (b: number, a: number, flow: number, bLocal: boolean, aLocal: boolean) => {
    if (b === a || !(flow > 0)) return;
    od[b * ns + a]! += flow / 2;
    od[a * ns + b]! += flow / 2;
    (bLocal ? fromCatchment : fromTransfer)[b]! += flow;
    (aLocal ? fromCatchment : fromTransfer)[a]! += flow;
    if (bLocal && aLocal) trips.local += flow;
    else if (bLocal || aLocal) trips.toExisting += flow;
    else {
      trips.through += flow;
      fromThrough[b]! += flow;
      fromThrough[a]! += flow;
    }
  };

  const outTime = new Float64Array(nt);
  const outFrom = new Int32Array(nt);

  // 既存駅を発地とする流動
  for (let o = 0; o < n; o++) {
    if (net.minBoard[o] === Infinity || !(acc.existing[o]! > 0)) continue;
    const prod = muExisting[o]! / 2 / acc.existing[o]!;
    if (nt >= 2) {
      net.outbound(o, outTime, outFrom);
      for (let d = 0; d < n; d++) {
        if (d === o) continue;
        const told = ctx.times.get(o, d);
        let via = Infinity;
        let li = -1;
        for (let l = 0; l < nt; l++) {
          const t = outTime[l]! + net.board[l]![d]!;
          if (t < via) {
            via = t;
            li = l;
          }
        }
        if (via === Infinity || via > told + ROUTE_SLACK_MIN) continue;
        const share = told === Infinity ? 1 : 1 / (1 + Math.exp(lambda * (via - told)));
        const flow = prod * st.mass[d]! * Math.exp(-gamma * Math.min(via, told)) * share;
        const kStop = net.transferStops[outFrom[li]!]!;
        const lStop = net.transferStops[li]!;
        add(kStop, lStop, flow, net.stops[kStop]!.existing === o, net.stops[lStop]!.existing === d);
      }
    }
    for (const f of net.freshStops) {
      const { time, via } = net.toFresh(o, f);
      if (time === Infinity) continue;
      const kStop = net.transferStops[via]!;
      add(kStop, f, prod * stopMass[f]! * Math.exp(-gamma * time), net.stops[kStop]!.existing === o, true);
    }
  }

  // 新駅を発地とする流動
  for (const f of net.freshStops) {
    if (!(acc.stops[f]! > 0)) continue;
    const prod = muStops[f]! / 2 / acc.stops[f]!;
    for (const g of net.freshStops) {
      if (g !== f) add(f, g, prod * stopMass[g]! * Math.exp(-gamma * net.freshToFresh(f, g)), true, true);
    }
    if (nt === 0) continue;
    for (let d = 0; d < n; d++) {
      const { time, via } = net.toFresh(d, f);
      if (time === Infinity) continue;
      const kStop = net.transferStops[via]!;
      add(f, kStop, prod * st.mass[d]! * Math.exp(-gamma * time), true, net.stops[kStop]!.existing === d);
    }
  }
  return { od, fromCatchment, fromTransfer, fromThrough, tripsByType: trips };
}
