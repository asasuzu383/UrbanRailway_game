/**
 * 配分（docs/design.md §4.6）: Phase 1 の新線は 1 本の線で経路が一意なので、
 * 駅間 OD を区間に積み上げて方向別の断面輸送量を求める。
 */
import type { SegmentLoad } from '../core/types';
import type { LineStop } from './lineStops';

export interface Assignment {
  readonly segments: SegmentLoad[];
  readonly dailyPassengers: number;
  readonly dailyPassengerKm: number;
}

export function assignToLine(stops: readonly LineStop[], od: Float64Array): Assignment {
  const ns = stops.length;
  // 区間 i（駅 i → i+1）の断面輸送量を差分配列で積み上げる
  const fwd = new Float64Array(ns + 1);
  const bwd = new Float64Array(ns + 1);
  let total = 0;
  let pkm = 0;
  for (let b = 0; b < ns; b++) {
    for (let a = 0; a < ns; a++) {
      const v = od[b * ns + a]!;
      if (b === a || v <= 0) continue;
      total += v;
      pkm += v * Math.abs(stops[a]!.chainageKm - stops[b]!.chainageKm);
      if (b < a) {
        fwd[b]! += v;
        fwd[a]! -= v;
      } else {
        bwd[a]! += v;
        bwd[b]! -= v;
      }
    }
  }
  const segments: SegmentLoad[] = [];
  let f = 0;
  let w = 0;
  for (let i = 0; i + 1 < ns; i++) {
    f += fwd[i]!;
    w += bwd[i]!;
    segments.push({
      fromStationId: stops[i]!.vertexId,
      toStationId: stops[i + 1]!.vertexId,
      lengthKm: stops[i + 1]!.chainageKm - stops[i]!.chainageKm,
      forward: f,
      backward: w,
    });
  }
  return { segments, dailyPassengers: total, dailyPassengerKm: pkm };
}
