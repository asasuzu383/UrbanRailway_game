import type { LngLat, UserLine } from '../core/types';
import { computeLineGeometry } from '../network/lineGeometry';
import type { DemandContext } from './context';

/** 需要推計で使う新線の駅（停車駅）。Phase 1 は全駅停車 */
export interface LineStop {
  readonly vertexId: string;
  readonly name: string;
  readonly position: LngLat;
  /** 起点からのキロ程 [km] */
  readonly chainageKm: number;
  /** 接続駅なら既存駅の添字（DemandContext.stations） */
  readonly existing: number | null;
}

export function lineStopsOf(line: UserLine, ctx: DemandContext): LineStop[] {
  const geo = computeLineGeometry(line);
  return geo.stations.map((s, i) => ({
    vertexId: s.id,
    name: s.name,
    position: s.position,
    chainageKm: geo.chainageKm[i] ?? 0,
    existing: s.transferTo !== null ? (ctx.stations.byId.get(s.transferTo) ?? null) : null,
  }));
}
