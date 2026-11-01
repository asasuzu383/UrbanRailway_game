/**
 * 需要推計エンジン（Phase 1）。四段階推定の各段を順に呼ぶ:
 *   1. 駅勢圏（Huff）と集中量 … catchment.ts
 *   2. アクセシビリティ … distribution.ts computeAccessibility
 *   3. 発生・集中（駅別トリップ端） … generation（本ファイル）
 *   4. 分布・経路選択 … distribution.ts distributeFlows
 *   5. 配分 … assignment.ts
 */
import type { DemandResult, StationDemand, UserLine } from '../core/types';
import { assignToLine } from './assignment';
import { buildZoneLinks, computeCatchment, stopMasses } from './catchment';
import type { DemandContext } from './context';
import { computeAccessibility, distributeFlows } from './distribution';
import { lineStopsOf, type LineStop } from './lineStops';
import { NewNetwork } from './newNetwork';

export const EMPTY_DEMAND: DemandResult = {
  stations: [],
  segments: [],
  od: new Map(),
  dailyPassengers: 0,
  dailyPassengerKm: 0,
  tripsByType: { local: 0, toExisting: 0, through: 0 },
  newRailUsersPopulation: 0,
};

/** 駅勢圏由来の乗降 μ = exp(c₀) · X^η · (ACC/ref)^θ（新線の推計では路線数の項は使わない） */
export function tripEnds(ctx: DemandContext, catchment: number, acc: number): number {
  const fp = ctx.params.fitted;
  if (!(catchment > 0) || !(acc > 0)) return 0;
  return Math.exp(fp.intercept + fp.catchmentElasticity * Math.log(catchment) + fp.accessibilityElasticity * Math.log(acc / ctx.params.accRef));
}

export function runDemand(line: UserLine, ctx: DemandContext): DemandResult {
  const stops = lineStopsOf(line, ctx);
  if (stops.length < 2) return EMPTY_DEMAND;
  return runDemandForStops(stops, ctx);
}

export function runDemandForStops(stops: readonly LineStop[], ctx: DemandContext): DemandResult {
  const fp = ctx.params.fitted;
  const st = ctx.stations;

  // 1. 駅勢圏と集中量
  const links = buildZoneLinks(ctx, stops);
  const mass = stopMasses(ctx, stops, links);

  // 2. アクセシビリティ（新線あり）
  const net = new NewNetwork(ctx, stops);
  const acc = computeAccessibility(ctx, net, mass);
  const catchment = computeCatchment(ctx, links, acc.existing, acc.stops);

  // 3. 発生・集中: 既存駅は校正時の推計値を駅勢圏と ACC の変化率で補正、新駅はモデル式
  const muExisting = Float64Array.from(st.muCatch);
  for (let i = 0; i < st.n; i++) {
    const catchRatio = st.catch[i]! > 0 ? catchment.existingCatch[i]! / st.catch[i]! : 1;
    const accRatio = st.accOld[i]! > 0 ? acc.existing[i]! / st.accOld[i]! : 1;
    if (catchRatio !== 1 || accRatio !== 1) {
      muExisting[i] = st.muCatch[i]! * Math.pow(catchRatio, fp.catchmentElasticity) * Math.pow(accRatio, fp.accessibilityElasticity);
    }
  }
  const muStops = new Float64Array(stops.length);
  for (const f of net.freshStops) muStops[f] = tripEnds(ctx, catchment.stopCatch[f]!, acc.stops[f]!);

  // 4. 分布・経路選択 → 5. 配分
  const flows = distributeFlows(ctx, net, mass, acc, muExisting, muStops);
  const assigned = assignToLine(stops, flows.od);

  const stations: StationDemand[] = stops.map((s, k) => ({
    stationId: s.vertexId,
    ridership: flows.fromCatchment[k]! + flows.fromTransfer[k]!,
    fromCatchment: flows.fromCatchment[k]!,
    fromTransfer: flows.fromTransfer[k]!,
    catchmentPopulation: s.existing === null ? catchment.stopCatchPop[k]! : null,
    catchmentEmployees: s.existing === null ? catchment.stopCatchEmp[k]! : null,
  }));

  const od = new Map<string, Map<string, number>>();
  stops.forEach((b, i) => {
    const row = new Map<string, number>();
    stops.forEach((a, j) => {
      const v = flows.od[i * stops.length + j]!;
      if (v > 0) row.set(a.vertexId, v);
    });
    od.set(b.vertexId, row);
  });

  return {
    stations,
    segments: assigned.segments,
    od,
    dailyPassengers: assigned.dailyPassengers,
    dailyPassengerKm: assigned.dailyPassengerKm,
    tripsByType: flows.tripsByType,
    newRailUsersPopulation: catchment.newRailUsersPopulation,
  };
}
