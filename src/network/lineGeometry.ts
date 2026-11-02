import { polylineLengthKm } from '../core/geo';
import type { LngLat, StationVertex, StructureType, UserLine } from '../core/types';

export interface LineSegmentGeometry {
  readonly fromStationId: string;
  readonly toStationId: string;
  /** 駅→中間点…→駅 の座標列 */
  readonly coordinates: readonly LngLat[];
  readonly lengthKm: number;
  readonly structure: StructureType;
}

export interface LineGeometry {
  readonly stations: readonly StationVertex[];
  readonly segments: readonly LineSegmentGeometry[];
  readonly totalKm: number;
  readonly kmByStructure: Readonly<Record<StructureType, number>>;
  /** 区間の起点駅から数えた各駅のキロ程 [km]（stations と同じ順） */
  readonly chainageKm: readonly number[];
}

/**
 * 路線の幾何（駅間の座標列・延長・構造別延長）を求める。
 * 先頭駅より前・最終駅より後の中間点（未完成部分）は含めない。
 */
export function computeLineGeometry(line: UserLine): LineGeometry {
  const structureOf = new Map(line.segments.map((s) => [s.fromStationId, s.structure]));
  const stations: StationVertex[] = [];
  const segments: LineSegmentGeometry[] = [];
  let current: LngLat[] = [];
  let from: StationVertex | null = null;

  for (const v of line.vertices) {
    if (v.kind === 'shape') {
      if (from) current.push(v.position);
      continue;
    }
    if (from) {
      current.push(v.position);
      segments.push({
        fromStationId: from.id,
        toStationId: v.id,
        coordinates: current,
        lengthKm: polylineLengthKm(current),
        structure: structureOf.get(from.id) ?? 'atGrade',
      });
    }
    stations.push(v);
    from = v;
    current = [v.position];
  }

  const kmByStructure: Record<StructureType, number> = { street: 0, atGrade: 0, elevated: 0, underground: 0 };
  const chainageKm = [0];
  let total = 0;
  for (const s of segments) {
    kmByStructure[s.structure] += s.lengthKm;
    total += s.lengthKm;
    chainageKm.push(total);
  }
  return { stations, segments, totalKm: total, kmByStructure, chainageKm: stations.length ? chainageKm : [] };
}
