import { distanceKm } from '../core/geo';
import type { LngLat } from '../core/types';

export interface SnapCandidate {
  readonly id: string;
  readonly name: string;
  readonly position: LngLat;
}

export interface SnapResult extends SnapCandidate {
  readonly distanceM: number;
}

/** 半径 radiusM 以内で最も近い既存駅を返す（なければ null）。 */
export function findSnapTarget(
  point: LngLat,
  candidates: readonly SnapCandidate[],
  radiusM: number,
): SnapResult | null {
  // 緯度 1度 ≒ 111km。粗い矩形で候補を絞ってから正確な距離を測る
  const dLat = radiusM / 111_000;
  const dLng = dLat / Math.cos((point[1] * Math.PI) / 180);
  let best: SnapResult | null = null;
  for (const c of candidates) {
    if (Math.abs(c.position[1] - point[1]) > dLat || Math.abs(c.position[0] - point[0]) > dLng) continue;
    const d = distanceKm(point, c.position) * 1000;
    if (d <= radiusM && (!best || d < best.distanceM)) best = { ...c, distanceM: d };
  }
  return best;
}
