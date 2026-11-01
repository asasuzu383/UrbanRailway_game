/**
 * 発生・集中の前段: 駅勢圏（docs/design.md §4.2）。
 * - 新駅の集中量 M（魅力度を使わない幾何的按分）
 * - 外部選択肢付き Huff による駅勢圏 X（人口＋ρ×従業者）と、鉄道利用確率の増分
 */
import { distanceKm } from '../core/geo';
import type { DemandContext } from './context';
import type { LineStop } from './lineStops';

interface Link {
  readonly idx: number;
  readonly f: number;
}

/** 新線・接続駅の周辺ゾーンについて、近くの既存駅・新駅とアクセス抵抗 f = exp(−β d) を列挙したもの */
export interface ZoneLinks {
  readonly zone: number;
  readonly existing: readonly Link[];
  /** 新駅（LineStop の添字。接続駅は既存駅側に含まれるので入らない） */
  readonly fresh: readonly Link[];
}

export function buildZoneLinks(ctx: DemandContext, stops: readonly LineStop[]): ZoneLinks[] {
  const { access } = ctx.params;
  const beta = ctx.params.fitted.accessDecayPerKm;
  const radiusKm = access.maxAccessKm / access.detourFactor;
  const z = ctx.zones;
  const st = ctx.stations;

  const zoneSet = new Set<number>();
  for (const s of stops) {
    for (const i of z.index.near(s.position[0], s.position[1], radiusKm)) {
      if (distanceKm(s.position, [z.lng[i]!, z.lat[i]!]) <= radiusKm) zoneSet.add(i);
    }
  }

  const links: ZoneLinks[] = [];
  for (const zi of zoneSet) {
    const zp: [number, number] = [z.lng[zi]!, z.lat[zi]!];
    const existing: Link[] = [];
    for (const si of st.index.near(zp[0], zp[1], radiusKm)) {
      const d = distanceKm(zp, [st.lng[si]!, st.lat[si]!]) * access.detourFactor;
      if (d <= access.maxAccessKm) existing.push({ idx: si, f: Math.exp(-beta * d) });
    }
    const fresh: Link[] = [];
    stops.forEach((s, k) => {
      if (s.existing !== null) return;
      const d = distanceKm(zp, s.position) * access.detourFactor;
      if (d <= access.maxAccessKm) fresh.push({ idx: k, f: Math.exp(-beta * d) });
    });
    links.push({ zone: zi, existing, fresh });
  }
  return links;
}

/**
 * 新駅の集中量 M。周辺ゾーンの（従業者 + ψ×人口）を、既存駅・新駅へ距離減衰だけで按分する。
 * 接続駅は既存駅の値を使う（新駅に取られる分の減少は無視する）。
 */
export function stopMasses(ctx: DemandContext, stops: readonly LineStop[], links: readonly ZoneLinks[]): Float64Array {
  const psi = ctx.params.mass.populationWeight;
  const mass = new Float64Array(stops.length);
  stops.forEach((s, k) => {
    if (s.existing !== null) mass[k] = ctx.stations.mass[s.existing]!;
  });
  for (const l of links) {
    if (l.fresh.length === 0) continue;
    let denom = 0;
    for (const e of l.existing) denom += e.f;
    for (const n of l.fresh) denom += n.f;
    const w = ctx.zones.emp[l.zone]! + psi * ctx.zones.pop[l.zone]!;
    for (const n of l.fresh) mass[n.idx]! += (w * n.f) / denom;
  }
  return mass;
}

export interface CatchmentResult {
  /** 新駅の駅勢圏 X（接続駅は 0。既存駅側の catchNew を使う） */
  readonly stopCatch: Float64Array;
  readonly stopCatchPop: Float64Array;
  readonly stopCatchEmp: Float64Array;
  /** 既存駅の駅勢圏 X（新線あり）。影響のない駅は校正時の値のまま */
  readonly existingCatch: Float64Array;
  /** 鉄道利用確率の増分 × 人口 の合計 */
  readonly newRailUsersPopulation: number;
}

/**
 * Huff による駅勢圏。新線ありの魅力度は ACC の変化率で校正時の値を補正する:
 *   A_old = (ACC_cal/ref)^α、A_new = A_old × (ACC_new/ACC_old)^α、新駅 A = (ACC/ref)^α
 * 校正時の駅勢圏 catch に「周辺ゾーンでの新旧の差」を足して新線ありの値とする。
 */
export function computeCatchment(
  ctx: DemandContext,
  links: readonly ZoneLinks[],
  accNewExisting: Float64Array,
  stopAcc: Float64Array,
): CatchmentResult {
  const fp = ctx.params.fitted;
  const st = ctx.stations;
  const alpha = fp.attractivenessExponent;
  const ref = ctx.params.accRef;
  const nStops = stopAcc.length;
  const stopCatch = new Float64Array(nStops);
  const stopCatchPop = new Float64Array(nStops);
  const stopCatchEmp = new Float64Array(nStops);
  const existingCatch = Float64Array.from(st.catch);
  let newRail = 0;

  const aOld = (i: number) => Math.pow(Math.max(st.accCalibrated[i]!, 1) / ref, alpha);
  const aNew = (i: number) => aOld(i) * Math.pow(Math.max(accNewExisting[i]!, 1) / Math.max(st.accOld[i]!, 1), alpha);
  const aStop = (k: number) => Math.pow(Math.max(stopAcc[k]!, 1) / ref, alpha);

  for (const l of links) {
    const v0 = ctx.zones.outside[l.zone]!;
    const pop = ctx.zones.pop[l.zone]!;
    const emp = ctx.zones.emp[l.zone]!;
    const w = pop + fp.employeeWeight * emp;
    let denOld = v0;
    let denNew = v0;
    const oldW = l.existing.map((e) => aOld(e.idx) * e.f);
    const newW = l.existing.map((e) => aNew(e.idx) * e.f);
    const freshW = l.fresh.map((n) => aStop(n.idx) * n.f);
    for (const x of oldW) denOld += x;
    for (const x of newW) denNew += x;
    for (const x of freshW) denNew += x;

    l.existing.forEach((e, j) => {
      existingCatch[e.idx]! += w * (newW[j]! / denNew - oldW[j]! / denOld);
    });
    l.fresh.forEach((n, j) => {
      const pi = freshW[j]! / denNew;
      stopCatch[n.idx]! += w * pi;
      stopCatchPop[n.idx]! += pop * pi;
      stopCatchEmp[n.idx]! += emp * pi;
    });
    // 鉄道利用確率 Σπ = 1 − v0/den の増分
    newRail += pop * (v0 / denOld - v0 / denNew);
  }
  for (let i = 0; i < existingCatch.length; i++) existingCatch[i] = Math.max(existingCatch[i]!, 0);
  return { stopCatch, stopCatchPop, stopCatchEmp, existingCatch, newRailUsersPopulation: newRail };
}
